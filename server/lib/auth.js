'use strict';

/**
 * Password gate for the panel.
 *
 *  - The password lives in PANEL_PASSWORD (env var), never in the repo.
 *  - Constant-time comparison (timingEqual) so the password cannot be recovered
 *    by measuring response times.
 *  - Sliding-window rate limit per client IP with exponential lockout.
 *  - Sessions are *signed* HMAC cookies (no server-side session store needed, so
 *    nothing is lost on restart and it works identically on Render and Railway).
 *  - Every state-changing call must carry `X-Requested-With: panel`, which gives
 *    CSRF protection on top of the SameSite=Strict cookie.
 */

const crypto = require('node:crypto');
const config = require('./config');

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'panel';

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn comparable time so length is not leaked by timing alone.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ */
/* Signed cookie                                                       */
/* ------------------------------------------------------------------ */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('base64url');
}

function createSessionToken() {
  const payload = {
    v: 1,
    iat: Date.now(),
    exp: Date.now() + config.cookieMaxAgeMs,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return { token: `${payloadB64}.${sign(payloadB64)}`, payload };
}

function readSessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { fails, firstFail, lockedUntil }

function rateLimitState(ip) {
  let s = attempts.get(ip);
  const now = Date.now();
  if (!s || now - s.firstFail > config.loginWindowMs) {
    s = { fails: 0, firstFail: now, lockedUntil: 0 };
    attempts.set(ip, s);
  }
  return s;
}

function isLocked(ip) {
  const s = rateLimitState(ip);
  return Date.now() < s.lockedUntil;
}

function lockSecondsLeft(ip) {
  const s = rateLimitState(ip);
  return Math.max(0, Math.ceil((s.lockedUntil - Date.now()) / 1000));
}

function registerFailure(ip) {
  const s = rateLimitState(ip);
  s.fails += 1;
  if (s.fails >= config.loginMaxFails) {
    const over = s.fails - config.loginMaxFails;
    s.lockedUntil = Date.now() + Math.min(30, 1 * 2 ** Math.min(over, 4)) * 60 * 1000;
    s.fails = 0;
  }
  return s;
}

function registerSuccess(ip) {
  attempts.delete(ip);
}

// Keep the map from growing forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of attempts) {
    if (now - s.firstFail > config.loginWindowMs && now >= s.lockedUntil) attempts.delete(ip);
  }
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* Express middleware                                                  */
/* ------------------------------------------------------------------ */

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isPanelRequest(req) {
  const h = req.headers[CSRF_HEADER];
  if (h && String(h).toLowerCase() === CSRF_VALUE) return true;
  // Allow the browser to authenticate a WebSocket upgrade: the ws handshake is
  // not a state-changing request and cannot carry custom headers in all clients.
  if (req.headers.upgrade && String(req.headers.upgrade).toLowerCase() === 'websocket') return true;
  return false;
}

function attachAuth(req, _res, next) {
  req.clientIp = clientIp(req);
  req.cookies = parseCookies(req);
  req.sessionPayload = readSessionToken(req.cookies[config.cookieName]);
  req.isAuthenticated = Boolean(req.sessionPayload);
  // Optional machine access: Authorization: Bearer <API_TOKEN>
  const auth = req.headers.authorization || '';
  req.hasApiToken = Boolean(
    config.apiToken &&
      auth.startsWith('Bearer ') &&
      timingEqual(auth.slice('Bearer '.length).trim(), config.apiToken)
  );
  next();
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated || req.hasApiToken) return next();
  // `req.path` is already stripped of the mount point inside app.use('/api', ...),
  // so test the original URL to tell API calls from page loads.
  const isApi = (req.originalUrl || req.url || '').startsWith('/api/');
  if (isApi || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Login required.' });
  }
  return res.redirect(302, '/login');
}

function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.hasApiToken) return next(); // token-authenticated automation calls
  if (!isPanelRequest(req)) {
    return res.status(403).json({ error: 'csrf', message: 'Missing X-Requested-With header.' });
  }
  return next();
}

function loginGuard(req, res, next) {
  if (isLocked(req.clientIp)) {
    return res.status(429).json({
      error: 'locked',
      message: `Too many failed attempts. Try again in ${lockSecondsLeft(req.clientIp)}s.`,
      retryAfterSeconds: lockSecondsLeft(req.clientIp),
    });
  }
  return next();
}

function verifyPassword(candidate) {
  if (!config.panelPassword) return false;
  return timingEqual(candidate, config.panelPassword);
}

function setSessionCookie(res, token) {
  const parts = [
    `${config.cookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.cookieMaxAgeMs / 1000)}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = {
  attachAuth,
  requireAuth,
  requireCsrf,
  loginGuard,
  verifyPassword,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  registerFailure,
  registerSuccess,
  isLocked,
  lockSecondsLeft,
  readSessionToken,
  clientIp,
  CSRF_HEADER,
};
