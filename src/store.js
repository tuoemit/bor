// Domain-level data access. Everything is scoped by user_id so the schema is
// already multi-user ready, even though the default deployment is one
// password = one user.
import { all, get, run } from './db.js';
import { randomId } from './util/token.js';

export const DEFAULT_USER = 'owner';

export function ensureUser(userId = DEFAULT_USER, label = 'Panel owner') {
  const existing = get(`SELECT id FROM users WHERE id = ?`, [userId]);
  if (existing) return existing;
  run(`INSERT INTO users (id, label, created_at, last_login_at) VALUES (?, ?, ?, ?)`, [
    userId,
    label,
    Date.now(),
    Date.now(),
  ]);
  return { id: userId };
}

export function touchLogin(userId = DEFAULT_USER) {
  run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [Date.now(), userId]);
}

/* ----------------------------------------------------------------- history */
export function historyAdd(userId, url, title) {
  const last = get(
    `SELECT id, visit_count FROM history WHERE user_id = ? AND url = ? ORDER BY visited_at DESC LIMIT 1`,
    [userId, url],
  );
  const now = Date.now();
  if (last) {
    run(`UPDATE history SET visited_at = ?, visit_count = visit_count + 1, title = COALESCE(?, title) WHERE id = ?`, [
      now,
      title ?? null,
      last.id,
    ]);
    return last.id;
  }
  run(`INSERT INTO history (user_id, url, title, visited_at, visit_count) VALUES (?, ?, ?, ?, 1)`, [
    userId,
    url,
    title ?? url,
    now,
  ]);
  const row = get(`SELECT last_insert_rowid() AS id`);
  return row?.id;
}

export function historyList(userId, { limit = 100, offset = 0, q = '' } = {}) {
  const needle = q ? `%${q}%` : null;
  return all(
    `SELECT id, url, title, visited_at, visit_count FROM history
      WHERE user_id = ? AND (? IS NULL OR url LIKE ? OR title LIKE ?)
      ORDER BY visited_at DESC LIMIT ? OFFSET ?`,
    [userId, needle, needle, needle, limit, offset],
  );
}

export function historyDelete(userId, id) {
  run(`DELETE FROM history WHERE user_id = ? AND id = ?`, [userId, id]);
}

export function historyClear(userId) {
  run(`DELETE FROM history WHERE user_id = ?`, [userId]);
}

export function topSites(userId, limit = 12) {
  return all(
    `SELECT url, title, SUM(visit_count) AS visits, MAX(visited_at) AS last_seen
       FROM history WHERE user_id = ?
      GROUP BY url ORDER BY visits DESC, last_seen DESC LIMIT ?`,
    [userId, limit],
  );
}

/* --------------------------------------------------------------- bookmarks */
export function bookmarksList(userId) {
  return all(`SELECT id, url, title, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

export function bookmarkAdd(userId, url, title) {
  run(
    `INSERT INTO bookmarks (user_id, url, title, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, url) DO UPDATE SET title = excluded.title`,
    [userId, url, title ?? url, Date.now()],
  );
  return get(`SELECT id, url, title, created_at FROM bookmarks WHERE user_id = ? AND url = ?`, [userId, url]);
}

export function bookmarkRemove(userId, id) {
  run(`DELETE FROM bookmarks WHERE user_id = ? AND id = ?`, [userId, id]);
}

export function bookmarkRemoveUrl(userId, url) {
  run(`DELETE FROM bookmarks WHERE user_id = ? AND url = ?`, [userId, url]);
}

export function isBookmarked(userId, url) {
  return !!get(`SELECT 1 AS x FROM bookmarks WHERE user_id = ? AND url = ?`, [userId, url]);
}

/* ----------------------------------------------------------------- cookies */
export function cookieJarGet(userId, urlString) {
  const url = new URL(urlString);
  const host = url.hostname.toLowerCase();
  const secure = url.protocol === 'https:';
  const now = Date.now();
  const rows = all(`SELECT * FROM cookies WHERE user_id = ?`, [userId]);
  const nowS = Math.floor(now / 1000);

  return rows
    .filter((c) => {
      if (c.expires && c.expires > 0 && c.expires < nowS) return false;
      if (c.secure && !secure) return false;
      const d = c.domain.replace(/^\./, '').toLowerCase();
      const domainOk = host === d || host.endsWith(`.${d}`);
      if (!domainOk) return false;
      const p = c.path || '/';
      return url.pathname.startsWith(p);
    })
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .map((c) => `${c.name}=${c.value}`);
}

export function cookieJarSet(userId, urlString, setCookieHeaders) {
  const url = new URL(urlString);
  const defaults = { domain: url.hostname.toLowerCase(), path: defaultPath(url.pathname) };
  let stored = 0;

  for (const raw of setCookieHeaders) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    const domain = (parsed.attrs.domain ?? defaults.domain).replace(/^\./, '').toLowerCase();
    const pathAttr = parsed.attrs.path ?? defaults.path;

    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      run(`DELETE FROM cookies WHERE user_id = ? AND domain = ? AND path = ? AND name = ?`, [
        userId,
        domain,
        pathAttr,
        parsed.name,
      ]);
      stored++;
      continue;
    }

    const expires =
      parsed.attrs.expires != null
        ? Math.floor(new Date(parsed.attrs.expires).getTime() / 1000) || 0
        : parsed.maxAge != null
          ? Math.floor(Date.now() / 1000) + parsed.maxAge
          : 0; // session cookie: survives our session, which is the intent here

    run(
      `INSERT INTO cookies (user_id, domain, path, name, value, expires, http_only, secure, same_site, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, domain, path, name)
       DO UPDATE SET value = excluded.value, expires = excluded.expires,
                     http_only = excluded.http_only, secure = excluded.secure,
                     same_site = excluded.same_site, updated_at = excluded.updated_at`,
      [
        userId,
        domain,
        pathAttr,
        parsed.name,
        parsed.value,
        expires,
        parsed.attrs.httponly ? 1 : 0,
        parsed.attrs.secure ? 1 : 0,
        parsed.attrs.samesite ?? null,
        Date.now(),
      ],
    );
    stored++;
  }
  return stored;
}

export function cookieJarClear(userId) {
  run(`DELETE FROM cookies WHERE user_id = ?`, [userId]);
}

export function cookieJarList(userId) {
  return all(`SELECT domain, path, name, expires, secure, http_only, updated_at FROM cookies WHERE user_id = ? ORDER BY domain`, [
    userId,
  ]);
}

/* -------------------------------------------------------------------- misc */
export function logEvent(userId, event, ip = null) {
  run(`INSERT INTO sessions_log (user_id, event, ip, at) VALUES (?, ?, ?, ?)`, [userId, event, ip, Date.now()]);
}

export function stats(userId) {
  return {
    history: get(`SELECT COUNT(*) AS n FROM history WHERE user_id = ?`, [userId])?.n ?? 0,
    bookmarks: get(`SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?`, [userId])?.n ?? 0,
    cookies: get(`SELECT COUNT(*) AS n FROM cookies WHERE user_id = ?`, [userId])?.n ?? 0,
  };
}

/* ---------------------------------------------------------------- internals */
function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

export function parseSetCookie(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(';');
  const [pair, ...attrParts] = parts;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const attrs = {};
  let maxAge;
  for (const attr of attrParts) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? true : attr.slice(i + 1).trim();
    if (key === 'max-age') maxAge = Number.parseInt(val, 10);
    else if (key !== '') attrs[key] = val;
  }

  return { name, value, attrs, maxAge: Number.isFinite(maxAge) ? maxAge : undefined, newId: randomId(4) };
}
