// Chromium engine lifecycle.
//
// One Chromium instance serves the whole panel. It is expensive (~580 MB of
// process tree, measured) and unlike a screenshot engine it stays resident
// while you browse, so everything here is about keeping that cost bounded:
//   * refuse to start at all if the container can't hold it
//   * cap concurrent tabs, and suspend idle ones
//   * shut the whole engine down after a period with no viewers
//
// Sessions authenticate with the panel cookie; the WS handshake carries it, so
// the browser is never exposed to the network.
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { log } from '../log.js';
import { get, run } from '../db.js';

const { chromium: cfg } = config;

const state = {
  status: 'stopped', // stopped | starting | ready | error | disabled
  pid: null,
  version: null,
  pages: 0,
  startedAt: null,
  lastViewerAt: 0,
  lastError: null,
  blockedReason: null,
  restarts: 0,
};

let browser = null;
let context = null;
let starting = null;

// The browser is a direct child of this Node process. Linux only (Railway and
// both Docker images are Linux); returns null anywhere it can't tell.
function findChildPid() {
  if (process.platform !== 'linux') return null;
  try {
    const me = process.pid;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      } catch {
        continue; // process vanished between readdir and read
      }
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== me) continue;
      if (/headless_shell|chrome/i.test(stat.slice(0, stat.lastIndexOf(')')))) {
        return Number(entry);
      }
    }
  } catch {
    /* best effort */
  }
  return null;
}
// Reported in /api/engine and the About pane before Chromium is ever launched.
// Playwright names the install directory after the build number
// (.../chromium_headless_shell-1243/chrome-linux/headless_shell), so we can
// show something useful without paying for a launch just to read a string.
let installedVersion = null;
let idleTimer = null;
let stateDirty = false;

const note = (level, msg) => log[level](`[chromium] ${msg}`);

/* --------------------------------------------------------------- resources */

/** Container memory ceiling from the cgroup, in MB (null when unlimited). */
export function memoryLimitMb() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw || raw === 'max') continue;
      const bytes = Number.parseInt(raw, 10);
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 ** 4) continue;
      return Math.round(bytes / 1048576);
    } catch {
      /* next source */
    }
  }
  const total = os.totalmem?.();
  return Number.isFinite(total) && total > 0 ? Math.round(total / 1048576) : null;
}

function checkMemoryHeadroom() {
  const limit = memoryLimitMb();
  if (limit !== null && limit < cfg.minMemoryMb) {
    state.blockedReason =
      `This container is limited to ${limit} MB but the Chromium engine needs about ` +
      `${cfg.minMemoryMb} MB (measured: ~580 MB browser + ~80 MB panel). Raise the memory limit ` +
      '(Railway: Settings → Resources — 2 GB recommended), lower CHROMIUM_MIN_MEMORY_MB to ' +
      'override, or use proxy mode.';
    note('warn', state.blockedReason);
    return false;
  }
  return true;
}

function isInstalled() {
  try {
    // playwright-core resolves the browser from PLAYWRIGHT_BROWSERS_PATH or
    // the default cache; executablePath() throws when it isn't downloaded.
    const exe = chromium.executablePath();
    if (!exe) return false;
    if (!installedVersion) {
      const build = /-(\d+)[/-]/.exec(exe)?.[1];
      installedVersion = build ? `build ${build}` : 'installed';
    }
    return true;
  } catch {
    return false;
  }
}

export function status() {
  const installed = isInstalled();
  return {
    enabled: cfg.enabled,
    installed,
    available: cfg.enabled && installed && !state.blockedReason,
    status: state.status,
    version: state.version ?? installedVersion,
    pid: state.pid,
    pages: state.pages,
    maxTabs: cfg.maxTabs,
    restarts: state.restarts,
    uptime_s: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    memoryLimitMb: memoryLimitMb(),
    minMemoryMb: cfg.minMemoryMb,
    idleShutdownMs: cfg.idleShutdownMs,
    tabSleepMs: cfg.tabSleepMs,
    blockedReason: state.blockedReason,
    hint: state.blockedReason
      ? state.blockedReason
      : !cfg.enabled
        ? 'Chromium engine disabled via CHROMIUM_ENABLED=0.'
        : !installed
          ? 'Chromium is not installed. On Railway this is handled by the Dockerfile; locally run `npx playwright-core install chromium`.'
          : null,
  };
}

export const isAvailable = () => status().available;
export const getBrowser = () => browser;
export const getContext = () => context;

/* ------------------------------------------------------------ persistence */

const STATE_KEY = 'chromium_storage_state';

// Runs in every page: window.__bpFind(query, step) -> { count, index }
const FIND_HELPER = `(() => {
  let marks = [];
  let index = -1;
  const clear = () => {
    for (const m of marks) {
      const p = m.parentNode;
      if (p) { p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
    }
    marks = []; index = -1;
  };
  const focus = () => {
    marks.forEach((m) => { m.style.background = '#fde68a'; });
    if (index < 0 || !marks[index]) return;
    marks[index].style.background = '#fb923c';
    try { marks[index].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (e) { try { marks[index].scrollIntoView(); } catch (e2) {} }
  };
  window.__bpFind = (query, step) => {
    const q = String(query || '');
    if (!q) { clear(); return { count: 0, index: -1 }; }
    if (step === 0) {
      clear();
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const tag = n.parentNode && n.parentNode.nodeName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const needle = q.toLowerCase();
      for (const node of nodes) {
        if (marks.length >= 500) break;
        const text = node.nodeValue || '';
        const lower = text.toLowerCase();
        let at = lower.indexOf(needle);
        if (at === -1) continue;
        const frag = document.createDocumentFragment();
        let pos = 0;
        while (at !== -1) {
          if (at > pos) frag.appendChild(document.createTextNode(text.slice(pos, at)));
          const mark = document.createElement('mark');
          mark.setAttribute('data-bp-find', '');
          mark.style.cssText = 'background:#fde68a;color:#111;border-radius:2px';
          mark.textContent = text.slice(at, at + needle.length);
          frag.appendChild(mark); marks.push(mark);
          pos = at + needle.length;
          at = lower.indexOf(needle, pos);
        }
        if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
        if (node.parentNode) node.parentNode.replaceChild(frag, node);
      }
      index = marks.length ? 0 : -1;
      focus();
      return { count: marks.length, index };
    }
    if (!marks.length) return { count: 0, index: -1 };
    index = (index + (step > 0 ? 1 : -1) + marks.length) % marks.length;
    focus();
    return { count: marks.length, index };
  };
})();`;

/** Persist cookies + localStorage so logins survive redeploys. */
export async function saveStorageState({ force = false } = {}) {
  if (!context) return false;
  if (!force && !stateDirty) return false;
  try {
    const snapshot = await context.storageState();
    run(
      `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      [STATE_KEY, JSON.stringify({ savedAt: Date.now(), state: snapshot })],
    );
    stateDirty = false;
    log.debug('[chromium] storage state saved');
    return true;
  } catch (err) {
    note('warn', `could not save storage state: ${err.message}`);
    return false;
  }
}

function loadStorageState() {
  try {
    const row = get(`SELECT v FROM meta WHERE k = ?`, [STATE_KEY]);
    if (!row?.v) return null;
    const parsed = JSON.parse(row.v);
    const cookies = parsed?.state?.cookies?.length ?? 0;
    const origins = parsed?.state?.origins?.length ?? 0;
    log.info(`[chromium] restoring saved session: ${cookies} cookies, ${origins} origins`);
    return parsed.state;
  } catch (err) {
    note('warn', `could not load storage state: ${err.message}`);
    return null;
  }
}

export const markStateDirty = () => {
  stateDirty = true;
};

/* ---------------------------------------------------------------- lifecycle */

function launchArgs() {
  return [
    // Containers: no user namespaces, small /dev/shm, no GPU, no audio.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    // Keep background tabs painting-ish and timers running, because the user
    // may switch to them at any moment.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,BackForwardCache',
    // Cap the JS heap per renderer so one bad page can't eat the container.
    `--js-flags=--max-old-space-size=${cfg.rendererHeapMb}`,
    ...cfg.extraArgs,
  ];
}

export async function start() {
  if (!cfg.enabled) throw new Error('Chromium engine is disabled (CHROMIUM_ENABLED=0)');
  if (!isInstalled()) throw new Error('Chromium is not installed in this image');
  if (state.blockedReason) throw new Error(state.blockedReason);
  if (browser?.isConnected()) return browser;
  if (starting) return starting;

  starting = (async () => {
    state.status = 'starting';
    const t0 = Date.now();
    note('info', `launching (headless, ${cfg.viewport.width}x${cfg.viewport.height})`);

    browser = await chromium.launch({ args: launchArgs() });
    state.version = browser.version();
    // Playwright doesn't expose the OS pid, but "which process is eating my
    // Railway memory" is a real question, so find our direct child in /proc.
    // Diagnostic only — never fatal.
    state.pid = findChildPid();
    state.startedAt = Date.now();
    state.restarts = 0;

    const storageState = loadStorageState();
    context = await browser.newContext({
      viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
      userAgent: config.userAgent,
      locale: 'en-US',
      timezoneId: 'UTC',
      // Accept downloads into a temp dir rather than hanging navigation.
      acceptDownloads: true,
      ...(storageState ? { storageState } : {}),
    });

    // Find-in-page helper. Chromium exposes no CDP find API, so the search
    // runs in the page itself. Injected into every frame before any page
    // script runs, and kept small deliberately.
    await context.addInitScript({ content: FIND_HELPER });

    // Page-level defaults that make a remote-driven browser behave normally.
    context.on('page', (page) => {
      page.on('close', () => {
        state.pages = Math.max(0, state.pages - 1);
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) markStateDirty();
      });
      page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
      page.on('crash', () => note('error', 'a page crashed'));
    });

    browser.on('disconnected', () => {
      note('warn', 'browser disconnected');
      browser = null;
      context = null;
      state.pages = 0;
      if (state.status !== 'stopped') state.status = 'error';
    });

    state.status = 'ready';
    state.lastViewerAt = Date.now();
    note('info', `ready in ${Date.now() - t0}ms (chromium ${state.version})`);
    return browser;
  })().finally(() => {
    starting = null;
  });

  return starting;
}

export async function stop({ save = true } = {}) {
  if (save) await saveStorageState({ force: true });
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const b = browser;
  browser = null;
  context = null;
  state.status = 'stopped';
  state.pages = 0;
  state.pid = null;
  if (b) {
    try {
      await b.close();
      note('info', 'stopped');
    } catch (err) {
      note('warn', `error closing browser: ${err.message}`);
    }
  }
}

export function touchViewer() {
  state.lastViewerAt = Date.now();
  scheduleIdleShutdown();
}

function scheduleIdleShutdown() {
  if (!cfg.idleShutdownMs) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const idleFor = Date.now() - state.lastViewerAt;
    if (idleFor >= cfg.idleShutdownMs && state.pages === 0) {
      note('info', `no viewers for ${Math.round(idleFor / 1000)}s — stopping to free ~580 MB`);
      await stop();
    } else {
      scheduleIdleShutdown();
    }
  }, Math.min(cfg.idleShutdownMs, 60_000));
  idleTimer.unref?.();
}

export function notePageOpen() {
  state.pages += 1;
  state.lastViewerAt = Date.now();
  scheduleIdleShutdown();
}

export function notePageClosed() {
  state.pages = Math.max(0, state.pages - 1);
  scheduleIdleShutdown();
}

// Check the container budget at load so the panel can explain itself early.
if (cfg.enabled) checkMemoryHeadroom();
setInterval(() => {
  if (!cfg.enabled) return;
  const wasBlocked = Boolean(state.blockedReason);
  state.blockedReason = null;
  if (wasBlocked && checkMemoryHeadroom()) note('info', 'memory headroom now sufficient');
}, 5 * 60_000).unref?.();

export async function restart() {
  await stop();
  return start();
}
