// Tiny dependency-free signed-token helper (JWT-shaped, HMAC-SHA-256).
// Used for session cookies so we don't need a session store in a
// single-instance, ephemeral-filesystem deployment.
import crypto from 'node:crypto';
import { config } from '../config.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

export function sign(payload) {
  const body = { ...payload, iat: Date.now(), exp: payload.exp ?? Date.now() + config.sessionTtlMs };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', config.sessionSecret).update(data).digest());
  return `${data}.${sig}`;
}

export function verify(token) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expected = crypto.createHmac('sha256', config.sessionSecret).update(data).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(fromB64url(data).toString('utf8'));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Constant-time compare for the login form (and any other secret check).
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}
