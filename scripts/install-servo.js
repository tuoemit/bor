#!/usr/bin/env node
/**
 * Downloads the servo-fetch sidecar binary into ./bin so `npm run fidelity`
 * works locally without a Rust toolchain.
 *
 *   node scripts/install-servo.js            # current platform
 *   SERVO_FETCH_VERSION=0.15.1 node scripts/install-servo.js
 *
 * The Docker image does the same thing in a build stage (see Dockerfile).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const VERSION = process.env.SERVO_FETCH_VERSION || '0.15.1';
const REPO = 'konippi/servo-fetch';

const TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`No servo-fetch build for ${key}. Supported: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const isWindows = process.platform === 'win32';
const ext = isWindows ? 'zip' : 'tar.gz';
const asset = `servo-fetch-v${VERSION}-${target}.${ext}`;
const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${asset}`;

const binDir = path.join(process.cwd(), 'bin');
const outName = isWindows ? 'servo-fetch.exe' : 'servo-fetch';
const outPath = path.join(binDir, outName);

fs.mkdirSync(binDir, { recursive: true });
const tmp = path.join(os.tmpdir(), asset);

console.log(`Downloading ${asset} …`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status} for ${url}`);
  process.exit(1);
}
fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
console.log(`  ${(fs.statSync(tmp).size / 1048576).toFixed(1)} MB`);

console.log(`Extracting to ${binDir} …`);
if (isWindows) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${tmp}" -DestinationPath "${binDir}"`]);
} else {
  execFileSync('tar', ['xzf', tmp, '-C', binDir, '--strip-components=1']);
}
fs.chmodSync(outPath, 0o755);

if (!fs.existsSync(outPath)) {
  // Some archives nest the binary; find it and move it up.
  const nested = execFileSync('find', [binDir, '-name', outName, '-type', 'f']).toString().trim().split('\n')[0];
  if (nested) fs.renameSync(nested, outPath);
}

const size = fs.statSync(outPath).size / 1048576;
console.log(`\n✓ ${outPath} (${size.toFixed(0)} MB)`);
console.log('\nServo renders with a real engine and paints pixels, but it costs');
console.log('~220 MB RSS idle and up to ~400 MB peak per heavy page. Use it as a');
console.log('fidelity fallback, not as the main engine, and only on a paid tier.');
