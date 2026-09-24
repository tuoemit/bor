'use strict';

/**
 * cloud-browser -- HTTP + WebSocket entrypoint.
 *
 * Runs unchanged on Render and Railway:
 *   - binds 0.0.0.0:$PORT (both platforms inject PORT)
 *   - trusts the platform proxy so TLS/client IP are correct
 *   - graceful shutdown on SIGTERM so browser profiles are saved before exit
 */

const http = require('node:http');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const config = require('./lib/config');
const auth = require('./lib/auth');
const { manager, HttpError } = require('./lib/browserManager');
const { hub } = require('./lib/screencast');
const apiRoutes = require('./routes/api');

const app = express();
app.set('etag', false);
app.set('x-powered-by', false);
if (config.trustProxy) app.set('trust proxy', 1); // one hop: the Render/Railway edge

for (const dir of [config.dataDir, config.sessionsDir, config.downloadsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: '2mb' }));
app.use(auth.attachAuth);

/* ---------------------------- security headers --------------------- */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY'); // protect the panel itself
  if (req.path === '/' || req.path.startsWith('/login') || req.path.startsWith('/assets')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
      ].join('; ')
    );
  }
  next();
});

/* ------------------------------- auth ------------------------------ */

const loginAttemptsLog = [];

// NOTE: these routes are declared *before* `app.use('/api', ...)`, so the CSRF
// guard is applied explicitly here rather than inherited.
app.post('/api/auth/login', auth.requireCsrf, auth.loginGuard, (req, res) => {
  const password = String((req.body || {}).password ?? '');
  if (!config.panelPassword) {
    return res.status(500).json({
      error: 'not_configured',
      message: 'PANEL_PASSWORD is not set on this deployment. Set it in the platform dashboard and redeploy.',
    });
  }
  if (!auth.verifyPassword(password)) {
    const state = auth.registerFailure(req.clientIp);
    loginAttemptsLog.push({ at: Date.now(), ip: req.clientIp, ok: false });
    const locked = auth.isLocked(req.clientIp);
    return res.status(locked ? 429 : 401).json({
      error: 'invalid_password',
      message: locked
        ? `Too many attempts. Locked for ${auth.lockSecondsLeft(req.clientIp)}s.`
        : `Wrong password. ${Math.max(0, config.loginMaxFails - state.fails)} attempts left in this window.`,
    });
  }
  auth.registerSuccess(req.clientIp);
  loginAttemptsLog.push({ at: Date.now(), ip: req.clientIp, ok: true });
  if (loginAttemptsLog.length > 100) loginAttemptsLog.splice(0, loginAttemptsLog.length - 100);

  const { token, payload } = auth.createSessionToken();
  auth.setSessionCookie(res, token);
  return res.json({ ok: true, expiresAt: payload.exp });
});

app.post('/api/auth/logout', auth.requireCsrf, (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    authenticated: Boolean(req.isAuthenticated || req.hasApiToken),
    via: req.hasApiToken ? 'api_token' : req.isAuthenticated ? 'cookie' : null,
    expiresAt: req.sessionPayload ? req.sessionPayload.exp : null,
    configured: Boolean(config.panelPassword),
    recentAttempts: loginAttemptsLog.slice(-20),
  });
});

/* -------------------------- public health -------------------------- */

// Unauthenticated on purpose: uptime pingers need it to keep the free tier warm.
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    engine: config.engine,
    engineReady: manager.ready,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

/* ------------------------------ panel ------------------------------ */

app.use('/api', auth.requireAuth, auth.requireCsrf, apiRoutes);

app.get('/login', (req, res) => {
  if (req.isAuthenticated) return res.redirect(302, '/');
  return res.sendFile(path.join(config.publicDir, 'login.html'));
});

app.get('/', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

app.use(express.static(config.publicDir, { extensions: ['html'], index: false, maxAge: '5m' }));

/* --------------------------- error handling ------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
  }
  return res.status(404).sendFile(path.join(config.publicDir, 'login.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const body = {
    error: err.code || 'error',
    message: err.message || 'Internal error',
  };
  if (err.details) body.details = err.details;
  if (status >= 500) {
    process.stderr.write(`[error] ${req.method} ${req.originalUrl} -> ${err && err.stack ? err.stack : err}\n`);
  } else {
    process.stderr.write(`[warn] ${req.method} ${req.originalUrl} -> ${status} ${body.error}: ${body.message}\n`);
  }
  if (res.headersSent) return;
  res.status(status).json(body);
});

/* ------------------------------ server ----------------------------- */

const server = http.createServer(app);

hub.attach(server, {
  authenticate: (req) => {
    req.clientIp = auth.clientIp(req);
    req.cookies = (() => {
      const out = {};
      const header = req.headers.cookie;
      if (!header) return out;
      for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      }
      return out;
    })();
    if (auth.readSessionToken(req.cookies[config.cookieName])) return true;
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    return Boolean(config.apiToken && token === config.apiToken);
  },
});

// Warm the engine at boot so the first page load is not paying for a launch.
if (!boolish(process.env.LAZY_BROWSER, false)) {
  manager
    .ensureBrowser()
    .then((b) => process.stdout.write(`[boot] Firefox ready (${b.version()})\n`))
    .catch((e) => process.stderr.write(`[boot] WARNING: engine not ready: ${e.message}\n`));
}

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `[boot] cloud-browser listening on http://${config.host}:${config.port} ` +
      `(engine=${config.engine}, panel password ${config.panelPassword ? 'set' : 'MISSING'})\n`
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[shutdown] ${signal} received, saving sessions...\n`);
  const timer = setTimeout(() => process.exit(0), 8000);
  timer.unref();
  try {
    await hub.heartbeat && clearInterval(hub.heartbeat);
    await manager.shutdown();
    server.close(() => process.exit(0));
  } catch (e) {
    process.stderr.write(`[shutdown] ${e.message}\n`);
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[unhandledRejection] ${e && e.stack ? e.stack : e}\n`);
});

function boolish(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

module.exports = { app, server };
