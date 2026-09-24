// Per-tab browser sessions.
//
// Each panel tab maps to one Chromium page. Only the *active* tab streams
// frames; switching tabs stops the old screencast, because three tabs each
// painting at 30 fps would melt a shared vCPU.
//
// Input arrives from the client as normalised coordinates (0..1) so the panel
// can letterbox or scale the canvas however it likes without the server
// needing to know anything about the client's layout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { bookmarkAdd, historyAdd } from '../store.js';
import {
  getContext,
  markStateDirty,
  notePageClosed,
  notePageOpen,
  saveStorageState,
  start,
} from './browser.js';

const { chromium: cfg } = config;

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };

// A current Android Chrome UA. Sites key their mobile layout off this as much
// as off the viewport width.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/153.0.0.0 Mobile Safari/537.36';

/* -------------------------------------------------------------- downloads */
const downloadDir = path.join('/tmp', 'bp-downloads');
const downloads = new Map(); // id -> { path, name, size, at }

function trackDownload(download) {
  const id = crypto.randomBytes(6).toString('base64url');
  const suggested = download.suggestedFilename().replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'download';
  const target = path.join(downloadDir, `${id}-${suggested}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  download
    .saveAs(target)
    .then(() => {
      const stat = fs.statSync(target);
      downloads.set(id, { path: target, name: suggested, size: stat.size, at: Date.now() });
      // Keep the map from growing without bound; files on disk are pruned below.
      while (downloads.size > 20) downloads.delete(downloads.keys().next().value);
      log.info(`[chromium] download saved: ${suggested} (${(stat.size / 1024).toFixed(0)} KB)`);
    })
    .catch((err) => log.warn(`[chromium] download failed: ${err.message}`));

  return { id, name: suggested };
}

export function getDownload(id) {
  const hit = downloads.get(id);
  if (!hit) return null;
  if (!fs.existsSync(hit.path)) {
    downloads.delete(id);
    return null;
  }
  return hit;
}

/* ------------------------------------------------------------------ keys */
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Space',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function comboFor(modifiers = [], key = '') {
  const parts = [];
  if (modifiers.includes('ctrl')) parts.push('Control');
  if (modifiers.includes('alt')) parts.push('Alt');
  if (modifiers.includes('shift')) parts.push('Shift');
  if (modifiers.includes('meta')) parts.push('Meta');
  const name = key === ' ' ? 'Space' : key;
  parts.push(name);
  return parts.join('+');
}

/* ------------------------------------------------------------- tab session */
let sessionCounter = 0;

export class TabSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.id = `s${++sessionCounter}`;
    this.page = null;
    this.cdp = null;
    this.viewport = { ...cfg.viewport };
    this.mobile = false;
    this.streaming = false;
    this.onFrame = null;
    this.onEvent = null;
    this.lastUsedAt = Date.now();
    this.frames = 0;
    this.droppedFrames = 0;
    this.ignoreUrl = null; // set while we drive navigation ourselves
    this.titleTimer = null;
  }

  /* ---- lifecycle ---- */
  async ensure(url) {
    if (this.page && !this.page.isClosed()) {
      if (url) await this.navigate(url);
      return this.page;
    }

    await start();
    const context = getContext();
    if (!context) throw new Error('Chromium context is not available');

    const page = await context.newPage();
    this.page = page;
    notePageOpen();

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      markStateDirty();
      if (frame.url() === this.ignoreUrl) return;
      this.emit({ t: 'nav', url: frame.url() });
      this.refreshTitle();
    });
    page.on('load', () => {
      this.emit({ t: 'loading', loading: false });
      this.refreshTitle();
    });
    page.on('download', (download) => {
      const info = trackDownload(download);
      this.emit({ t: 'download', id: info.id, name: info.name });
    });
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('pageerror', (err) => this.emit({ t: 'page-error', message: String(err.message).slice(0, 200) }));

    await this.applyViewport();

    if (url) {
      await this.navigate(url);
    } else {
      this.emit({ t: 'nav', url: 'about:blank' });
    }
    return page;
  }

  async applyViewport() {
    if (!this.page) return;
    const cdp = await this.cdpSession();

    // Device metrics are the single source of truth for both modes. Using
    // Playwright's setViewportSize *and* CDP overrides at once makes the two
    // fight, which is how a "390px phone" ended up measuring 1120px wide.
    if (this.mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 3,
        mobile: true,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      // A mobile UA is required or sites serve the desktop layout regardless
      // of how narrow the viewport is.
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: MOBILE_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Android',
      });
    } else {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: config.userAgent,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Win32',
      });
    }
  }

  async setViewport(width, height, mobile = this.mobile) {
    const modeChanged = Boolean(mobile) !== this.mobile;
    this.mobile = Boolean(mobile);
    const mobilePresets = { phone: { width: 390, height: 844 }, tablet: { width: 834, height: 1112 } };
    if (this.mobile && mobilePresets[width]) {
      this.viewport = mobilePresets[width];
    } else {
      this.viewport = {
        width: Math.max(320, Math.min(4096, width | 0)),
        height: Math.max(240, Math.min(4096, height | 0)),
      };
    }
    await this.applyViewport();
    // A loaded page caches its layout viewport; reload so the site actually
    // serves and lays out the mobile experience.
    if (modeChanged && this.page && !this.page.isClosed()) {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
    }
    this.emit({ t: 'viewport', width: this.viewport.width, height: this.viewport.height, mobile: this.mobile });
  }

  async cdpSession() {
    if (this.cdp) return this.cdp;
    const context = getContext();
    this.cdp = await context.newCDPSession(this.page);

    // The screencast is event-driven: Chromium pushes a JPEG whenever the page
    // repaints. Every frame must be ACKed or the stream stalls after one frame
    // -- this listener is the heart of the live view.
    this.cdp.on('Page.screencastFrame', (event) => {
      if (!event?.data) return;
      this.deliverFrame(event.data, Math.round((event.data.length * 3) / 4));
      this.cdp
        ?.send('Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(() => {});
    });

    // Surface renderer crashes instead of showing a frozen frame forever.
    this.cdp.on('Inspector.targetCrashed', () => this.emit({ t: 'error', message: 'The page crashed.' }));

    return this.cdp;
  }

  async close() {
    this.stopStream();
    if (this.titleTimer) clearInterval(this.titleTimer);
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch {
        /* already gone */
      }
      notePageClosed();
    }
    this.page = null;
    this.cdp = null;
  }

  /* ---- navigation ---- */
  async navigate(url) {
    await this.ensure();
    this.lastUsedAt = Date.now();
    this.emit({ t: 'loading', loading: true });
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      historyAdd('owner', this.url(), await this.safeTitle());
    } catch (err) {
      const message = /Timeout/i.test(err.message)
        ? 'The page took too long to load.'
        : `Navigation failed: ${err.message.split('\n')[0]}`;
      this.emit({ t: 'error', message });
    } finally {
      this.emit({ t: 'loading', loading: false });
      this.refreshTitle();
      markStateDirty();
    }
  }

  url() {
    try {
      return this.page && !this.page.isClosed() ? this.page.url() : 'about:blank';
    } catch {
      return 'about:blank';
    }
  }

  async safeTitle() {
    try {
      const t = await this.page.title();
      return t ? t.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  async refreshTitle() {
    const title = await this.safeTitle();
    this.emit({ t: 'title', title: title ?? this.url() });
  }

  async back() {
    if (!this.page) return;
    this.emit({ t: 'loading', loading: true });
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
    this.emit({ t: 'loading', loading: false });
    this.refreshTitle();
  }

  async forward() {
    if (!this.page) return;
    this.emit({ t: 'loading', loading: true });
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
    this.emit({ t: 'loading', loading: false });
    this.refreshTitle();
  }

  async reload() {
    if (!this.page) return;
    this.emit({ t: 'loading', loading: true });
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs }).catch(() => {});
    this.emit({ t: 'loading', loading: false });
  }

  async stopLoading() {
    if (!this.page) return;
    await this.page.evaluate(() => window.stop()).catch(() => {});
    this.emit({ t: 'loading', loading: false });
  }

  /* ---- screencast ---- */
  async startStream() {
    if (this.streaming || !this.page || this.page.isClosed()) return;
    const cdp = await this.cdpSession();
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: cfg.quality,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    });
    this.streaming = true;
    this.frames = 0;

    if (this.titleTimer) clearInterval(this.titleTimer);
    this.titleTimer = setInterval(() => this.refreshTitle(), 4000);
    this.titleTimer.unref?.();

    this.refreshTitle();
  }

  async stopStream() {
    if (this.titleTimer) clearInterval(this.titleTimer);
    this.titleTimer = null;
    if (!this.streaming) return;
    this.streaming = false;
    try {
      await this.cdp?.send('Page.stopScreencast');
    } catch {
      /* session may already be gone */
    }
  }

  /** Wired by the WS layer; keeps frame delivery off the session's hot path. */
  setFrameHandler(fn) {
    this.onFrame = fn;
  }

  setEventHandler(fn) {
    this.onEvent = fn;
  }

  emit(payload) {
    try {
      this.onEvent?.({ tabId: this.tabId, ...payload });
    } catch (err) {
      log.debug(`[chromium] event handler failed: ${err.message}`);
    }
  }

  /** Called from the CDP screencast handler with a base64 JPEG. */
  deliverFrame(data, byteLength) {
    this.frames += 1;
    this.lastUsedAt = Date.now();
    const sent = this.onFrame?.({ tabId: this.tabId, data, bytes: byteLength, url: this.url() });
    if (sent === false) this.droppedFrames += 1;
  }

  /* ---- input ---- */
  toPagePoint(normX, normY) {
    const x = Math.max(0, Math.min(1, Number(normX) || 0)) * this.viewport.width;
    const y = Math.max(0, Math.min(1, Number(normY) || 0)) * this.viewport.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  async mouse({ kind, x, y, button = 0, clickCount = 1, modifiers = [] }) {
    if (!this.page || this.page.isClosed()) return;
    const p = this.toPagePoint(x, y);
    this.lastUsedAt = Date.now();
    // Playwright's mouse keeps its own position, so moves must precede clicks.
    await this.page.mouse.move(p.x, p.y).catch(() => {});
    const name = BUTTONS[button] ?? 'left';

    if (kind === 'down') await this.page.mouse.down({ button: name }).catch(() => {});
    else if (kind === 'up') await this.page.mouse.up({ button: name }).catch(() => {});
    else if (kind === 'click') {
      await this.page.mouse.click(p.x, p.y, { button: name, clickCount }).catch(() => {});
    } else if (kind === 'dblclick') {
      await this.page.mouse.dblclick(p.x, p.y, { button: name }).catch(() => {});
    }
    void modifiers;
  }

  async wheel({ x, y, dx = 0, dy = 0 }) {
    if (!this.page || this.page.isClosed()) return;
    const p = this.toPagePoint(x, y);
    this.lastUsedAt = Date.now();
    await this.page.mouse.move(p.x, p.y).catch(() => {});
    await this.page.mouse.wheel(dx, dy).catch(() => {});
  }

  async touch({ kind, x, y }) {
    if (!this.page || this.page.isClosed()) return;
    const p = this.toPagePoint(x, y);
    this.lastUsedAt = Date.now();
    if (kind === 'tap') await this.page.touchscreen.tap(p.x, p.y).catch(() => {});
  }

  async key({ kind, key, text, modifiers = [] }) {
    if (!this.page || this.page.isClosed()) return;
    this.lastUsedAt = Date.now();
    try {
      if (kind === 'type' && typeof text === 'string') {
        await this.page.keyboard.insertText(text.slice(0, 2000));
        return;
      }
      if (kind === 'press') {
        if (NAMED_KEYS.has(key) || modifiers.length) {
          await this.page.keyboard.press(comboFor(modifiers, key), { delay: 10 });
        } else if (typeof key === 'string' && key.length === 1) {
          await this.page.keyboard.insertText(key);
        } else {
          await this.page.keyboard.press(comboFor(modifiers, key)).catch(() => {});
        }
        return;
      }
      if (kind === 'down') await this.page.keyboard.down(comboFor(modifiers, key)).catch(() => {});
      if (kind === 'up') await this.page.keyboard.up(comboFor(modifiers, key)).catch(() => {});
    } catch (err) {
      log.debug(`[chromium] key failed: ${err.message}`);
    }
  }

  /* ---- page commands ---- */
  async zoom(level) {
    if (!this.page) return;
    const cdp = await this.cdpSession();
    const value = Math.max(0.25, Math.min(3, Number(level) || 1));
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: value }).catch(() => {});
  }

  /** Find in page, evaluated inside the page (no CDP find API exists). */
  async find(query, step = 0) {
    if (!this.page || this.page.isClosed()) return { count: 0, index: -1 };
    try {
      return await this.page.evaluate(
        ({ q, dir }) => window.__bpFind ? window.__bpFind(q, dir) : { count: 0, index: -1 },
        { q: String(query ?? ''), dir: step },
      );
    } catch {
      return { count: 0, index: -1 };
    }
  }

  async evaluate(expression) {
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.evaluate(expression);
    } catch (err) {
      return { error: err.message };
    }
  }

  async screenshot({ fullPage = false } = {}) {
    if (!this.page || this.page.isClosed()) throw new Error('No page to capture');
    return this.page.screenshot({ fullPage, type: 'png' });
  }
}

/* ------------------------------------------------------------------ hub */
class SessionHub {
  constructor() {
    this.sessions = new Map(); // tabId -> TabSession
    this.viewer = null; // single viewer: this is one user's panel
  }

  setViewer(ws) {
    this.viewer = ws;
  }

  getViewer() {
    return this.viewer && this.viewer.readyState === 1 ? this.viewer : null;
  }

  /** Attach a session to the current viewer and start its stream. */
  async activate(tabId, url) {
    const session = this.sessions.get(tabId);
    if (!session) return null;

    // Only one tab streams at a time.
    for (const [id, other] of this.sessions) {
      if (id !== tabId) await other.stopStream();
    }
    await session.ensure(url);
    await session.startStream();
    session.emit({ t: 'viewport', width: session.viewport.width, height: session.viewport.height, mobile: session.mobile });
    return session;
  }

  async open(tabId, url) {
    if (this.sessions.has(tabId)) return this.sessions.get(tabId);
    if (this.sessions.size >= cfg.maxTabs) {
      // Evict the least recently used tab that isn't the one being opened.
      const victim = [...this.sessions.entries()]
        .filter(([id]) => id !== tabId)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (victim) {
        log.info(`[chromium] tab cap ${cfg.maxTabs} reached — suspending ${victim[0]}`);
        await this.close(victim[0], { evicted: true });
      }
    }
    const session = new TabSession(tabId);
    this.sessions.set(tabId, session);
    await session.ensure(url);
    return session;
  }

  get(tabId) {
    return this.sessions.get(tabId);
  }

  async close(tabId, { evicted = false } = {}) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    await session.close();
    if (evicted) {
      this.getViewer()?.send(JSON.stringify({ t: 'evicted', tabId }));
    }
    void saveStorageState();
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }

  async suspendIdle() {
    if (!cfg.tabSleepMs) return;
    const cutoff = Date.now() - cfg.tabSleepMs;
    for (const [id, session] of [...this.sessions]) {
      if (session.streaming) continue;
      if (session.lastUsedAt < cutoff) {
        log.info(`[chromium] suspending idle tab ${id}`);
        await this.close(id, { evicted: true });
      }
    }
  }
}

export const hub = new SessionHub();

setInterval(() => {
  hub.suspendIdle().catch(() => {});
  saveStorageState().catch(() => {});
}, 60_000).unref?.();
