'use strict';

/**
 * ScreencastHub -- streams the live Firefox viewport to the panel and pipes
 * mouse/keyboard input back into the page.
 *
 * Transport: one WebSocket per browser tab of the panel client.
 * Frames:    JPEG screenshots, taken back-to-back with a small interval, and
 *            only forwarded when the pixels actually changed (saves ~80% of the
 *            bandwidth on static pages). One screenshot is ever in flight per
 *            tab, so a slow render can never pile up.
 * Input:     mouse.move / mouse.down / mouse.up / mouse.click / key / type /
 *            scroll are translated into Playwright calls in CSS pixels.
 */

const { WebSocketServer } = require('ws');
const config = require('./config');
const { manager } = require('./browserManager');

const STATE_EVERY_MS = 400;
const HEARTBEAT_MS = 25_000;
const CHANGE_THRESHOLD = 6 * 1024; // bytes

function hash(buf) {
  let h = 0;
  const step = Math.max(1, Math.floor(buf.length / 4096));
  for (let i = 0; i < buf.length; i += step) {
    h = (h * 31 + buf[i]) | 0;
  }
  return h;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ScreencastHub {
  constructor() {
    this.loops = new Map(); // tabId -> loop state
    this.wss = null;
  }

  attach(server, { authenticate }) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      let authed = false;
      try {
        authed = authenticate(req);
      } catch {
        authed = false;
      }
      if (!authed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    this.heartbeat = setInterval(() => {
      for (const client of this.wss.clients) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onConnection(ws) {
    ws.isAlive = true;
    ws.subscribedTabId = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(ws, { type: 'error', code: 'bad_json', message: 'Invalid JSON frame.' });
      }
      this.handleMessage(ws, msg).catch((e) => {
        this.send(ws, { type: 'error', code: 'input_failed', message: String(e && e.message ? e.message : e) });
      });
    });
    ws.on('close', () => this.unsubscribe(ws));
    ws.on('error', () => this.unsubscribe(ws));
    this.send(ws, { type: 'hello', engine: config.engine, viewport: { width: config.viewportWidth, height: config.viewportHeight } });
  }

  send(ws, obj, binary) {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(obj));
      if (binary) ws.send(binary);
    } catch {
      /* ignore */
    }
  }

  async handleMessage(ws, msg) {
    switch (msg.type) {
      case 'ping':
        return this.send(ws, { type: 'pong', t: Date.now() });

      case 'subscribe': {
        const tab = manager.getTab(msg.tabId);
        this.unsubscribe(ws);
        ws.subscribedTabId = tab.id;
        tab.viewers.add(ws);
        this.ensureLoop(tab.id);
        this.send(ws, { type: 'subscribed', tab: tab.info() });
        // Immediate first frame so the panel is never blank.
        this.captureFrame(tab, /* force */ true);
        return undefined;
      }

      case 'unsubscribe':
        return this.unsubscribe(ws);

      case 'input':
        return this.applyInput(ws, msg);

      case 'refresh': {
        const tab = manager.getTab(ws.subscribedTabId || msg.tabId);
        return this.captureFrame(tab, true);
      }

      case 'state': {
        const tab = manager.getTab(ws.subscribedTabId || msg.tabId);
        await tab.refreshMeta();
        return this.send(ws, { type: 'state', tab: tab.info() });
      }

      case 'events': {
        const tab = manager.getTab(ws.subscribedTabId || msg.tabId);
        const since = Number(msg.since) || 0;
        return this.send(ws, {
          type: 'events',
          events: tab.events.filter((e) => e.at > since),
        });
      }

      default:
        return this.send(ws, { type: 'error', code: 'unknown_type', message: `Unknown message type "${msg.type}".` });
    }
  }

  unsubscribe(ws) {
    if (!ws.subscribedTabId) return;
    const tab = manager.tabs.get(ws.subscribedTabId);
    if (tab) tab.viewers.delete(ws);
    ws.subscribedTabId = null;
    if (tab && tab.viewers.size === 0) this.stopLoop(tab.id);
  }

  ensureLoop(tabId) {
    if (this.loops.has(tabId)) return;
    const state = { running: true, lastHash: null, lastStateAt: 0, pending: null };
    this.loops.set(tabId, state);
    (async () => {
      while (state.running) {
        const tab = manager.tabs.get(tabId);
        if (!tab || tab.closed || tab.viewers.size === 0) break;
        const t0 = Date.now();
        await this.captureFrame(tab, false);
        const spent = Date.now() - t0;
        await sleep(Math.max(10, config.frameIntervalMs - spent));
      }
      this.loops.delete(tabId);
    })().catch(() => this.loops.delete(tabId));
  }

  stopLoop(tabId) {
    const state = this.loops.get(tabId);
    if (state) state.running = false;
    this.loops.delete(tabId);
  }

  async captureFrame(tab, force) {
    const shot = await tab.screenshotNonBlocking(config.frameQuality);
    if (!shot) return;
    const h = hash(shot.buffer);
    const state = this.loops.get(tab.id);
    const changed = force || !state || state.lastHash === null || Math.abs(h - state.lastHash) > 0;
    if (state) state.lastHash = h;

    const sizeDelta = state && state.lastSize ? Math.abs(shot.buffer.length - state.lastSize) : Infinity;
    if (state) state.lastSize = shot.buffer.length;

    if (changed || sizeDelta > CHANGE_THRESHOLD || force) {
      const payload = JSON.stringify({
        type: 'frame',
        tabId: tab.id,
        seq: (tab._seq = (tab._seq || 0) + 1),
        width: shot.width,
        t: Date.now(),
      });
      for (const ws of tab.viewers) {
        if (ws.readyState === 1) {
          try {
            ws.send(payload);
            ws.send(shot.buffer, { binary: true });
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Throttled metadata refresh (URL/title/scroll) for the panel chrome.
    const nowMs = Date.now();
    if (nowMs - (state ? state.lastStateAt : 0) > STATE_EVERY_MS) {
      if (state) state.lastStateAt = nowMs;
      await tab.refreshMeta();
      const info = JSON.stringify({ type: 'state', tab: tab.info() });
      for (const ws of tab.viewers) {
        if (ws.readyState === 1) {
          try {
            ws.send(info);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /** Client coords arrive in screenshot space; convert to CSS pixels. */
  scale(x, y) {
    const dpr = config.deviceScaleFactor || 1;
    return { x: Number(x) / dpr, y: Number(y) / dpr };
  }

  async applyInput(ws, msg) {
    const tab = manager.getTab(ws.subscribedTabId);
    const ev = msg.event || {};
    const { x, y } = this.scale(ev.x || 0, ev.y || 0);

    switch (ev.type) {
      case 'mouse.move':
        await tab.moveAt(x, y);
        break;
      case 'mouse.down':
        await tab.page.mouse.move(x, y);
        await tab.page.mouse.down({ button: ev.button || 'left', clickCount: ev.clickCount || 1 });
        break;
      case 'mouse.up':
        await tab.page.mouse.up({ button: ev.button || 'left', clickCount: ev.clickCount || 1 });
        await tab.refreshMeta();
        break;
      case 'mouse.click':
        await tab.clickAt(x, y, { button: ev.button || 'left', clickCount: ev.clickCount || 1 });
        break;
      case 'scroll':
        await tab.scrollBy(ev.deltaX || 0, ev.deltaY || 0);
        break;
      case 'key.press':
        await tab.pressKey(String(ev.key));
        break;
      case 'key.type':
        await tab.typeText(String(ev.text ?? ''), { delay: Number(ev.delay) || 8 });
        break;
      case 'key.down':
        await tab.page.keyboard.down(String(ev.key));
        break;
      case 'key.up':
        await tab.page.keyboard.up(String(ev.key));
        break;
      default:
        this.send(ws, { type: 'error', code: 'unknown_input', message: `Unknown input "${ev.type}".` });
        return;
    }

    // Echo the fresh state right away so the URL bar reacts to a click instantly.
    this.send(ws, { type: 'state', tab: tab.info() });
    if (!this.loops.has(tab.id)) this.ensureLoop(tab.id);
    this.captureFrame(tab, true);
  }

  /** Broadcast to everyone watching a tab (used by the REST routes). */
  broadcast(tabId, obj) {
    const tab = manager.tabs.get(tabId);
    if (!tab) return;
    const data = JSON.stringify(obj);
    for (const ws of tab.viewers) {
      if (ws.readyState === 1) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  stats() {
    return {
      clients: this.wss ? this.wss.clients.size : 0,
      streamingTabs: [...this.loops.keys()],
    };
  }
}

module.exports = { hub: new ScreencastHub() };
