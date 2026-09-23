// Capability signing for proxy URLs.
//
// The panel session is a signed cookie. Because the webview iframe is
// sandboxed (no allow-same-origin -> opaque origin), subresource requests
// from inside the frame do NOT carry that cookie. So every proxied URL
// carries its own capability:  /p/<sid>.<sig>/<kind>/<target>
//
//   sid = truncated HMAC(sessionSecret, sessionToken)   -> 22 chars
//   sig = truncated HMAC(sessionSecret, "sid|kind|target") -> 16 chars
//
// The signature covers the target, so a leaked asset URL cannot be edited to
// fetch a different page.
import crypto from 'node:crypto';
import { config } from '../config.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest();

export function sessionIdFromToken(token) {
  if (!token) return null;
  return b64(hmac(`sid::${token}`)).slice(0, 22);
}

function signature(kind, target, sid) {
  return b64(hmac(`sig::${sid}|${kind}|${target}`)).slice(0, 16);
}

export function makeSigner(sid) {
  return {
    sid,
    prefix(kind, target) {
      return `${sid}.${signature(kind, target, sid)}`;
    },
    path(kind, target) {
      return `/p/${this.prefix(kind, target)}/${kind}/${Buffer.from(target, 'utf8').toString('base64url')}`;
    },
  };
}

export function verifyCapability(prefix, kind, target) {
  if (typeof prefix !== 'string') return null;
  const idx = prefix.indexOf('.');
  if (idx <= 0) return null;
  const sid = prefix.slice(0, idx);
  const sig = prefix.slice(idx + 1);
  const expected = signature(kind, target, sid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return sid;
}

export function decodeTarget(payload) {
  try {
    const decoded = Buffer.from(String(payload), 'base64url').toString('utf8');
    if (!/^https?:\/\//i.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export const encodeTarget = (url) => Buffer.from(String(url), 'utf8').toString('base64url');

/** Structural check: verifies the signature without knowing the target. */
export function splitPrefix(prefix) {
  const idx = String(prefix ?? '').indexOf('.');
  if (idx <= 0) return null;
  const sid = prefix.slice(0, idx);
  const sig = prefix.slice(idx + 1);
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(sid) || !/^[A-Za-z0-9_-]{4,64}$/.test(sig)) return null;
  return { sid, sig };
}

/**
 * A URL that is already a proxy path must never be proxied again: rewriting a
 * page twice (or a site echoing our own URLs) would otherwise nest proxies and
 * turn every request into a 404 against the wrong host.
 */
export function unwrapProxyUrl(rawUrl) {
  let current = rawUrl;
  for (let depth = 0; depth < 4; depth++) {
    let url;
    try {
      url = new URL(current);
    } catch {
      return current;
    }
    const match = /^\/p\/[^/]+\/(?:page|asset|cookie)\/([^/?#]+)/.exec(url.pathname);
    if (!match) return current;
    const inner = decodeTarget(match[1]);
    if (!inner) return current;
    current = inner;
  }
  return current;
}
