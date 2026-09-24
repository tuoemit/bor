'use strict';

/**
 * Central configuration. Everything is driven by environment variables so the
 * exact same image/config runs on Render and on Railway.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const PORT = intEnv('PORT', 3000);
const HOST = process.env.HOST || '0.0.0.0';

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const API_TOKEN = process.env.API_TOKEN || '';

let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  process.stderr.write(
    '[config] WARNING: SESSION_SECRET is not set. A random secret was generated, so every ' +
    'login is invalidated on each restart/deploy. Set SESSION_SECRET to a long random string.\n'
  );
}

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(DATA_DIR, 'sessions');
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(DATA_DIR, 'downloads');

const config = {
  port: PORT,
  host: HOST,
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),

  panelPassword: PANEL_PASSWORD,
  apiToken: API_TOKEN,
  sessionSecret: SESSION_SECRET,

  // Auth hardening
  cookieName: 'cb_session',
  cookieMaxAgeMs: intEnv('SESSION_TTL_HOURS', 12) * 60 * 60 * 1000,
  loginWindowMs: intEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000),
  loginMaxFails: intEnv('LOGIN_MAX_FAILS', 10),
  trustProxy: boolEnv('TRUST_PROXY', true), // both Render and Railway sit behind a proxy

  // Browser / engine
  dataDir: DATA_DIR,
  sessionsDir: SESSIONS_DIR,
  downloadsDir: DOWNLOADS_DIR,
  headless: boolEnv('HEADLESS', true),
  engine: 'firefox', // deliberate: Gecko, not Chromium
  launchTimeoutMs: intEnv('BROWSER_LAUNCH_TIMEOUT_MS', 60_000),
  navTimeoutMs: intEnv('NAV_TIMEOUT_MS', 45_000),
  actionTimeoutMs: intEnv('ACTION_TIMEOUT_MS', 20_000),

  // Tabs
  maxTabs: intEnv('MAX_TABS', 4),
  tabIdleTimeoutMs: intEnv('TAB_IDLE_TIMEOUT_MS', 20 * 60 * 1000),

  // Viewport
  viewportWidth: intEnv('VIEWPORT_WIDTH', 1280),
  viewportHeight: intEnv('VIEWPORT_HEIGHT', 800),
  deviceScaleFactor: intEnv('DEVICE_SCALE_FACTOR', 1),
  zoom: Number.parseFloat(process.env.ZOOM || '1') || 1,

  // Screencast
  frameQuality: intEnv('FRAME_QUALITY', 62),
  frameIntervalMs: intEnv('FRAME_INTERVAL_MS', 180),
  maxFrameWidth: intEnv('MAX_FRAME_WIDTH', 1280),

  // Automation
  scriptMaxSteps: intEnv('SCRIPT_MAX_STEPS', 60),
  scriptTimeoutMs: intEnv('SCRIPT_TIMEOUT_MS', 120_000),

  // Misc
  secureCookies: boolEnv('SECURE_COOKIES', true),
  userAgent: process.env.USER_AGENT || '',
  locale: process.env.LOCALE || 'en-US',
  timezone: process.env.TIMEZONE || 'UTC',
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
  homeDir: os.homedir(),
};

module.exports = config;
