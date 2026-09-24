#!/usr/bin/env node
/**
 * postinstall hook.
 *
 * Makes `npm install` on Render / Railway produce a *runnable* image:
 *   - skips browser download when the base image already ships the browser
 *     (mcr.microsoft.com/playwright:v<version>-jammy) by honouring
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
 *   - otherwise downloads the Firefox (Gecko) build only -- never Chromium
 *   - never fails the build if the network is unavailable and a browser is
 *     already present; the server degrades to a clear 503 instead
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function log(msg) {
  process.stdout.write(`[postinstall] ${msg}\n`);
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  log('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -> assuming the browser ships with the base image.');
  process.exit(0);
}

// Resolve the playwright CLI that was just installed alongside us.
const cli = path.join(__dirname, '..', 'node_modules', 'playwright-core', 'cli.js');
if (!fs.existsSync(cli)) {
  log('playwright-core not found, skipping browser download.');
  process.exit(0);
}

const args = [cli, 'install', 'firefox'];
if (process.env.PLAYWRIGHT_INSTALL_DEPS === '1') args.push('--with-deps');

log(`running: node ${args.join(' ')}`);
const res = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (res.status !== 0) {
  // Do not break `npm ci` on platforms that install browsers in a separate step.
  log(`WARNING: browser install exited with code ${res.status}. ` +
      'The app will start but /api/health will report the engine as unavailable.');
}
process.exit(0);
