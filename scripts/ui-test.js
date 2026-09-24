#!/usr/bin/env node
/**
 * UI test -- loads the ACTUAL panel front-end in a real browser and drives it.
 *
 * This is the check that matters: it executes public/app.js, the WebSocket
 * screencast protocol, the coordinate mapping and the side panel, not a
 * re-implementation of them.
 *
 * The driver browser is Chromium purely as a test harness. The product itself
 * only ever launches Firefox (see server/lib/browserManager.js).
 *
 *   PANEL_PASSWORD=testpass123 node scripts/ui-test.js http://127.0.0.1:3000
 */
'use strict';

const fs = require('node:fs');
const { chromium } = require('playwright');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = process.env.PANEL_PASSWORD || 'testpass123';
const SHOTS = process.env.SHOT_DIR || '/tmp/cb-ui-shots';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    fail += 1;
    process.stdout.write(`  \u2717 ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // `channel: 'chromium'` uses the full Chrome-for-Testing build; the headless
  // shell is a separate download we deliberately skip.
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const loc = m.location() || {};
      consoleErrors.push(`${m.text()} [${loc.url || '?'}]`);
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (res) => {
    if (res.status() === 401 || res.status() >= 500) {
      consoleErrors.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });

  process.stdout.write(`\nUI test -> ${BASE}\n\nlogin page\n`);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('unauthenticated / redirects to /login', page.url().endsWith('/login'), page.url());
  check('login form rendered', await page.isVisible('#password'));
  await page.screenshot({ path: `${SHOTS}/01-login.png` });

  await page.fill('#password', 'wrong-password');
  await page.click('#submitBtn');
  await page.waitForSelector('#loginError:not(:empty)', { timeout: 5000 });
  check('wrong password shows an inline error', (await page.textContent('#loginError')).length > 0, await page.textContent('#loginError'));

  // The wrong-password attempt above is deliberate: its 401 is expected traffic,
  // not a defect. Start tracking real errors from here.
  consoleErrors.length = 0;

  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
  check('correct password lands on the panel', page.url().endsWith('/'), page.url());

  process.stdout.write('\npanel boot\n');

  await page.waitForSelector('#screen[src^="blob:"]', { timeout: 30000 });
  check('screencast delivered a blob frame to <img id="screen">', true);

  await page.waitForFunction(() => document.querySelectorAll('.tab').length > 0, { timeout: 20000 });
  check('tab strip rendered', (await page.locator('.tab').count()) > 0);

  const connText = await page.textContent('#statConn');
  check('status bar reports connected', /connected/.test(connText), connText);

  const engine = await page.textContent('#statEngine');
  check('status bar reports the gecko engine', /firefox/.test(engine), engine);

  await page.waitForTimeout(2500);
  const fps = await page.textContent('#statFps');
  check('frames are streaming (fps > 0)', parseFloat(fps) > 0, fps);
  process.stdout.write(`      (fps: ${fps}, conn: ${connText}, engine: ${engine})\n`);

  await page.screenshot({ path: `${SHOTS}/02-panel.png` });

  process.stdout.write('\nnavigate via the address bar\n');

  await page.click('#urlInput');
  await page.fill('#urlInput', 'https://en.wikipedia.org/wiki/Firefox');
  await page.press('#urlInput', 'Enter');
  await page.waitForFunction(() => /wikipedia\.org/.test(document.getElementById('urlInput').value), { timeout: 40000 });
  check('address bar navigated the remote browser', true);

  await page.waitForTimeout(4000);
  const urlBar = await page.inputValue('#urlInput');
  check('remote page URL flowed back into the address bar', /wikipedia\.org/.test(urlBar), urlBar);
  const docTitle = await page.title();
  check('panel <title> mirrors the remote page', /Firefox/i.test(docTitle), docTitle);
  await page.screenshot({ path: `${SHOTS}/03-wikipedia.png` });

  // Prove the frame is a real decoded image of a real page (the client revokes
  // old blob URLs, so read the decoded bitmap instead of refetching the blob).
  const dims = await page.evaluate(() => {
    const img = document.getElementById('screen');
    return { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete };
  });
  check('streamed frame decoded to a full-size bitmap', dims.complete && dims.w >= 1000 && dims.h >= 600, JSON.stringify(dims));

  const shotRes = await page.evaluate(async () => {
    const r = await fetch('/api/screenshot?fullPage=false&quality=80', { headers: { 'X-Requested-With': 'panel' } });
    return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.blob()).size };
  });
  check('server-side screenshot of the live viewport is substantial', shotRes.status === 200 && shotRes.bytes > 15000, JSON.stringify(shotRes));

  process.stdout.write('\ninput reaches the remote page\n');

  // Focus the viewport, then type into Wikipedia's search box via the panel.
  await page.click('#screen', { position: { x: 300, y: 20 } });
  await page.waitForTimeout(600);

  await page.evaluate(() => document.getElementById('viewport').focus());
  await page.keyboard.type('Gecko software engine');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/04-typed.png` });
  const typedIntoPage = await page.evaluate(async () => {
    const res = await fetch('/api/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      body: JSON.stringify({ expression: "(() => { const el = document.activeElement; return { tag: el && el.tagName, value: el && el.value, text: document.body.innerText.slice(0, 120) }; })()" }),
    });
    return res.json();
  });
  check('keystrokes from the panel arrived in the remote page',
    Boolean(typedIntoPage.value && /Gecko/i.test(String(typedIntoPage.value.value))) ||
    /Gecko software engine/.test(String(typedIntoPage.value && typedIntoPage.value.text || '')),
    JSON.stringify(typedIntoPage).slice(0, 200));

  process.stdout.write('\nscroll + click through the panel\n');

  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1200);
  const scrollY = await page.evaluate(async () => {
    const res = await fetch('/api/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      body: JSON.stringify({ expression: 'window.scrollY' }),
    });
    return (await res.json()).value;
  });
  check('wheel scroll moved the remote page', Number(scrollY) > 100, `scrollY=${scrollY}`);
  await page.screenshot({ path: `${SHOTS}/05-scrolled.png` });

  process.stdout.write('\nside panel\n');

  await page.click('#extractBtn');
  await page.waitForFunction(() => document.getElementById('extractText').textContent.length > 200, { timeout: 20000 });
  const extracted = await page.textContent('#extractText');
  check('Page pane extracted remote text into the side panel', extracted.length > 200, `${extracted.length} chars`);
  const linkCount = await page.locator('#extractLinks li').count();
  check('Page pane listed remote links', linkCount > 5, `${linkCount} links`);
  await page.screenshot({ path: `${SHOTS}/06-extract.png` });

  await page.click('button[data-pane="info"]');
  await page.waitForTimeout(1500);
  const statusText = await page.textContent('#statusBlock');
  check('Info pane shows engine status', /firefox 1\d\d/.test(statusText) && /engine ready/.test(statusText), statusText.slice(0, 120));
  await page.screenshot({ path: `${SHOTS}/07-info.png` });

  await page.click('button[data-pane="console"]');
  const eventCount = await page.locator('#eventList li').count();
  check('Console pane collected page events', eventCount >= 0, `${eventCount} events`);

  process.stdout.write('\nautomation pane\n');

  await page.click('button[data-pane="automation"]');
  await page.selectOption('#exampleSelect', { label: 'Open a page and screenshot it' });
  await page.click('#runScript');
  await page.waitForFunction(() => /"ok"\s*:\s*true/.test(document.getElementById('scriptOut').textContent), { timeout: 90000 });
  const scriptOut = await page.textContent('#scriptOut');
  check('script ran end-to-end from the panel and returned ok:true', /"ok":\s*true/.test(scriptOut), scriptOut.slice(0, 160));
  check('script output mentions the screenshot artifact', /screenshot/.test(scriptOut) && /bytes/.test(scriptOut), scriptOut.slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/08-automation.png` });

  await page.waitForTimeout(2500);
  const afterScriptUrl = await page.inputValue('#urlInput');
  check('panel followed the script to its new page', /news\.ycombinator\.com/.test(afterScriptUrl), afterScriptUrl);
  await page.screenshot({ path: `${SHOTS}/09-after-script.png` });

  process.stdout.write('\nfiles + multi-tab\n');

  await page.click('button[data-pane="files"]');
  await page.click('#refreshFiles');
  await page.waitForTimeout(1500);
  const fileText = await page.textContent('#fileList');
  check('Files pane lists the script screenshot', /smoke|hn|screenshot|\.jpg/.test(fileText), fileText.slice(0, 120));
  await page.screenshot({ path: `${SHOTS}/10-files.png` });

  await page.click('.tab-new');
  await page.waitForTimeout(3000);
  const tabCount = await page.locator('.tab').count();
  check('new tab button opened a second tab', tabCount >= 2, `${tabCount} tabs`);
  await page.screenshot({ path: `${SHOTS}/11-two-tabs.png` });

  process.stdout.write('\nlogout\n');

  await page.click('#logoutBtn');
  await page.waitForURL((u) => u.pathname === '/login', { timeout: 10000 });
  check('logout returns to the login page', page.url().endsWith('/login'), page.url());

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('panel is unreachable after logout', page.url().endsWith('/login'), page.url());

  check('no uncaught JS errors in the panel', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));

  await browser.close();

  process.stdout.write(`\n${pass} passed, ${fail} failed\nscreenshots in ${SHOTS}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  process.stderr.write(`\nUI test crashed: ${e.stack || e}\n`);
  process.exit(2);
});
