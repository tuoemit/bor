'use strict';

/**
 * BrowserManager -- owns the headless Firefox (Gecko) engine.
 *
 * Deliberately no Chromium anywhere: `firefox.launch()`, and the Docker image /
 * postinstall step only ever fetch the Firefox build.
 *
 * Model
 *  - one Browser process
 *  - one BrowserContext per *session* (a named profile: cookies + localStorage),
 *    so you can log into a site, save the profile, and come back to it later
 *  - up to MAX_TABS pages (tabs) inside the active context
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { firefox } = require('playwright');
const config = require('./config');

const MAX_SESSIONS = Number.parseInt(process.env.MAX_SESSIONS || '3', 10);

function now() {
  return Date.now();
}

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

class Tab {
  constructor(id, page, sessionId) {
    this.id = id;
    this.page = page;
    this.sessionId = sessionId;
    this.createdAt = now();
    this.lastUsedAt = now();
    this.lastInputAt = 0;
    this.loading = false;
    this.title = '';
    this.url = '';
    this.scroll = { x: 0, y: 0 };
    this.content = { width: 0, height: 0 };
    this.viewport = { width: config.viewportWidth, height: config.viewportHeight };
    this.events = [];
    this.downloads = [];
    this.closed = false;
    this.viewers = new Set();
    this._shotBusy = false;
    this._navToken = 0;

    page.setDefaultTimeout(Math.min(config.actionTimeoutMs, 10000));
    page.setDefaultNavigationTimeout(config.navTimeoutMs);

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.url = frame.url();
        this.title = frame.title();
      }
    });
    page.on('load', () => {
      this.loading = false;
      this.title = page.title().catch(() => this.title) && this.title;
    });
    page.on('console', (msg) => {
      this.pushEvent('console', {
        type: msg.type(),
        text: msg.text().slice(0, 2000),
        location: msg.location(),
      });
    });
    page.on('pageerror', (err) => {
      this.pushEvent('pageerror', { message: String(err && err.message ? err.message : err).slice(0, 2000) });
    });
    page.on('requestfailed', (req) => {
      this.pushEvent('requestfailed', {
        url: req.url().slice(0, 500),
        failure: req.failure()?.errorText || 'unknown',
      });
    });
    page.on('dialog', async (dialog) => {
      this.pushEvent('dialog', { type: dialog.type(), message: dialog.message().slice(0, 1000) });
      try {
        await dialog.accept();
      } catch {
        /* already handled */
      }
    });
    page.on('download', async (download) => {
      const entry = {
        id: shortId(),
        suggestedFilename: download.suggestedFilename(),
        url: download.url().slice(0, 1000),
        at: now(),
        path: null,
        error: null,
      };
      this.downloads.unshift(entry);
      this.downloads = this.downloads.slice(0, 20);
      try {
        const dir = path.join(config.downloadsDir, this.id);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `${entry.id}-${entry.suggestedFilename}`.replace(/[^\w.\-]+/g, '_'));
        await download.saveAs(target);
        entry.path = target;
        entry.size = fs.existsSync(target) ? fs.statSync(target).size : 0;
      } catch (e) {
        entry.error = String(e && e.message ? e.message : e);
      }
      this.pushEvent('download', { id: entry.id, filename: entry.suggestedFilename });
    });
    page.on('close', () => {
      this.closed = true;
    });
    page.on('crash', () => {
      this.closed = true;
      this.pushEvent('crash', { message: 'Page crashed' });
    });
  }

  pushEvent(type, data) {
    this.events.push({ type, at: now(), ...data });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  touch() {
    this.lastUsedAt = now();
  }

  info() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      url: this.url,
      title: this.title,
      loading: this.loading,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      closed: this.closed,
      viewers: this.viewers.size,
      scroll: this.scroll,
      content: this.content,
      viewport: this.viewport,
      downloads: this.downloads.map((d) => ({
        id: d.id,
        filename: d.suggestedFilename,
        size: d.size || null,
        error: d.error,
        at: d.at,
      })),
    };
  }

  async refreshMeta() {
    if (this.closed) return;
    // A click/type can kick off a navigation; Playwright then serialises every
    // evaluate/title call behind that navigation and each would burn its full
    // timeout. Race the whole refresh so it can never wedge an API response --
    // the screencast loop refreshes again shortly anyway.
    await withTimeout(
      (async () => {
        this.url = this.page.url();
        this.title = await this.page.title();
        this.scroll = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        this.content = await this.page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
          height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
        }));
        const vs = this.page.viewportSize();
        if (vs) this.viewport = vs;
      })(),
      3000
    ).catch(() => {});
  }

  /** Screenshot of the current viewport as a JPEG buffer. */
  async screenshot({ quality = config.frameQuality, fullPage = false, width = null } = {}) {
    if (this.closed) throw new HttpError(409, 'tab_closed', 'Tab is closed.');
    const buf = await this.page.screenshot({
      type: 'jpeg',
      quality,
      fullPage,
      timeout: config.actionTimeoutMs,
      caret: 'initial',
      animations: 'disabled',
    });
    const shotWidth = width || Math.round((this.viewport.width || config.viewportWidth) * config.deviceScaleFactor);
    return { buffer: buf, width: shotWidth };
  }

  /** Single in-flight screenshot; returns null when one is already running. */
  async screenshotNonBlocking(quality) {
    if (this._shotBusy || this.closed) return null;
    this._shotBusy = true;
    try {
      return await this.screenshot({ quality });
    } catch {
      return null;
    } finally {
      this._shotBusy = false;
    }
  }

  async navigate(url, { waitUntil = 'load' } = {}) {
    if (this.closed) throw new HttpError(409, 'tab_closed', 'Tab is closed.');
    const token = ++this._navToken;
    this.loading = true;
    this.touch();
    try {
      const resp = await this.page.goto(url, { waitUntil, timeout: config.navTimeoutMs });
      return {
        ok: true,
        status: resp ? resp.status() : null,
        url: this.page.url(),
        title: await this.page.title().catch(() => ''),
      };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (token !== this._navToken) return { ok: true, url: this.page.url(), superseded: true };
      // Firefox phrases timeouts differently than Chromium -- normalise.
      if (/Timeout .* exceeded|Navigation timeout/i.test(msg)) {
        return { ok: true, partial: true, url: this.page.url(), title: await this.safeTitle(), warning: 'navigation timed out; page may still be loading' };
      }
      throw new HttpError(400, 'navigation_failed', msg);
    } finally {
      if (token === this._navToken) this.loading = false;
      await this.refreshMeta();
    }
  }

  async safeTitle() {
    try {
      return await this.page.title();
    } catch {
      return this.title || '';
    }
  }

  async clickAt(x, y, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
    this.touch();
    await withTimeout(
      this.page.mouse.click(Number(x), Number(y), { button, clickCount, modifiers }),
      config.actionTimeoutMs
    );
    this.refreshMeta().catch(() => {});
  }

  async moveAt(x, y) {
    this.touch();
    await withTimeout(this.page.mouse.move(Number(x), Number(y)), config.actionTimeoutMs).catch(() => {});
  }

  async pressKey(key) {
    this.touch();
    await withTimeout(this.page.keyboard.press(key), config.actionTimeoutMs);
    this.refreshMeta().catch(() => {});
  }

  async typeText(text, { delay = 8 } = {}) {
    this.touch();
    await withTimeout(this.page.keyboard.type(String(text), { delay }), config.actionTimeoutMs);
    this.refreshMeta().catch(() => {});
  }

  async scrollBy(dx, dy) {
    this.touch();
    // window.scrollBy in the page is far more reliable than synthesised wheel
    // events under headless Gecko.
    await withTimeout(
      this.page.evaluate(([x, y]) => window.scrollBy(x, y), [Number(dx) || 0, Number(dy) || 0]),
      config.actionTimeoutMs
    ).catch(() => {});
    this.refreshMeta().catch(() => {});
  }

  async scrollTo(x, y) {
    this.touch();
    await withTimeout(
      this.page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [Number(x) || 0, Number(y) || 0]),
      config.actionTimeoutMs
    );
    this.refreshMeta().catch(() => {});
  }

  async evalJs(expression) {
    this.touch();
    const value = await this.page.evaluate((src) => {
      try {
        // eslint-disable-next-line no-new-func
        const out = new Function(`return (${src})`)();
        return { ok: true, value: out === undefined ? null : out };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }, String(expression));
    return value;
  }

  async extract({ textLimit = 20000, linkLimit = 200 } = {}) {
    this.touch();
    await this.refreshMeta();
    return this.page.evaluate(
      ({ textLimit: tl, linkLimit: ll }) => {
        const pick = (el) => (el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500) : null);
        const meta = {};
        for (const m of document.querySelectorAll('meta[name], meta[property]')) {
          const k = m.getAttribute('name') || m.getAttribute('property');
          if (k && !meta[k]) meta[k] = (m.getAttribute('content') || '').slice(0, 300);
        }
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({ text: pick(a), href: a.href }))
          .filter((l) => l.href.startsWith('http'))
          .slice(0, ll);
        const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            placeholder: el.getAttribute('placeholder') || null,
          }))
          .slice(0, 100);
        const forms = Array.from(document.querySelectorAll('form'))
          .map((f) => ({ id: f.id || null, name: f.getAttribute('name') || null, action: f.action || null, method: f.method || null }))
          .slice(0, 20);
        return {
          title: document.title,
          url: location.href,
          meta,
          canonical: pick(document.querySelector('link[rel="canonical"]')),
          text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, tl),
          textLength: document.body ? document.body.innerText.length : 0,
          links,
          inputs,
          forms,
          images: Array.from(document.querySelectorAll('img[src]')).length,
        };
      },
      { textLimit, linkLimit }
    );
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.page.close({ runBeforeUnload: false });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

class BrowserManager {
  constructor() {
    this.browser = null;
    this.contexts = new Map(); // sessionId -> context
    this.tabs = new Map(); // tabId -> Tab
    this.activeSessionId = null;
    this.activeTabId = null;
    this.launchError = null;
    this.startedAt = null;
    this._launching = null;
    this._idleSweeper = setInterval(() => this.sweepIdle(), 60_000);
    this._idleSweeper.unref();
  }

  get ready() {
    return Boolean(this.browser && this.browser.isConnected());
  }

  status() {
    return {
      engine: config.engine,
      ready: this.ready,
      version: this.browser ? this.browser.version() : null,
      launchedAt: this.startedAt,
      launchError: this.launchError,
      sessions: [...this.contexts.keys()],
      activeSessionId: this.activeSessionId,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map((t) => t.info()),
      limits: { maxTabs: config.maxTabs, maxSessions: MAX_SESSIONS },
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      memory: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
    };
  }

  async ensureBrowser() {
    if (this.ready) return this.browser;
    if (this._launching) return this._launching;

    this._launching = (async () => {
      const args = ['-headless'];
      const launchOptions = {
        headless: config.headless,
        args,
        timeout: config.launchTimeoutMs,
        firefoxUserPrefs: {
          'media.navigator.streams.fake': true,
          'dom.webnotifications.enabled': false,
          'browser.tabs.remote.autostart': false,
          'layers.acceleration.disabled': true,
        },
      };
      this.browser = await firefox.launch(launchOptions);
      this.startedAt = now();
      this.launchError = null;
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.contexts.clear();
        for (const t of this.tabs.values()) t.closed = true;
        this.tabs.clear();
        this.activeTabId = null;
        this.activeSessionId = null;
      });
      return this.browser;
    })();

    try {
      return await this._launching;
    } catch (e) {
      this.launchError = String(e && e.message ? e.message : e);
      throw new HttpError(503, 'engine_unavailable', `Failed to launch Firefox: ${this.launchError}`);
    } finally {
      this._launching = null;
    }
  }

  listSessions() {
    const out = [];
    try {
      if (fs.existsSync(config.sessionsDir)) {
        for (const name of fs.readdirSync(config.sessionsDir)) {
          const dir = path.join(config.sessionsDir, name);
          if (!fs.statSync(dir).isDirectory()) continue;
          const st = fs.statSync(dir);
          const stateFile = path.join(dir, 'state.json');
          let state = null;
          if (fs.existsSync(stateFile)) {
            try {
              state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            } catch {
              state = null;
            }
          }
          out.push({
            id: name,
            active: this.contexts.has(name),
            updatedAt: st.mtimeMs,
            cookies: state && state.cookies ? state.cookies.length : null,
            origins: state && state.origins ? state.origins.length : null,
          });
        }
      }
    } catch {
      /* ignore */
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getContext(sessionId, { create = true } = {}) {
    if (!sessionId) {
      if (this.activeSessionId && this.contexts.has(this.activeSessionId)) {
        return this.contexts.get(this.activeSessionId);
      }
      const existing = this.listSessions();
      sessionId = existing.length ? existing[0].id : 'default';
    }
    if (this.contexts.has(sessionId)) {
      this.activeSessionId = sessionId;
      return this.contexts.get(sessionId);
    }
    if (!create) throw new HttpError(404, 'session_not_found', `Unknown session "${sessionId}".`);

    await this.ensureBrowser();

    if (this.contexts.size >= MAX_SESSIONS) {
      // Evict the least recently used context (its tabs are closed).
      const oldest = [...this.contexts.entries()].sort(
        (a, b) => (this._ctxLru.get(a[0]) || 0) - (this._ctxLru.get(b[0]) || 0)
      )[0];
      if (oldest) await this.closeSession(oldest[0]);
    }

    const dir = path.join(config.sessionsDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const contextOptions = {
      viewport: { width: config.viewportWidth, height: config.viewportHeight },
      deviceScaleFactor: config.deviceScaleFactor,
      locale: config.locale,
      timezoneId: config.timezone,
      ignoreHTTPSErrors: boolish(process.env.IGNORE_HTTPS_ERRORS, true),
      acceptDownloads: true,
      bypassCSP: boolish(process.env.BYPASS_CSP, false),
      javaScriptEnabled: true,
    };
    if (config.userAgent) contextOptions.userAgent = config.userAgent;

    let context;
    try {
      context = await this.browser.newContext(contextOptions);
    } catch (e) {
      throw new HttpError(500, 'context_failed', String(e && e.message ? e.message : e));
    }

    // Restore previously exported cookies + localStorage, if any.
    const stateFile = path.join(dir, 'state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Array.isArray(state.cookies) && state.cookies.length) {
          await context.addCookies(sanitiseCookies(state.cookies));
        }
        if (Array.isArray(state.origins)) {
          for (const origin of state.origins) {
            if (!origin || !origin.origin || !Array.isArray(origin.localStorage)) continue;
            const page = await context.newPage();
            try {
              await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
              await page.evaluate((items) => {
                for (const { name, value } of items) {
                  try {
                    localStorage.setItem(name, value);
                  } catch {
                    /* quota / opaque origin */
                  }
                }
              }, origin.localStorage);
            } catch {
              /* origin unreachable -- cookies still restored */
            } finally {
              await page.close().catch(() => {});
            }
          }
        }
      } catch {
        /* corrupt state file -- start clean */
      }
    }

    context._sessionId = sessionId;
    this.contexts.set(sessionId, context);
    this.activeSessionId = sessionId;
    if (!this._ctxLru) this._ctxLru = new Map();
    this._ctxLru.set(sessionId, now());
    return context;
  }

  async createTab({ sessionId, url = 'about:blank' } = {}) {
    const context = await this.getContext(sessionId);
    const sid = context._sessionId;
    const tabsInSession = [...this.tabs.values()].filter((t) => t.sessionId === sid && !t.closed);
    if (tabsInSession.length >= config.maxTabs) {
      throw new HttpError(409, 'too_many_tabs', `Max ${config.maxTabs} tabs per session. Close one first.`);
    }
    const page = await context.newPage();
    await page.setViewportSize({ width: config.viewportWidth, height: config.viewportHeight });
    const tab = new Tab(shortId(), page, sid);
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    this.activeSessionId = sid;
    if (this._ctxLru) this._ctxLru.set(sid, now());
    if (url && url !== 'about:blank') {
      await tab.navigate(normaliseUrl(url)).catch(() => {});
    }
    await tab.refreshMeta();
    return tab;
  }

  getActiveTab() {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    if (tab && !tab.closed) return tab;
    const fallback = [...this.tabs.values()].find((t) => !t.closed);
    if (fallback) {
      this.activeTabId = fallback.id;
      return fallback;
    }
    throw new HttpError(404, 'no_tab', 'No open tab. Create one with POST /api/tabs.');
  }

  getTab(id) {
    if (!id) return this.getActiveTab();
    const tab = this.tabs.get(id);
    if (!tab || tab.closed) throw new HttpError(404, 'tab_not_found', `Unknown tab "${id}".`);
    this.activeTabId = tab.id;
    return tab;
  }

  setActive(id) {
    const tab = this.getTab(id);
    this.activeTabId = tab.id;
    this.activeSessionId = tab.sessionId;
    return tab;
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    await tab.close();
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      const next = [...this.tabs.values()].find((t) => !t.closed && t.sessionId === tab.sessionId);
      this.activeTabId = next ? next.id : null;
    }
    return true;
  }

  async saveSession(sessionId) {
    const sid = sessionId || this.activeSessionId;
    const context = sid ? this.contexts.get(sid) : null;
    if (!context) throw new HttpError(404, 'session_not_found', `Session "${sid}" is not loaded.`);
    const state = await context.storageState();
    const dir = path.join(config.sessionsDir, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    return {
      id: sid,
      cookies: state.cookies.length,
      origins: state.origins.length,
      savedAt: now(),
    };
  }

  async closeSession(sessionId) {
    const sid = sessionId || this.activeSessionId;
    const context = this.contexts.get(sid);
    if (!context) return false;
    try {
      await this.saveSession(sid);
    } catch {
      /* best effort */
    }
    for (const tab of [...this.tabs.values()]) {
      if (tab.sessionId === sid) await this.closeTab(tab.id);
    }
    await context.close().catch(() => {});
    this.contexts.delete(sid);
    if (this._ctxLru) this._ctxLru.delete(sid);
    if (this.activeSessionId === sid) {
      this.activeSessionId = [...this.contexts.keys()][0] || null;
    }
    return true;
  }

  async deleteSession(sessionId) {
    await this.closeSession(sessionId);
    const dir = path.join(config.sessionsDir, sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async exportSession(sessionId) {
    const sid = sessionId || this.activeSessionId;
    const context = this.contexts.get(sid);
    if (!context) throw new HttpError(404, 'session_not_found', `Session "${sid}" is not loaded.`);
    return context.storageState();
  }

  sweepIdle() {
    const cutoff = now() - config.tabIdleTimeoutMs;
    for (const tab of [...this.tabs.values()]) {
      if (tab.viewers.size > 0) {
        tab.touch();
        continue;
      }
      if (tab.lastUsedAt < cutoff) this.closeTab(tab.id).catch(() => {});
    }
  }

  async shutdown() {
    clearInterval(this._idleSweeper);
    for (const sid of [...this.contexts.keys()]) {
      try {
        await this.saveSession(sid);
      } catch {
        /* ignore */
      }
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('refresh timeout')), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function boolish(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function sanitiseCookies(cookies) {
  return cookies
    .filter((c) => c && c.name && (c.domain || c.url))
    .map((c) => {
      const out = { name: c.name, value: c.value ?? '' };
      if (c.url) out.url = c.url;
      else {
        out.domain = c.domain;
        out.path = c.path || '/';
      }
      if (typeof c.expires === 'number' && c.expires > -1) out.expires = c.expires;
      if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
      if (typeof c.secure === 'boolean') out.secure = c.secure;
      if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite;
      return out;
    });
}

function normaliseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'about:blank';
  if (/^(about|data|blob|file):/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  // bare "example.com" or "example.com/path" -> https
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(raw)) return `https://${raw}`;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(raw)) return `http://${raw}`;
  // Looks like a search query.
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

const manager = new BrowserManager();
manager._ctxLru = new Map();

module.exports = { manager, HttpError, normaliseUrl };
