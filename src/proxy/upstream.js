// Upstream HTTP client. Thin wrapper over the platform fetch with:
//   * manual redirect handling (so we can rewrite Location)
//   * an explicit cookie jar per user
//   * resolved-IP validation on every hop (SSRF)
//   * a hard timeout and an abort hook for client disconnects
import { Readable } from 'node:stream';
import { config, HOP_BY_HOP } from '../config.js';
import { log } from '../log.js';
import { ProxyError, resolveTarget } from '../util/net.js';
import { cookieJarGet, cookieJarSet } from '../store.js';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 8;

// Headers we must not copy from the browser's request.
const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'content-length',
  'accept-encoding',
  'connection',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'cf-ipcountry',
  'true-client-ip',
  'priority',
]);

export function clientHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (REQUEST_STRIP.has(k)) continue;
    if (k.startsWith('sec-')) continue;
    if (k.startsWith('proxy-')) continue;
    out[k] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function upstreamReferer(req, targetUrl) {
  // Present the upstream origin as the referer so Referer-gated assets work.
  const raw = req.headers.referer;
  if (!raw) return undefined;
  try {
    const ref = new URL(raw);
    if (ref.pathname.startsWith('/p/')) return new URL(targetUrl).origin + '/';
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * @returns {Promise<{response: Response, finalUrl: string, setCookies: string[]}>}
 */
export async function upstreamFetch({
  url,
  method = 'GET',
  headers = {},
  body,
  userId,
  referer,
  signal,
  maxRedirects = MAX_REDIRECTS,
}) {
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolveTarget(current);

    const reqHeaders = {
      ...headers,
      'user-agent': config.userAgent,
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': headers['accept-language'] ?? 'en-US,en;q=0.9',
    };
    for (const k of Object.keys(reqHeaders)) {
      if (REQUEST_STRIP.has(k) || k.startsWith(':')) delete reqHeaders[k];
    }
    if (referer) reqHeaders.referer = referer; // origin-only, set by the caller

    if (userId) {
      const jar = cookieJarGet(userId, target.url.href);
      if (jar.length) reqHeaders.cookie = jar.join('; ');
    }

    const timeout = AbortSignal.timeout(config.upstreamTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await fetch(target.url.href, {
        method,
        headers: reqHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: combined,
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new ProxyError(504, `Upstream timed out: ${target.url.host}`, 'timeout');
      }
      if (err.name === 'AbortError') throw new ProxyError(499, 'Client aborted', 'aborted');
      throw new ProxyError(502, `Upstream connection failed: ${err.cause?.code ?? err.message}`, 'connect_failed');
    }

    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];

    if (setCookies.length && userId) {
      try {
        cookieJarSet(userId, target.url.href, setCookies);
      } catch (err) {
        log.warn(`cookie store failed: ${err.message}`);
      }
    }

    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: target.url.href, setCookies };

      let next;
      try {
        next = new URL(location, target.url.href).href;
      } catch {
        return { response, finalUrl: target.url.href, setCookies };
      }

      // Drain the redirect body so the socket can be reused.
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }

      if (method === 'POST' && response.status === 303) method = 'GET';
      current = next;
      continue;
    }

    return { response, finalUrl: target.url.href, setCookies };
  }

  throw new ProxyError(508, `Too many redirects (>${maxRedirects})`, 'redirect_loop');
}

export function streamToClient(webStream, res) {
  if (!webStream) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(webStream);
  nodeStream.on('error', (err) => {
    log.debug(`stream error: ${err.message}`);
    res.destroy();
  });
  res.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
}
