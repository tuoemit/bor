// Password gate. One env-var password -> one signed session cookie.
// No server-side session store needed, which keeps redeploys cheap.
import express from 'express';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { DEFAULT_USER, ensureUser, logEvent, touchLogin } from '../store.js';
import { sessionIdFromToken } from '../proxy/sign.js';
import { clientIp, isSecureRequest, readCookie } from '../util/http.js';
import { safeEqual, sign, verify } from '../util/token.js';

export const COOKIE_NAME = 'bp_session';

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;
const attempts = new Map(); // ip -> { count, first }

function tooManyAttempts(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailures(ip) {
  attempts.delete(ip);
}

function cookieParts(req, value, maxAgeSeconds) {
  const secure = isSecureRequest(req);
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    // SameSite=None is required whenever the panel is viewed inside another
    // site's iframe (hosted preview panes, dashboards). It is only legal
    // together with Secure, and we only widen it over https.
    `SameSite=${secure ? 'None' : 'Lax'}`,
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ];
}

function setSessionCookie(req, res, payload) {
  const token = sign(payload);
  res.append('Set-Cookie', cookieParts(req, encodeURIComponent(token), Math.floor(config.sessionTtlMs / 1000)).join('; '));
  return token;
}

export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', cookieParts(req, '', 0).join('; '));
}

/** Reads (and validates) the session cookie onto req.session. */
export function attachSession(req, _res, next) {
  const token = readCookie(req, COOKIE_NAME);
  const payload = token ? verify(token) : null;
  // sid is the short handle embedded in every proxied URL capability.
  req.session = payload ? { ...payload, token, sid: sessionIdFromToken(token) } : null;
  next();
}

export function requireAuth(req, res, next) {
  if (req.session) return next();
  // req.path is relative to the mount point ('/info'), so compare full URLs.
  const full = req.originalUrl || req.path;
  const wantsJson =
    full.startsWith('/api/') ||
    full.startsWith('/p/') ||
    (req.headers.accept ?? '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'unauthenticated', login: '/login' });
  return res.redirect('/login');
}

export function createAuthRouter() {
  const router = express.Router();
  // Scoped here rather than globally: /p/* bodies must reach upstream untouched.
  const smallJson = express.json({ limit: '64kb' });

  router.get('/login', (req, res) => {
    if (req.session) return res.redirect('/');
    return res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
  });

  router.post('/login', smallJson, (req, res) => {
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait 15 minutes.' });
    }

    const supplied = String(req.body?.password ?? '');
    if (!supplied || !safeEqual(supplied, config.password)) {
      noteFailure(ip);
      log.warn(`failed login from ${ip}`);
      return res.status(401).json({ error: 'bad_password', message: 'Incorrect password.' });
    }

    clearFailures(ip);
    const user = ensureUser(DEFAULT_USER);
    touchLogin(user.id);
    logEvent(user.id, 'login', ip);
    setSessionCookie(req, res, { sub: user.id });
    log.info(`login ok (${ip})`);
    return res.json({ ok: true });
  });

  router.post('/logout', smallJson, (req, res) => {
    if (req.session?.sub) logEvent(req.session.sub, 'logout', clientIp(req));
    clearSessionCookie(req, res);
    req.session = null;
    return res.json({ ok: true });
  });

  return router;
}
