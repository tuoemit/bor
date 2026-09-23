// Panel API. Everything here sits behind requireAuth.
import express from 'express';
import { config } from '../config.js';
import { isPersistent } from '../db.js';
import {
  DEFAULT_USER,
  bookmarkAdd,
  bookmarkRemove,
  bookmarksList,
  cookieJarClear,
  cookieJarList,
  historyClear,
  historyDelete,
  historyList,
  stats,
  topSites,
} from '../store.js';
import { hasVolume, platform } from '../util/http.js';
import { ProxyError, resolveTarget } from '../util/net.js';
import { makeSigner } from '../proxy/sign.js';
import { upstreamFetch } from '../proxy/upstream.js';
import { extractSuggestions } from './suggest.js';

const SEARCH_BASE = (process.env.SEARCH_URL ?? 'https://html.duckduckgo.com/html/?q=').trim();

const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
const LOCAL_LIKE = /^localhost(?::\d+)?(?:[/?#].*)?$/i;

export function normalizeInput(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return null;

  if (/^https?:\/\//i.test(input)) {
    try {
      return new URL(input).href;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return null; // unsupported scheme

  if (HOST_LIKE.test(input) || LOCAL_LIKE.test(input)) {
    try {
      return new URL(`https://${input}`).href;
    } catch {
      /* fall through to search */
    }
  }
  return `${SEARCH_BASE}${encodeURIComponent(input)}`;
}

// Express 4 does not catch rejected promises from handlers; without this a
// thrown error leaves the request hanging forever.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApiRouter() {
  const router = express.Router();
  const userId = DEFAULT_USER;

  router.get('/info', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      version: config.version,
      node: process.version,
      uptime_s: Math.round(process.uptime()),
      platform: platform(),
      persistent: isPersistent(),
      hasVolume: hasVolume(),
      dbPath: config.dbPath,
      ephemeralPassword: config.ephemeralPassword,
      allowPrivateHosts: config.allowPrivateHosts,
      engine: 'server-proxy webview (no headless browser)',
      memory_mb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
      limits: {
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        maxBodyBytes: config.maxBodyBytes,
        maxInflightPerSession: config.maxInflightPerSession,
      },
    });
  });

  /** Turn whatever the user typed into a signed, ready-to-load webview URL. */
  router.post('/navigate', wrap(async (req, res) => {
    const target = normalizeInput(req.body?.input ?? req.body?.url);
    if (!target) return res.status(400).json({ error: 'bad_input', message: 'Could not understand that address.' });

    try {
      await resolveTarget(target);
    } catch (err) {
      const status = err instanceof ProxyError ? err.status : 400;
      return res.status(status).json({ error: err.code ?? 'blocked', message: err.message, url: target });
    }

    const signer = makeSigner(req.session.sid);
    return res.json({ url: target, path: signer.path('page', target), kind: 'page' });
  }));

  /** Sign an arbitrary target (downloads, raw view, new-tab from inside a page). */
  router.post('/mint', (req, res) => {
    const target = String(req.body?.url ?? '');
    const kind = ['page', 'asset'].includes(req.body?.kind) ? req.body.kind : 'page';
    if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'bad_url' });
    const signer = makeSigner(req.session.sid);
    return res.json({ path: signer.path(kind, target) });
  });

  /** Plain-text source view of an upstream URL (helps debug proxy weirdness). */
  router.get('/source', wrap(async (req, res) => {
    const target = String(req.query.url ?? '');
    if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'bad_url' });
    try {
      const { response, finalUrl } = await upstreamFetch({
        url: target,
        userId,
        headers: { accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const buf = Buffer.from(await response.arrayBuffer());
      const slice = buf.subarray(0, 300_000).toString('utf8');
      return res.json({
        url: finalUrl,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: buf.byteLength,
        truncated: buf.byteLength > slice.length,
        source: slice,
      });
    } catch (err) {
      return res.status(typeof err.status === 'number' ? err.status : 502).json({
        error: err.code ?? 'fetch_failed',
        message: err.message,
      });
    }
  }));

  router.get('/suggest', (req, res) => {
    res.json({ items: extractSuggestions(userId, String(req.query.q ?? '')) });
  });

  router.get('/stats', (_req, res) => res.json({ counts: stats(userId), db: isPersistent() }));

  /* --------------------------------------------------------------- history */
  router.get('/history', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? '100', 10) || 100));
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? '0', 10) || 0);
    return res.json({ items: historyList(userId, { limit, offset, q: String(req.query.q ?? '') }) });
  });

  router.delete('/history/:id', (req, res) => {
    historyDelete(userId, Number(req.params.id));
    return res.json({ ok: true });
  });

  router.delete('/history', (_req, res) => {
    historyClear(userId);
    return res.json({ ok: true });
  });

  router.get('/frequent', (_req, res) => res.json({ items: topSites(userId, 20) }));

  /* ------------------------------------------------------------- bookmarks */
  router.get('/bookmarks', (_req, res) => res.json({ items: bookmarksList(userId) }));

  router.post('/bookmarks', (req, res) => {
    const url = String(req.body?.url ?? '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'bad_url' });
    const title = String(req.body?.title ?? url).slice(0, 300);
    return res.json({ item: bookmarkAdd(userId, url, title) });
  });

  router.delete('/bookmarks/:id', (req, res) => {
    bookmarkRemove(userId, Number(req.params.id));
    return res.json({ ok: true });
  });

  /* --------------------------------------------------------------- cookies */
  router.get('/cookies', (_req, res) => res.json({ items: cookieJarList(userId) }));

  router.delete('/cookies', (_req, res) => {
    cookieJarClear(userId);
    return res.json({ ok: true });
  });

  return router;
}

