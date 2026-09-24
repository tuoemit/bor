// WebSocket bridge between the panel and Chromium.
//
// Auth reuses the panel's session cookie: the WS handshake is a normal HTTP
// request to the same origin, so the signed cookie rides along and we verify
// it the same way the REST API does. No tokens in URLs.
//
// Protocol (JSON messages)
//   client -> server
//     {t:'open',    tabId, url}            create/reuse a page for a tab
//     {t:'focus',   tabId}                 switch which tab is streaming
//     {t:'close',   tabId}
//     {t:'nav',     tabId, url}
//     {t:'back'|'forward'|'reload'|'stop', tabId}
//     {t:'mouse',   tabId, kind, x, y, button, clickCount, modifiers}
//     {t:'wheel',   tabId, x, y, dx, dy}
//     {t:'touch',   tabId, kind:'tap', x, y}
//     {t:'key',     tabId, kind:'type'|'press'|'down'|'up', key, text, modifiers}
//     {t:'viewport',tabId, width, height, mobile}
//     {t:'zoom',    tabId, level}
//     {t:'find',    tabId, query, step}
//     {t:'screenshot', tabId, fullPage}
//   server -> client
//     {t:'hello'|'frame'|'nav'|'title'|'loading'|'viewport'|'find'|'error'
//      |'evicted'|'download'|'page-error'|'closed'}
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { log } from '../log.js';
import { normalizeInput } from '../web/api.js';
import { resolveTarget } from '../util/net.js';
import { status as engineStatus, stop as stopEngine, touchViewer } from './browser.js';
import { getDownload, hub } from './session.js';

const MAX_MESSAGE_BYTES = 256 * 1024;

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function attachChromiumSocket(server, { authenticate }) {
  // noServer: auth must happen *before* the upgrade, not after it. Upgrading
  // first and then closing with 4401 technically works, but it means an
  // unauthenticated request gets a 101 and only then a close frame — which
  // any reverse proxy in front of us (and every pentest) reads as "accepted".
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      /* fall through to the 400 below */
    }
    if (pathname !== '/ws/viewer') return; // another listener's problem

    Promise.resolve(authenticate(req))
      .then((session) => {
        if (!session) {
          log.warn('[chromium] rejected unauthenticated viewer socket');
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Content-Type: text/plain\r\n' +
              'Content-Length: 13\r\n' +
              'Connection: close\r\n\r\nUnauthorized\n',
          );
          socket.destroy();
          return;
        }
        if (!engineStatus().available) {
          const body = 'Engine unavailable in this container';
          socket.write(
            `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      })
      .catch((err) => {
        log.warn(`[chromium] upgrade check failed: ${err.message}`);
        socket.destroy();
      });
  });

  wss.on('connection', async (socket) => {
    // Already authenticated and engine-checked during the upgrade handshake.
    log.info('[chromium] viewer connected');
    hub.setViewer(socket);
    touchViewer();
    send(socket, { t: 'hello', status: engineStatus(), maxTabs: config.chromium.maxTabs });

    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      if (hub.getViewer() === socket) {
        hub.setViewer(null);
        // Leaving the panel shouldn't leave Chromium burning CPU: stop all
        // streams but keep the pages so the tabs are still there on return.
        for (const session of hub.sessions.values()) await session.stopStream();
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { t: 'error', message: 'Malformed message' });
      }
      if (!msg || typeof msg.t !== 'string') return;
      touchViewer();

      const tabId = String(msg.tabId ?? '');
      try {
        await handle(socket, msg, tabId);
      } catch (err) {
        log.error(`[chromium] handler ${msg.t} failed: ${err.message}`);
        send(socket, { t: 'error', tabId, message: err.message });
      }
      return undefined;
    });
  });

  async function handle(socket, msg, tabId) {
    switch (msg.t) {
      case 'open': {
        const url = await safeUrl(msg.url);
        const session = await hub.open(tabId, url);
        wireSession(socket, session);
        await hub.activate(tabId, url);
        send(socket, { t: 'opened', tabId, url: session.url(), status: engineStatus() });
        return;
      }

      case 'focus': {
        const session = hub.get(tabId);
        if (!session) return send(socket, { t: 'error', tabId, message: 'No browser session for that tab' });
        wireSession(socket, session);
        await hub.activate(tabId);
        send(socket, { t: 'focused', tabId, url: session.url() });
        return;
      }

      case 'close': {
        await hub.close(tabId);
        return;
      }

      case 'nav': {
        const session = hub.get(tabId);
        if (!session) return send(socket, { t: 'error', tabId, message: 'No browser session for that tab' });
        const url = await safeUrl(msg.url);
        if (!url) return send(socket, { t: 'error', tabId, message: 'That address could not be resolved.' });
        await session.navigate(url);
        return;
      }

      case 'back':
        return (await hub.get(tabId))?.back();
      case 'forward':
        return (await hub.get(tabId))?.forward();
      case 'reload':
        return (await hub.get(tabId))?.reload();
      case 'stop':
        return (await hub.get(tabId))?.stopLoading();

      case 'mouse':
        return (await hub.get(tabId))?.mouse(msg);
      case 'wheel':
        return (await hub.get(tabId))?.wheel(msg);
      case 'touch':
        return (await hub.get(tabId))?.touch(msg);
      case 'key':
        return (await hub.get(tabId))?.key(msg);

      case 'viewport': {
        const session = hub.get(tabId);
        if (!session) return;
        await session.setViewport(msg.width, msg.height, msg.mobile);
        // The capture size changed, so restart the screencast at the new size.
        await session.stopStream();
        await session.startStream();
        return;
      }

      case 'zoom':
        return (await hub.get(tabId))?.zoom(msg.level);

      case 'find': {
        const session = hub.get(tabId);
        if (!session) return;
        const result = await session.find(msg.query, msg.step ?? 0);
        return send(socket, { t: 'find', tabId, ...result });
      }

      case 'screenshot': {
        const session = hub.get(tabId);
        if (!session) return;
        const buffer = await session.screenshot({ fullPage: Boolean(msg.fullPage) });
        return send(socket, { t: 'screenshot', tabId, data: buffer.toString('base64') });
      }

      case 'evaluate': {
        const session = hub.get(tabId);
        if (!session) return;
        const result = await session.evaluate(String(msg.expression ?? '').slice(0, 2000));
        return send(socket, { t: 'evaluated', tabId, result });
      }

      case 'shutdown': {
        await hub.closeAll();
        await stopEngine();
        return send(socket, { t: 'hello', status: engineStatus() });
      }

      default:
        log.debug(`[chromium] unknown message type: ${msg.t}`);
    }
  }

  function wireSession(socket, session) {
    // Frames: dropped when the socket is backed up rather than queued, so a
    // slow client degrades to fewer fps instead of unbounded latency.
    session.setFrameHandler(({ tabId, data, bytes }) => {
      const viewer = hub.getViewer();
      if (!viewer) return false;
      if (viewer.bufferedAmount > config.chromium.maxSocketBacklog) return false;
      const ok = send(viewer, { t: 'frame', tabId, data, bytes });
      return ok;
    });

    session.setEventHandler((event) => {
      // Route session events to the current viewer.
      return send(hub.getViewer(), event);
    });
    void socket;
  }

  return wss;
}

/**
 * Normalise whatever the client sent into a fetchable URL, and apply the same
 * SSRF rules as the proxy so the browser can't be used to reach the private
 * network. (Chromium could reach Railway's private network; we don't want it.)
 */
async function safeUrl(raw) {
  const target = normalizeInput(raw);
  if (!target) return null;
  try {
    await resolveTarget(target);
  } catch (err) {
    log.warn(`[chromium] blocked navigation: ${err.message}`);
    return null;
  }
  return target;
}

export { getDownload };
void crypto;
