// Central configuration. Everything comes from env vars so the same image
// runs unchanged on Render, Railway, Docker, or a laptop.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const asBool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const asInt = (v, dflt) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

const mode = String(process.env.APP_ENGINE ?? 'hybrid').trim().toLowerCase();

const asList = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

let password = (process.env.APP_PASSWORD ?? '').trim();
let ephemeral = false;
if (!password) {
  password = crypto.randomBytes(9).toString('base64url');
  ephemeral = true;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: asInt(process.env.PORT, 8080),

  password,
  ephemeralPassword: ephemeral,
  // Sessions are HMAC-signed. Default key is derived from the password so a
  // bare deploy still works; set SESSION_SECRET to rotate the password
  // without invalidating existing logins.
  sessionSecret:
    (process.env.SESSION_SECRET ?? '').trim() ||
    crypto.createHash('sha256').update(`browser-panel::${password}`).digest('hex'),
  sessionTtlMs: asInt(process.env.SESSION_TTL_HOURS, 168) * 3600_000,

  dbPath: (process.env.DB_PATH ?? '').trim() || path.join(process.cwd(), 'data', 'browser.db'),

  upstreamTimeoutMs: asInt(process.env.UPSTREAM_TIMEOUT_MS, 30_000),
  maxBodyBytes: asInt(process.env.MAX_BODY_BYTES, 10 * 1024 * 1024),
  maxInflightPerSession: asInt(process.env.MAX_INFLIGHT_PER_SESSION, 12),

  // SSRF guard. On a cloud host this is what keeps the platform metadata
  // service (169.254.169.254) and the private network unreachable.
  allowPrivateHosts: asBool(process.env.ALLOW_PRIVATE_HOSTS, false),
  blockedHosts: asList(process.env.BLOCKED_HOSTS),

  // Node's default UA gets served bot pages; a desktop UA gets the real site.
  userAgent:
    (process.env.PROXY_USER_AGENT ?? '').trim() ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',

  // frame-ancestors for the PANEL page (the proxied webview is unaffected).
  // Widen this (e.g. CSP_FRAME_ANCESTORS=*) when the panel is embedded in
  // another site's iframe, such as a hosted preview pane.
  frameAncestors: (process.env.CSP_FRAME_ANCESTORS ?? '').trim() || "'self'",

  // Chromium engine: a real browser whose screen is streamed to the panel.
  // Lazy — nothing is spawned until a tab actually asks for it — and it shuts
  // itself down again when left idle, so an untouched deploy costs ~160 MB.
  chromium: {
    // APP_ENGINE=proxy  -> proxy only, never launch Chromium
    // APP_ENGINE=chromium (default) -> Chromium is the primary engine
    enabled: mode !== 'proxy' && asBool(process.env.CHROMIUM_ENABLED, true),
    extraArgs: asList(process.env.CHROMIUM_ARGS),
    // Measured on a real page: ~925 MB for the Chromium tree + ~150 MB for
    // Node and the panel. Shut the engine down below this and explain why
    // rather than letting the container OOM.
    minMemoryMb: asInt(process.env.CHROMIUM_MIN_MEMORY_MB, 1800),
    maxTabs: asInt(process.env.MAX_BROWSER_TABS, 3),
    // Suspended after this long without being the active tab (frees ~120 MB).
    tabSleepMs: asInt(process.env.TAB_SLEEP_MS, 15 * 60_000),
    // Engine shuts down entirely after this long with no page open.
    idleShutdownMs: asInt(process.env.BROWSER_IDLE_SHUTDOWN_MS, 10 * 60_000),
    viewport: {
      width: asInt(process.env.BROWSER_WIDTH, 1280),
      height: asInt(process.env.BROWSER_HEIGHT, 800),
    },
    quality: asInt(process.env.BROWSER_JPEG_QUALITY, 62),
    navTimeoutMs: asInt(process.env.BROWSER_NAV_TIMEOUT_MS, 45_000),
    rendererHeapMb: asInt(process.env.BROWSER_HEAP_MB, 512),
    // Skip a frame if the socket is backed up beyond this many bytes.
    maxSocketBacklog: asInt(process.env.BROWSER_SOCKET_BACKLOG, 1_500_000),
  },

  engineMode: mode,

  // Read from package.json so there is exactly one place to bump the version.
  // This string drifted from the real version twice before it was derived.
  version: (() => {
    try {
      const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
      return JSON.parse(raw).version;
    } catch {
      return 'unknown';
    }
  })(),
};

// Hop-by-hop headers must never be forwarded (RFC 9110 7.6.1).
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Response headers that stop a page from being framed. Injected content is
// rendered by *your* browser inside our panel, so our own CSP/XFO is what
// governs it — upstream ones would blank the tab.
export const FRAME_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'permissions-policy',
]);

// Headers that must not be echoed on proxied responses because they would
// either lock down or corrupt our own panel document/API.
export const STRIP_RESPONSE = new Set([
  'set-cookie', // our cookie jar handles these
  'content-encoding', // fetch already decoded the body
  'content-length', // recomputed by Node
  ...HOP_BY_HOP,
  ...FRAME_HEADERS,
]);

export const CDN_HEADERS = [
  'cf-cache-status',
  'cf-ray',
  'x-served-by',
  'x-cache',
  'x-cache-hits',
  'age',
  'via',
  'alt-svc',
  'expect-ct',
];
