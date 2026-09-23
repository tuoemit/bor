// In-memory sid -> user map. Needed because subresource requests carry a
// capability signature but not the session cookie (sandboxed iframe = opaque
// origin), and we still need to send the right cookie jar upstream.
const TTL_MS = 12 * 3600_000;
const map = new Map();

export function remember(sid, userId) {
  if (!sid || !userId) return;
  map.set(sid, { userId, at: Date.now() });
  if (map.size > 500) {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, value] of map) if (value.at < cutoff) map.delete(key);
  }
}

export function userFor(sid, fallback = 'owner') {
  const hit = map.get(sid);
  if (!hit) return fallback;
  if (Date.now() - hit.at > TTL_MS) {
    map.delete(sid);
    return fallback;
  }
  return hit.userId;
}

// Last document base per session. Used to recover JS-injected relative asset
// requests, which arrive without a signature and (in a sandboxed frame)
// without cookies or a reliable Referer.
const bases = new Map();
let globalBase = { url: null, at: 0 };

export function rememberBase(sid, baseUrl) {
  if (!baseUrl) return;
  const at = Date.now();
  bases.set(sid, { url: baseUrl, at });
  globalBase = { url: baseUrl, at };
}

export function baseFor(sid) {
  const hit = bases.get(sid);
  if (!hit) return null;
  return Date.now() - hit.at > 3600_000 ? null : hit.url;
}

export function lastBase() {
  return Date.now() - globalBase.at > 3600_000 ? null : globalBase.url;
}
