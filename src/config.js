// Central configuration. Everything comes from env vars so the same image
// runs unchanged on Render, Railway, Docker, or a laptop.
import crypto from 'node:crypto';
import path from 'node:path';

const asBool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const asInt = (v, dflt) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

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

  // Optional Servo sidecar ("fidelity mode"): a real engine for pages the
  // proxy can't handle, served as prebuilt screenshots and reader-mode text.
  // Lazy: nothing is spawned until the first request that needs it.
  servo: {
    enabled: asBool(process.env.SERVO_ENABLED, true),
    bin: (process.env.SERVO_BIN ?? '').trim() || path.join(process.cwd(), 'bin', 'servo-fetch'),
    host: (process.env.SERVO_HOST ?? '').trim() || '127.0.0.1',
    port: asInt(process.env.SERVO_PORT, 9233),
    timeoutMs: asInt(process.env.SERVO_TIMEOUT_MS, 45_000),
    startTimeoutMs: asInt(process.env.SERVO_START_TIMEOUT_MS, 30_000),
    maxRestarts: asInt(process.env.SERVO_MAX_RESTARTS, 3),
    viewport: (process.env.SERVO_VIEWPORT ?? '').trim() || '1280x800',
    idleShutdownMs: asInt(process.env.SERVO_IDLE_SHUTDOWN_MS, 5 * 60_000),
  },

  version: '1.2.0',
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
