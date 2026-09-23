// browser-panel — password-protected remote browser panel.
// Server-side HTTP proxy + iframe webview. No Chromium, no headless browser:
// the rendering happens in the user's own browser, which is what lets this run
// inside 512 MB / 0.1 CPU free tiers on Render and Railway.
import express from 'express';
import path from 'node:path';
import { config } from './src/config.js';
import { closeDb, initDb } from './src/db.js';
import { log } from './src/log.js';
import { createOrphanHandler, createProxyRouter, errorPage } from './src/proxy/index.js';
import { createApiRouter } from './src/web/api.js';
import { attachSession, createAuthRouter, requireAuth } from './src/web/auth.js';
import { cookieMiddleware, platform } from './src/util/http.js';
import { isAvailable as servoAvailable, stop as stopServo } from './src/servo/manager.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');

const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  `frame-ancestors ${config.frameAncestors}`,
].join('; ');

export function createApp() {
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Panel-level hardening. Deliberately NOT applied to /p/* — proxied
  // documents are sandboxed by the iframe instead, and upstream CSP is
  // stripped because it would otherwise blank the webview.
  app.use((req, res, next) => {
    if (req.path.startsWith('/p/')) return next();
    const headers = {
      'content-security-policy': PANEL_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-robots-tag': 'noindex, nofollow',
    };
    // X-Frame-Options is the legacy equivalent; sending SAMEORIGIN alongside a
    // widened frame-ancestors would contradict it.
    if (config.frameAncestors === "'self'") headers['x-frame-options'] = 'SAMEORIGIN';
    res.set(headers);
    return next();
  });

  app.use(cookieMiddleware);
  app.use(attachSession);

  // Health check: public, and used by both Render and Railway.
  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

  // JSON body parsing for the panel API only. /p/* bodies are handled raw
  // (they can be arbitrary form posts or uploads destined upstream).
  const json = express.json({ limit: '1mb' });

  app.use(createAuthRouter());
  app.use('/api', requireAuth, json, createApiRouter());

  // Capability-signed proxy. No panel cookie required by design: the webview
  // is sandboxed, so it relies on signed paths instead.
  app.use(createProxyRouter());

  // Injected bootstrap script must be reachable from inside the sandboxed
  // frame, i.e. without cookies.
  app.use(
    '/static',
    express.static(path.join(PUBLIC_DIR, 'static'), {
      index: false,
      maxAge: '1h',
      setHeaders: (res) => res.set('access-control-allow-origin', '*'),
    }),
  );

  app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get(['/panel.css', '/panel.js'], requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, req.path.slice(1))));

  // Relative-URL recovery for pages that escape the /p/ prefix.
  app.use(createOrphanHandler());

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    return res
      .status(404)
      .set({ 'content-type': 'text/html; charset=utf-8' })
      .send(errorPage(404, 'Not found', `No route for ${req.method} ${req.path}`));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error(`unhandled: ${err.stack ?? err.message}`);
    if (res.headersSent) return res.destroy();
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'internal_error' });
    return res.status(500).send(errorPage(500, 'Server error', err.message));
  });

  return app;
}

async function main() {
  const dbInfo = await initDb();
  const dbState = dbInfo.persistent ? `persistent (${dbInfo.path})` : 'in-memory (ephemeral)';

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const where = platform();
    log.info('──────────────────────────────────────────────');
    log.info(`browser-panel v${config.version} — ${where.name}`);
    log.info(`listening on http://${config.host}:${config.port}`);
    log.info(`store: ${dbState}`);
    log.info('engine: server-side proxy webview (no headless browser)');
    const servo = servoAvailable();
    log.info(
      servo
        ? 'fidelity: Servo sidecar available (lazy — starts on first fidelity render)'
        : 'fidelity: Servo sidecar not available (proxy-only; see SERVO_BIN)',
    );
    if (config.ephemeralPassword) {
      log.warn('APP_PASSWORD was not set. Generated a one-time password:');
      log.warn(`  →  ${config.password}`);
      log.warn('  Sessions reset whenever the service restarts. Set APP_PASSWORD to fix that.');
    }
    log.info('──────────────────────────────────────────────');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    stopServo();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error(`unhandledRejection: ${err?.stack ?? err}`));
  process.on('uncaughtException', (err) => {
    log.error(`uncaughtException: ${err?.stack ?? err}`);
    closeDb();
    process.exit(1);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly || process.env.BP_START !== '0') {
  main().catch((err) => {
    log.error(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
