// Supervises the optional servo-fetch sidecar.
//
// The sidecar is a real browser engine (Servo) exposed as a tiny HTTP API:
// it renders pages to PNG and extracts reader-mode text. It is started
// lazily -- nothing runs until the panel actually asks for a fidelity
// render -- because it costs ~220 MB RSS, which is more than the whole proxy.
//
// Runs on a paid 1-2 GB instance comfortably; on a free 512 MB instance leave
// it disabled (the panel degrades to proxy-only and says so).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { config } from '../config.js';
import { log } from '../log.js';

const { servo } = config;

const state = {
  status: 'stopped', // stopped | starting | ready | error | disabled
  version: null,
  pid: null,
  restarts: 0,
  startedAt: null,
  lastError: null,
  lastUsedAt: null,
};

let child = null;
let starting = null;
let idleTimer = null;
let shuttingDown = false;

/**
 * Container memory ceiling. Railway (and Docker generally) sets a cgroup
 * limit; cgroup v2 uses memory.max, v1 uses memory.limit_in_bytes.
 * Returns MB, or null when unlimited/unknown.
 */
export function memoryLimitMb() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw || raw === 'max') continue;
      const bytes = Number.parseInt(raw, 10);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      if (bytes > 1024 ** 4) continue; // v1 "unlimited" sentinel
      return Math.round(bytes / 1048576);
    } catch {
      /* try the next source */
    }
  }
  const total = os.totalmem?.();
  return Number.isFinite(total) && total > 0 ? Math.round(total / 1048576) : null;
}

let memoryBlockedReason = null;

function checkMemoryHeadroom() {
  const limit = memoryLimitMb();
  if (limit !== null && limit < servo.minMemoryMb) {
    memoryBlockedReason =
      `This container is limited to ${limit} MB but fidelity mode needs ~${servo.minMemoryMb} MB at peak. ` +
      'Raise the service memory limit (Railway: Settings → Resources — 2 GB recommended), set ' +
      'APP_ENGINE=proxy to silence this, or lower SERVO_MIN_MEMORY_MB to override.';
    note('warn', memoryBlockedReason);
    return false;
  }
  return true;
}

function binaryLooksRunnable() {
  try {
    fs.accessSync(servo.bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isEnabled() {
  return servo.enabled;
}

export function isAvailable() {
  return isEnabled() && !memoryBlockedReason && binaryLooksRunnable();
}

/* ------------------------------------------------------------- render queue */
// Serialised by default: one render at a time keeps peak memory predictable.
let activeRenders = 0;
const waiting = [];

export async function withRenderSlot(fn) {
  if (activeRenders >= servo.maxConcurrent) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  activeRenders += 1;
  try {
    return await fn();
  } finally {
    activeRenders -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

export const renderQueueDepth = () => waiting.length;

export function status() {
  return {
    enabled: isEnabled(),
    available: isAvailable(),
    blockedReason: memoryBlockedReason,
    memoryLimitMb: memoryLimitMb(),
    queued: renderQueueDepth(),
    concurrent: servo.maxConcurrent,
    status: isAvailable() ? state.status : 'disabled',
    version: state.version,
    pid: state.pid,
    restarts: state.restarts,
    uptime_s: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    binary: servo.bin,
    viewport: servo.viewport,
    hint: isAvailable()
      ? null
      : memoryBlockedReason ??
        (isEnabled()
          ? 'Sidecar binary not found. Run `npm run servo:install`, or set SERVO_BIN.'
          : 'Disabled via SERVO_ENABLED=0.'),
  };
}

async function probeHealth(timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${servo.host}:${servo.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchVersion() {
  try {
    const res = await fetch(`http://${servo.host}:${servo.port}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version ?? null;
  } catch {
    return null;
  }
}

function note(level, message) {
  log[level](`[servo] ${message}`);
}

function spawnSidecar() {
  const args = ['serve', '--host', servo.host, '--port', String(servo.port)];
  note('info', `starting: ${servo.bin} ${args.join(' ')}`);

  child = spawn(servo.bin, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Servo wants a runtime dir; without it every render logs a warning.
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/tmp',
      // Keep the renderer off any GPU path; containers have none.
      LIBGL_ALWAYS_SOFTWARE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  state.pid = child.pid;
  state.startedAt = Date.now();

  const forward = (stream, level) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (text) note(level, text);
      }
    });
  };
  forward(child.stdout, 'debug');
  forward(child.stderr, 'debug');

  child.on('exit', (code, signal) => {
    const wasUnexpected = !shuttingDown && state.status === 'ready';
    child = null;
    state.pid = null;

    if (shuttingDown) {
      state.status = 'stopped';
      return;
    }

    note('warn', `sidecar exited (code=${code} signal=${signal})`);
    if (wasUnexpected && state.restarts < servo.maxRestarts) {
      state.restarts += 1;
      const delay = 1000 * state.restarts;
      state.status = 'starting';
      note('info', `restarting in ${delay}ms (attempt ${state.restarts}/${servo.maxRestarts})`);
      setTimeout(() => start().catch((err) => note('error', err.message)), delay).unref?.();
    } else {
      state.status = 'error';
      state.lastError = `exited with code ${code}`;
    }
  });

  child.on('error', (err) => {
    state.status = 'error';
    state.lastError = err.message;
    note('error', `failed to spawn: ${err.message}`);
  });
}

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    if (await probeHealth()) return true;
    if (state.status === 'error') return false;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Start (or reuse) the sidecar. Safe to call concurrently. */
export async function start() {
  if (!isAvailable()) throw new Error(status().hint ?? 'Servo sidecar unavailable');

  // Someone else may already be running one on this port (e.g. a manual run).
  if (await probeHealth(400)) {
    state.status = 'ready';
    state.version ??= await fetchVersion();
    return state;
  }

  if (starting) return starting;

  starting = (async () => {
    state.status = 'starting';
    state.lastError = null;
    spawnSidecar();

    const ready = await waitForReady(Date.now() + servo.startTimeoutMs);
    if (!ready) {
      state.status = 'error';
      state.lastError = 'timed out waiting for /health';
      note('error', state.lastError);
      throw new Error(`Servo sidecar did not become ready within ${servo.startTimeoutMs}ms`);
    }

    state.status = 'ready';
    state.version = await fetchVersion();
    note('info', `ready (v${state.version ?? '?'}, pid ${state.pid})`);
    return state;
  })().finally(() => {
    starting = null;
  });

  return starting;
}

export async function ensureRunning() {
  if (state.status === 'ready' && (await probeHealth(600))) {
    scheduleIdleShutdown();
    return state;
  }
  const result = await start();
  scheduleIdleShutdown();
  return result;
}

export function touch() {
  state.lastUsedAt = Date.now();
  scheduleIdleShutdown();
}

function scheduleIdleShutdown() {
  if (!servo.idleShutdownMs) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const idleFor = Date.now() - (state.lastUsedAt ?? 0);
    if (idleFor >= servo.idleShutdownMs) {
      note('info', `idle for ${Math.round(idleFor / 1000)}s, stopping to free RAM`);
      stop();
    } else {
      scheduleIdleShutdown();
    }
  }, servo.idleShutdownMs);
  idleTimer.unref?.();
}

export function stop() {
  shuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    child = null;
  }
  state.status = 'stopped';
  state.pid = null;
}

// Evaluate the container budget at load, so the panel can explain *why*
// fidelity mode is off before anything is rendered.
checkMemoryHeadroom();

// Re-check periodically: raising the limit should re-enable the engine.
setInterval(() => {
  const wasBlocked = Boolean(memoryBlockedReason);
  memoryBlockedReason = null;
  if (wasBlocked && checkMemoryHeadroom()) note('info', 'memory headroom now sufficient — fidelity enabled');
}, 5 * 60_000).unref?.();
