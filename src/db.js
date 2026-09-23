// SQLite via sql.js (WASM). Chosen deliberately: no native build step, so
// `npm ci` on Render/Railway never needs a compiler or python, and the whole
// persistence layer is one file we can copy to a volume.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { config } from './config.js';
import { log } from './log.js';

const require = createRequire(import.meta.url);

let db = null;
let persistTimer = null;
let dirty = false;
let persistent = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  visited_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_history_user_time ON history (user_id, visited_at DESC);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, url)
);
CREATE TABLE IF NOT EXISTS cookies (
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '/',
  name TEXT NOT NULL,
  value TEXT,
  expires INTEGER,
  http_only INTEGER DEFAULT 0,
  secure INTEGER DEFAULT 0,
  same_site TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain, path, name)
);
CREATE INDEX IF NOT EXISTS idx_cookies_user ON cookies (user_id);
`;

export async function initDb() {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });

  let data = null;
  try {
    if (fs.existsSync(config.dbPath)) {
      data = new Uint8Array(fs.readFileSync(config.dbPath));
      log.info(`SQLite: loading ${config.dbPath} (${(data.byteLength / 1024).toFixed(0)} KB)`);
    }
  } catch (err) {
    log.warn(`SQLite: could not read ${config.dbPath}: ${err.message}`);
  }

  db = data ? new SQL.Database(data) : new SQL.Database();
  db.run(SCHEMA);

  try {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.accessSync(path.dirname(config.dbPath), fs.constants.W_OK);
    persistent = true;
  } catch {
    persistent = false;
    log.warn(
      'SQLite: DB_PATH is not writable — running in-memory. History/bookmarks/cookies ' +
        'will reset on restart. Mount a volume and point DB_PATH at it to persist.',
    );
  }

  return { persistent, path: config.dbPath };
}

export const isPersistent = () => persistent;

function schedulePersist() {
  if (!persistent) return;
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flush();
  }, 1500);
  persistTimer.unref?.();
}

export function flush() {
  if (!persistent || !dirty || !db) return;
  dirty = false;
  try {
    const bytes = Buffer.from(db.export());
    const tmp = `${config.dbPath}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, config.dbPath);
  } catch (err) {
    log.error(`SQLite: persist failed: ${err.message}`);
  }
}

export function all(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] ?? null;
}

export function run(sql, params = []) {
  if (!db) return;
  db.run(sql, params);
  schedulePersist();
}

export function closeDb() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  flush();
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}
