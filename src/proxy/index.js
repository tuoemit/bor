// The proxy router: /p/<capability>/<kind>/<target>
//
//   page   - a document destined for the webview iframe (HTML gets rewritten)
//   asset  - subresource, streamed back verbatim (CSS gets rewritten)
//   dyn    - dynamic endpoint for the in-page fetch/XHR shim (?u=<abs url>)
//   cookie - accepts document.cookie writes from inside the sandboxed frame
import express from 'express';
import iconv from 'iconv-lite';
import { CDN_HEADERS, config, STRIP_RESPONSE } from '../config.js';
import { log } from '../log.js';
import { ProxyError } from '../util/net.js';
import { historyAdd } from '../store.js';
import { readCookie } from '../util/http.js';
import { bootstrapTag } from './bootstrap.js';
import { baseFor, lastBase, remember, rememberBase, userFor } from './registry.js';
import { absolutize, rewriteCss, rewriteHtml } from './rewrite.js';
import { decodeTarget, encodeTarget, makeSigner, sessionIdFromToken, unwrapProxyUrl, verifyCapability } from './sign.js';
import { clientHeaders, streamToClient, upstreamFetch, upstreamReferer } from './upstream.js';
import { cookieJarSet } from '../store.js';

const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)/i;
const CSS_TYPE = /^\s*text\/css/i;
const JS_TYPE = /^\s*(text|application)\/(x-)?(java|ecma)script/i;

const inflight = new Map();

function acquire(sid) {
  const n = inflight.get(sid) ?? 0;
  if (n >= config.maxInflightPerSession) return false;
  inflight.set(sid, n + 1);
  return true;
}
function release(sid) {
  const n = inflight.get(sid) ?? 0;
  if (n <= 1) inflight.delete(sid);
  else inflight.set(sid, n - 1);
}

function charsetFrom(contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '');
  return m ? m[1].toLowerCase() : null;
}

function sniffCharset(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

function isDecodable(charset) {
  try {
    return charset ? iconv.encodingExists(charset) : false;
  } catch {
    return false;
  }
}

export function errorPage(status, title, detail, url = '') {
  const safe = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  // Tell the panel what happened so it can offer a Retry action.
  const payload = JSON.stringify({ __bp: 1, type: 'error-page', status, message: title, detail })
    .replace(/</g, '\\u003c');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="bp-error" content="${safe(status)}">
<title>${safe(title)}</title>
<style>
  :root { color-scheme: dark; }
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;
       font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{max-width:560px;padding:28px;border:1px solid #262b36;border-radius:14px;background:#151924}
  .code{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f87171;letter-spacing:.08em}
  h1{margin:.5rem 0 .75rem;font-size:19px}
  p{margin:0 0 .5rem;color:#9ba3b4}
  code{background:#0b0e14;border:1px solid #262b36;border-radius:6px;padding:2px 6px;
       font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#cbd5e1}
  .hint{margin-top:14px;font-size:12.5px;color:#7c869a}
</style></head><body><div class="card">
  <div class="code">HTTP ${safe(status)}</div>
  <h1>${safe(title)}</h1>
  <p>${safe(detail)}</p>
  ${url ? `<p><code>${safe(url)}</code></p>` : ''}
  <p class="hint">This page lives inside the panel's webview. Use the panel's address bar to navigate elsewhere.</p>
</div>
<script>try{parent.postMessage(${payload.slice(0, -1)}}, '*');}catch(e){}</script>
</body></html>`;
}

function sendErrorPage(res, status, title, detail, url) {
  res
    .status(status)
    .set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    .send(errorPage(status, title, detail, url));
}

function applyPassthroughHeaders(res, response, extra = {}) {
  const headers = {};
  response.headers.forEach((value, key) => {
    if (STRIP_RESPONSE.has(key) || CDN_HEADERS.includes(key)) return;
    headers[key] = value;
  });
  delete headers['content-length'];
  Object.assign(headers, { 'x-robots-tag': 'noindex' }, extra);
  res.status(response.status).set(headers);
}

/* -------------------------------------------------------------- handlers */

async function proxyRequest(req, res, ctx) {
  const headers = clientHeaders(req);
  const referer = upstreamReferer(req, ctx.target);
  const body = req.body && req.body.length ? req.body : undefined;
  const method = req.method.toUpperCase();

  const { response, finalUrl } = await upstreamFetch({
    url: ctx.target,
    method,
    headers,
    body,
    userId: ctx.userId,
    referer,
    signal: ctx.signal,
  });

  const ctype = response.headers.get('content-type') ?? '';
  const html = HTML_TYPE.test(ctype) || (ctx.kind === 'page' && !ctype && response.status < 400);
  const css = CSS_TYPE.test(ctype) || (ctx.kind === 'asset' && /\.css(?:[?#]|$)/i.test(finalUrl));

  if (ctx.kind === 'page' && method === 'GET' && response.status < 400 && !html) {
    // Non-HTML document (PDF, image, download): record it, then stream.
    historyAdd(ctx.userId, finalUrl, null);
    noteBase(ctx.sid, finalUrl);
  }

  if (html && method !== 'HEAD') return sendHtml(req, res, response, finalUrl, ctx);
  if (css && method !== 'HEAD') return sendCss(res, response, finalUrl, ctx);

  const extra = { 'cache-control': 'private, max-age=120' };
  if (/\.(?:m?js|jsx|ts)(?:[?#]|$)/i.test(finalUrl) && !JS_TYPE.test(ctype)) {
    extra['content-type'] = 'application/javascript; charset=utf-8';
  }
  if (JS_TYPE.test(ctype) && !ctype.includes('charset')) {
    extra['content-type'] = `${ctype.split(';')[0]}; charset=utf-8`;
  }
  applyPassthroughHeaders(res, response, extra);
  streamToClient(response.body, res);
}

async function sendHtml(req, res, response, finalUrl, ctx) {
  const buf = Buffer.from(await response.arrayBuffer());

  if (buf.byteLength > config.maxBodyBytes) {
    log.warn(`html too large to rewrite (${buf.byteLength}B): ${finalUrl}`);
    applyPassthroughHeaders(res, response, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(buf);
  }

  const declared = charsetFrom(response.headers.get('content-type'));
  const charset = isDecodable(declared) ? declared : isDecodable(sniffCharset(buf)) ? sniffCharset(buf) : 'utf-8';

  let html;
  try {
    html = iconv.decode(buf, charset);
  } catch {
    html = buf.toString('utf8');
  }

  const signer = makeSigner(ctx.sid);
  const bootstrap = bootstrapTag(signer, finalUrl, ctx.userId);
  const rewritten = rewriteHtml(html, finalUrl, signer, { bootstrap, requestUrl: ctx.target });

  if (ctx.sid === ctx.cookieSid && ctx.userId) remember(ctx.sid, ctx.userId);
  noteBase(ctx.sid, finalUrl);

  historyAdd(ctx.userId, finalUrl, extractTitle(html));

  res
    .status(response.status)
    .set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    .send(rewritten);
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html ?? '');
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim() || null;
}

async function sendCss(res, response, finalUrl, ctx) {
  const buf = Buffer.from(await response.arrayBuffer());
  const declared = charsetFrom(response.headers.get('content-type'));
  const charset = isDecodable(declared) ? declared : 'utf-8';
  let css;
  try {
    css = iconv.decode(buf, charset);
  } catch {
    css = buf.toString('utf8');
  }
  const signer = makeSigner(ctx.sid);
  res
    .status(response.status)
    .set({
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'private, max-age=120',
      'x-robots-tag': 'noindex',
    })
    .send(rewriteCss(css, finalUrl, signer));
}

/* ---------------------------------------------------------------- routes */

function resolveCapability(req, params, payload) {
  const kind = params.kind;
  let target = null;
  let capTarget = null;

  if (kind === 'dyn') {
    target = typeof req.query.u === 'string' ? req.query.u : null;
    capTarget = '';
  } else {
    target = decodeTarget(payload);
    capTarget = target;
  }

  if (target && !/^https?:\/\//i.test(target)) target = null;

  // Guard against nesting: some sites (and our own rewrites) echo absolute
  // proxy paths back at us.
  if (target) target = unwrapProxyUrl(target);

  if (!target) {
    // The payload may be a path the *page* resolved against its own proxied
    // URL (very common with JS-injected assets: new Image().src = 'pic.png').
    // Recover the real base from the referer, or from the last document base
    // we served this session, then re-resolve.
    if (!STATIC_EXT.test(req.path)) return null;

    const fromReferer = baseFromReferer(req);
    const verifiedSid = fromReferer ? verifyCapability(fromReferer.prefix, fromReferer.kind, fromReferer.base) : null;
    const base = fromReferer && verifiedSid ? fromReferer.base : looksLikeBrowserSubresource(req) ? lastBase() : null;
    if (!base) return null;

    const segs = req.path.split('/');
    const tail = segs[segs.length - 1];
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    try {
      target = new URL(tail + qs, base).href;
      capTarget = target;
      params.kind = 'asset';
      const sid = verifiedSid ?? `orphan:${req.params.prefix ?? 'x'}`;
      return { sid, kind: 'asset', target, userId: userFor(verifiedSid ?? '', userForFromCookie(req)) };
    } catch {
      return null;
    }
  }

  const sid = verifyCapability(params.prefix, kind, capTarget ?? '');
  if (!sid) return null;
  return { sid, kind, target, userId: userFor(sid) };
}

function baseFromReferer(req) {
  const raw = req.headers.referer;
  if (!raw) return null;
  try {
    const ref = new URL(raw);
    const m = /^\/p\/([^/]+)\/(page|asset|dyn)\/(.*)$/.exec(ref.pathname);
    if (!m) return null;
    const [, prefix, kind, payload] = m;
    const base = decodeTarget(payload);
    if (!base) return null;
    return { prefix, kind: kind === 'page' ? 'page' : kind === 'asset' ? 'asset' : 'page', base };
  } catch {
    return null;
  }
}

const STATIC_EXT = /\.[a-z0-9]{2,5}(?:$|\?)/i;

/** Browsers tag subresource loads with Sec-Fetch-*; plain HTTP clients rarely do. */
function looksLikeBrowserSubresource(req) {
  return Boolean(
    req.headers['sec-fetch-dest'] ||
      req.headers['sec-fetch-site'] ||
      req.headers['sec-fetch-mode'] ||
      req.headers['accept']?.includes('image/') ||
      req.headers['accept']?.includes('text/css') ||
      req.headers['accept']?.includes('font'),
  );
}


function userForFromCookie(req) {
  const sid = sessionIdFromToken(readCookie(req, 'bp_session'));
  return userFor(sid ?? '', 'owner');
}

/** Remember the document base so orphan asset requests can be recovered. */
function noteBase(sid, url) {
  if (sid && url) rememberBase(sid, url);
}

/**
 * Root-level orphan handler. Some pages resolve relative URLs against the
 * panel origin (no /p/ prefix at all); if we can recover the base, we bounce
 * them into the signed asset route.
 */
export function createOrphanHandler() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!STATIC_EXT.test(req.path)) return next();

    const fromReferer = baseFromReferer(req);
    const verifiedSid = fromReferer ? verifyCapability(fromReferer.prefix, fromReferer.kind, fromReferer.base) : null;
    const base = fromReferer && verifiedSid ? fromReferer.base : looksLikeBrowserSubresource(req) ? lastBase() : null;
    if (!base) return next();

    let target;
    try {
      target = new URL(req.originalUrl, base).href;
    } catch {
      return next();
    }

    const signer = makeSigner(verifiedSid ?? 'orphan');
    return res.redirect(302, signer.path('asset', target));
  };
}

export function createProxyRouter() {
  const router = express.Router();

  // Bodies are buffered (bounded) so POST forms and API calls can be re-sent
  // upstream. Streams would need duplex plumbing for little benefit here.
  router.use(
    express.raw({ type: () => true, limit: config.maxBodyBytes }),
  );

  router.all('/p/:prefix/:kind/*', async (req, res) => {
    const payload = req.params[0] ?? '';
    let resolved;
    try {
      resolved = resolveCapability(req, req.params, payload);
    } catch (err) {
      log.debug(`capability error: ${err.message}`);
      resolved = null;
    }

    if (!resolved) {
      return sendErrorPage(
        res,
        403,
        'Proxied link expired',
        'This webview URL is no longer valid (signature mismatch or malformed target). Navigate again from the panel.',
        req.originalUrl.slice(0, 200),
      );
    }

    const { sid, kind, target, userId } = resolved;
    const cookieSid = sessionIdFromToken(readCookie(req, 'bp_session'));
    if (cookieSid && cookieSid === sid) remember(sid, userId);

    if (kind === 'cookie') {
      try {
        const url = target;
        const lines = [String(req.body ?? '')];
        cookieJarSet(userId, url, lines);
      } catch (err) {
        log.debug(`cookie write failed: ${err.message}`);
      }
      return res.status(204).end();
    }

    if (!acquire(sid)) {
      return sendErrorPage(res, 429, 'Too many parallel requests', 'Give the page a moment and retry.');
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      await proxyRequest(req, res, { sid, kind, target, userId, signal: controller.signal, cookieSid });
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof ProxyError) {
          sendErrorPage(res, err.status === 499 ? 504 : err.status, titleFor(err), err.message, target);
        } else {
          log.error(`proxy failure: ${err.stack ?? err.message}`);
          sendErrorPage(res, 502, 'Proxy error', err.message ?? 'Unknown failure', target);
        }
      } else {
        res.destroy();
      }
    } finally {
      release(sid);
    }
  });

  return router;
}

function titleFor(err) {
  switch (err.code) {
    case 'private_ip':
      return 'Blocked: private network address';
    case 'dns_failure':
      return 'DNS lookup failed';
    case 'timeout':
      return 'Upstream timed out';
    case 'blocked_host':
      return 'Host is blocked';
    case 'bad_scheme':
      return 'Unsupported URL scheme';
    default:
      return 'Could not load page';
  }
}

export { encodeTarget, absolutize };
