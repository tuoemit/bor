#!/usr/bin/env node
/**
 * Mobile UI test -- loads the ACTUAL panel in an emulated phone (touch,
 * 390x844, mobile UA) and verifies the phone-first experience end to end:
 *   - responsive chrome (touch targets, hidden desktop controls)
 *   - automatic phone-width page rendering (viewport preset)
 *   - tap = click (coordinate mapping), swipe = scroll, on-screen typing bar
 *   - bottom sheet open/close
 *
 *   PANEL_PASSWORD=testpass123 node scripts/mobile-ui-test.js [baseUrl]
 */
'use strict';

const fs = require('node:fs');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = process.env.PANEL_PASSWORD || 'testpass123';
const SHOTS = process.env.SHOT_DIR || '/tmp/cb-mobile-shots';

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

async function remoteEval(page, expression) {
  // Always target the tab the panel is actually displaying, so evals and taps
  // never disagree about which page is being driven.
  return page.evaluate(
    async (expr) => {
      const res = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
        body: JSON.stringify({ expression: expr, tabId: window.__cb && window.__cb.activeTab }),
      });
      return res.json();
    },
    expression
  );
}

/** Map remote-page CSS coords to panel client coords, honouring object-fit. */
async function clientPointFor(page, remoteX, remoteY) {
  return page.evaluate(([rx, ry]) => {
    const img = document.getElementById('screen');
    const box = img.getBoundingClientRect();
    // The painted bitmap is letterboxed inside the element box (object-fit).
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const paintedW = img.naturalWidth * scale;
    const paintedH = img.naturalHeight * scale;
    const offX = box.left + (box.width - paintedW) / 2;
    const offY = box.top + (box.height - paintedH) / 2;
    return {
      x: offX + (rx / img.naturalWidth) * paintedW,
      y: offY + (ry / img.naturalHeight) * paintedH,
    };
  }, [remoteX, remoteY]);
}

async function waitRemoteReady(page) {
  await page.waitForFunction(
    async () => {
      const r = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
        body: JSON.stringify({ expression: 'document.readyState' }),
      })
        .then((x) => x.json())
        .catch(() => null);
      return r && r.value === 'complete';
    },
    { timeout: 20000, polling: 400 }
  );
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ ...devices['iPhone 12'] });
  const page = await context.newPage();

  const consoleErrors = [];

  process.stdout.write(`\nMobile UI test -> ${BASE}\n\nchrome layout\n`);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('login redirects on phone', page.url().endsWith('/login'), page.url());

  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await page.waitForURL((u) => u.pathname === '/', { timeout: 15000 });

  // Track real console errors only after login (the bad-password 401 is desktop-test territory).
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  check('keyboard toggle visible on phone', await page.isVisible('#keyToggle'));
  check('desktop-only controls hidden', !(await page.isVisible('#homeBtn')) && !(await page.isVisible('#shotBtn')));
  check('side panel starts closed (bottom sheet)', await page.evaluate(() => !document.getElementById('side').classList.contains('open')));

  await page.waitForSelector('#screen[src^="blob:"]', { timeout: 30000 });
  check('screencast frame delivered on phone', true);
  await page.screenshot({ path: `${SHOTS}/01-mobile-boot.png` });

  process.stdout.write('\nphone-width rendering\n');

  await page.waitForFunction(
    async () => {
      const r = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
        body: JSON.stringify({ expression: 'window.innerWidth' }),
      })
        .then((x) => x.json())
        .catch(() => null);
      return r && r.value === 412;
    },
    { timeout: 20000, polling: 500 }
  );
  check('remote page auto-rendered at phone width (412px)', true);
  const vpIcon = await page.textContent('#vpBtn');
  check('viewport button flipped to desktop icon', /🖥/.test(vpIcon), vpIcon);

  process.stdout.write('\ntap = click\n');

  // Start from a known page (the server may still hold tabs from earlier runs).
  await page.fill('#urlInput', 'https://example.com');
  await page.press('#urlInput', 'Enter');
  await page.waitForFunction(() => /example\.com/.test(document.getElementById('urlInput').value), { timeout: 20000 });
  await page.waitForTimeout(2000);

  // example.com has a single "More information..." link. Retry the tap; touch
  // synthesis under emulation is occasionally swallowed.
  const linkRect = await remoteEval(page, "(() => { const a = document.querySelector('a'); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  check('remote link located', Boolean(linkRect && linkRect.ok), JSON.stringify(linkRect).slice(0, 120));
  let navigated = false;
  for (let i = 0; i < 4 && !navigated; i += 1) {
    const pt = await clientPointFor(page, linkRect.value.x, linkRect.value.y);
    await page.touchscreen.tap(pt.x, pt.y);
    try {
      await page.waitForFunction(
        async () => {
          const r = await fetch('/api/eval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
            body: JSON.stringify({ expression: 'location.href', tabId: window.__cb && window.__cb.activeTab }),
          })
            .then((x) => x.json())
            .catch(() => null);
          return r && /iana\.org/.test(String(r.value));
        },
        { timeout: 4000, polling: 400 }
      );
      navigated = true;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  check('tap on the stream clicked the remote link (navigated)', navigated);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/02-mobile-tapped.png` });

  process.stdout.write('\nswipe = scroll\n');

  await waitRemoteReady(page);

  await page.evaluate(() => {
    window.__swipe = async () => {
      const el = document.getElementById('screen');
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const fromY = rect.top + rect.height * 0.7;
      const toY = rect.top + rect.height * 0.25;
      const mk = (type, y, touches) => {
        const list = touches.map(
          ([x, yy]) => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy })
        );
        return new TouchEvent(type, {
          touches: list,
          changedTouches: list,
          targetTouches: list,
          bubbles: true,
          cancelable: true,
        });
      };
      el.dispatchEvent(mk('touchstart', fromY, [[cx, fromY]]));
      const steps = 10;
      for (let i = 1; i <= steps; i += 1) {
        const y = fromY + ((toY - fromY) * i) / steps;
        el.dispatchEvent(mk('touchmove', y, [[cx, y]]));
        await new Promise((r) => setTimeout(r, 45));
      }
      el.dispatchEvent(mk('touchend', toY, []));
    };
  });
  await page.evaluate(() => window.__swipe());
  await page.waitForTimeout(1200);
  const scrollY = await remoteEval(page, 'window.scrollY');
  check('swipe scrolled the remote page', Boolean(scrollY && scrollY.value > 50), `scrollY=${scrollY && scrollY.value}`);
  await page.screenshot({ path: `${SHOTS}/03-mobile-scrolled.png` });

  process.stdout.write('\non-screen typing bar\n');

  await page.fill('#urlInput', 'https://the-internet.herokuapp.com/login');
  await page.press('#urlInput', 'Enter');
  // Wait until the remote page actually has the login form (URL bar updates
  // instantly on go(), so it does not prove navigation completed).
  await page.waitForFunction(
    async () => {
      const r = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
        body: JSON.stringify({ expression: "Boolean(document.querySelector('#username'))" }),
      })
        .then((x) => x.json())
        .catch(() => null);
      return r && r.value === true;
    },
    { timeout: 30000, polling: 500 }
  );
  await waitRemoteReady(page);

  // Tap the remote #username to focus it; auto-raise of the bar is a bonus.
  const userRect = await remoteEval(page, "(() => { const a = document.querySelector('#username'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  if (userRect && userRect.value) {
    const upt = await clientPointFor(page, userRect.value.x, userRect.value.y);
    await page.touchscreen.tap(upt.x, upt.y);
    await page.waitForTimeout(1200);
    const focused = await remoteEval(page, "document.activeElement.tagName + '#' + (document.activeElement.id || '')");
    check('tap focused the remote field', /INPUT#username/.test(String(focused.value)), JSON.stringify(focused));
    const autoRaised = await page.evaluate(() => document.getElementById('keybar').classList.contains('show'));
    process.stdout.write(`  (info) typing bar auto-raised on field tap: ${autoRaised ? 'yes' : 'no (use the ⌨ button)'}\n`);
  }

  // Deterministic path: open the bar via ⌨, focus the panel input, then focus
  // the remote field as the LAST step so nothing blurs it before we type.
  if (!(await page.evaluate(() => document.getElementById('keybar').classList.contains('show')))) {
    await page.click('#keyToggle');
  }
  await page.waitForSelector('#keybar.show', { timeout: 5000 });
  check('typing bar opens from the ⌨ button', true);

  await page.click('#keyInput'); // focus the bar like a real user
  await page.evaluate(() => document.getElementById('keyInput').focus());
  // Focus the remote field with a deterministic server-side click (touch-tap
  // focus is flaky under emulation; /api/click is the same code path a real
  // tap drives, minus the synthesis).
  if (userRect && userRect.value) {
    await page.evaluate(
      (c) =>
        fetch('/api/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
          body: JSON.stringify({ x: c.x, y: c.y, tabId: window.__cb && window.__cb.activeTab }),
        }),
      userRect.value
    );
    await page.waitForTimeout(600);
  }
  await page.keyboard.type('tomsmith', { delay: 30 });
  await page.waitForTimeout(1200);
  // The keybar's job is to forward keystrokes to the engine; engine-side typing
  // is asserted deterministically in the REST smoke test.
  const diag = await page.evaluate(() => ({ keys: window.__cb.keysSent }));
  check('typing bar forwards keystrokes to the engine', diag.keys >= 8, `keysSent=${diag.keys}`);
  await page.screenshot({ path: `${SHOTS}/04-mobile-keyboard.png` });

  await page.click('#keyBack');
  await page.waitForTimeout(500);
  const afterBack = await page.evaluate(() => ({ keys: window.__cb.keysSent }));
  check('backspace button sends a Backspace to the engine', afterBack.keys >= diag.keys + 1, `keysSent=${afterBack.keys}`);
  await page.click('#keyHide');
  check('typing bar hides', await page.evaluate(() => !document.getElementById('keybar').classList.contains('show')));

  process.stdout.write('\nbottom sheet\n');

  await page.click('#sideToggle');
  await page.waitForSelector('#side.open', { timeout: 5000 });
  check('menu opens the bottom sheet', true);
  check('backdrop shown', await page.evaluate(() => document.getElementById('backdrop').classList.contains('show')));
  await page.click('button[data-pane="session"]');
  check('session pane visible in sheet', await page.isVisible('#mSessionSelect'));
  await page.screenshot({ path: `${SHOTS}/05-mobile-sheet.png` });
  await page.click('#backdrop', { position: { x: 10, y: 40 } });
  await page.waitForFunction(() => !document.getElementById('side').classList.contains('open'), { timeout: 5000 });
  check('backdrop tap closes the sheet', true);

  check('no uncaught JS errors on phone', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));

  await page.screenshot({ path: `${SHOTS}/06-mobile-final.png` });
  await browser.close();

  process.stdout.write(`\n${pass} passed, ${fail} failed\nscreenshots in ${SHOTS}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  process.stderr.write(`\nMobile UI test crashed: ${e.stack || e}\n`);
  process.exit(2);
});
