#!/usr/bin/env node
/**
 * End-to-end smoke test against a *running* instance.
 *
 *   PANEL_PASSWORD=... node scripts/smoke-test.js [baseUrl]
 *
 * Exercises: auth (good/bad/rate-limit), CSRF, the REST API, the screencast
 * WebSocket (frame + input round trip) and the script runner.
 */
'use strict';

const http = require('node:http');
const { WebSocket } = require('ws');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = process.env.PANEL_PASSWORD || 'testpass123';
const url = new URL(BASE);

let cookie = null;
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    fail += 1;
    failures.push(name);
    process.stdout.write(`  \u2717 ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
}

function request(method, path, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            const next = setCookie.map((c) => c.split(';')[0]).join('; ');
            if (next && !next.includes('cb_session=;')) cookie = next;
          }
          let json = null;
          if (!raw) {
            try {
              json = JSON.parse(buf.toString());
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode, body: raw ? buf : json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PANEL = { 'X-Requested-With': 'panel' };

(async () => {
  process.stdout.write(`\ncloud-browser smoke test -> ${BASE}\n\n`);

  /* ------------------------------ auth ----------------------------- */
  process.stdout.write('auth\n');

  let r = await request('GET', '/healthz');
  check('GET /healthz is public', r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r.body));
  check('engine is firefox (not chromium)', r.body && r.body.engine === 'firefox', r.body && r.body.engine);

  r = await request('GET', '/api/tabs');
  check('GET /api/tabs unauthenticated -> 401 JSON', r.status === 401 && r.body && r.body.error === 'unauthorized', `${r.status}`);

  r = await request('POST', '/api/auth/login', { body: { password: 'definitely-wrong' }, headers: PANEL });
  check('wrong password -> 401', r.status === 401 && r.body.error === 'invalid_password', `${r.status} ${JSON.stringify(r.body)}`);

  r = await request('POST', '/api/auth/login', { body: { password: 'definitely-wrong' } });
  check('login without X-Requested-With -> 403 csrf', r.status === 403 && r.body.error === 'csrf', `${r.status} ${JSON.stringify(r.body)}`);

  r = await request('POST', '/api/auth/login', { body: { password: PASSWORD }, headers: PANEL });
  check('correct password -> 200 + cookie', r.status === 200 && Boolean(cookie), `${r.status} cookie=${cookie}`);

  r = await request('GET', '/api/auth/me');
  check('GET /api/auth/me authenticated', r.status === 200 && r.body.authenticated === true, JSON.stringify(r.body));

  r = await request('GET', '/');
  check('GET / authenticated -> 200 html', r.status === 200, `${r.status}`);

  /* ---------------------------- browser ---------------------------- */
  process.stdout.write('\nbrowser\n');

  r = await request('GET', '/api/health');
  check('engine ready', r.body && r.body.engineReady === true, JSON.stringify(r.body));
  check('firefox version reported', Boolean(r.body && r.body.version), r.body && r.body.version);

  r = await request('POST', '/api/tabs', { body: { url: 'https://example.com' }, headers: PANEL });
  check('POST /api/tabs creates a tab', r.status === 201 && r.body && r.body.id, `${r.status} ${JSON.stringify(r.body)}`);
  const tabId = r.body && r.body.id;
  check('tab navigated to example.com', /example\.com/.test((r.body && r.body.url) || ''), r.body && r.body.url);
  check('tab has a title', Boolean(r.body && r.body.title), r.body && r.body.title);

  r = await request('POST', '/api/navigate', { body: { url: 'https://httpbin.org/html', tabId }, headers: PANEL });
  check('POST /api/navigate', r.status === 200 && /httpbin/.test(r.body.url || ''), JSON.stringify(r.body && r.body.url));

  r = await request('GET', `/api/screenshot?tabId=${tabId}`, { raw: true });
  check('GET /api/screenshot returns a JPEG', r.status === 200 && r.body.length > 3000 && r.body[0] === 0xff && r.body[1] === 0xd8, `status=${r.status} bytes=${r.body.length}`);
  process.stdout.write(`      (screenshot: ${r.body.length} bytes)\n`);

  r = await request('GET', `/api/content?tabId=${tabId}`);
  check('GET /api/content extracts text', r.status === 200 && (r.body.text || '').length > 100, `text length ${r.body && r.body.text ? r.body.text.length : 0}`);
  check('GET /api/content reports an empty title faithfully (httpbin/html has no <title>)', r.status === 200 && r.body.title === '', JSON.stringify(r.body && r.body.title));

  // Title extraction needs a page that actually has one.
  await request('POST', '/api/navigate', { body: { url: 'https://example.com', tabId }, headers: PANEL });
  r = await request('GET', `/api/content?tabId=${tabId}`);
  check('GET /api/content extracts title when present', r.status === 200 && r.body.title === 'Example Domain', JSON.stringify(r.body && r.body.title));
  check('GET /api/content extracts meta + links', r.status === 200 && Array.isArray(r.body.links), `links=${r.body && r.body.links && r.body.links.length}`);

  r = await request('POST', '/api/eval', { body: { expression: 'navigator.userAgent', tabId }, headers: PANEL });
  check('POST /api/eval runs JS in the page', r.status === 200 && r.body.ok === true && /Firefox/.test(String(r.body.value)), JSON.stringify(r.body));
  process.stdout.write(`      (page UA: ${r.body && r.body.value})\n`);

  /* --------------------------- interaction ------------------------- */
  process.stdout.write('\ninteraction\n');

  r = await request('POST', '/api/navigate', { body: { url: 'https://the-internet.herokuapp.com/login', tabId }, headers: PANEL });
  check('navigate to a form page', r.status === 200, `${r.status}`);

  r = await request('POST', '/api/fill', { body: { selector: '#username', value: 'tomsmith', tabId }, headers: PANEL });
  check('POST /api/fill (selector)', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  r = await request('POST', '/api/fill', { body: { selector: '#password', value: 'SuperSecretPassword!', tabId }, headers: PANEL });
  check('POST /api/fill password', r.status === 200, `${r.status}`);

  r = await request('POST', '/api/click', { body: { selector: 'button[type="submit"]', tabId }, headers: PANEL });
  check('POST /api/click (selector)', r.status === 200, JSON.stringify(r.body));

  r = await request('GET', `/api/content?tabId=${tabId}&textLimit=2000`);
  check('login succeeded (page says "You logged into a secure area")', /logged into a secure area/i.test(r.body.text || ''), (r.body.text || '').slice(0, 80));

  r = await request('POST', '/api/click', { body: { x: 10, y: 10, tabId }, headers: PANEL });
  check('POST /api/click (coordinates)', r.status === 200, `${r.status}`);

  // Deterministic engine-side typing: focus a field via click, then type/backspace.
  r = await request('POST', '/api/navigate', { body: { url: 'https://the-internet.herokuapp.com/login', tabId }, headers: PANEL });
  check('re-navigate to form for typing check', r.status === 200, `${r.status}`);

  r = await request('POST', '/api/click', { body: { selector: '#username', tabId }, headers: PANEL });
  check('POST /api/click (selector focus)', r.status === 200, `${r.status}`);

  r = await request('POST', '/api/type', { body: { text: 'tomsmith', tabId }, headers: PANEL });
  check('POST /api/type ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  r = await request('POST', '/api/eval', { body: { expression: "document.querySelector('#username').value", tabId }, headers: PANEL });
  check('typed text landed in the field', r.body && r.body.value === 'tomsmith', JSON.stringify(r.body && r.body.value));

  r = await request('POST', '/api/press', { body: { key: 'Backspace', tabId }, headers: PANEL });
  r = await request('POST', '/api/eval', { body: { expression: "document.querySelector('#username').value", tabId }, headers: PANEL });
  check('Backspace edits the field', r.body && r.body.value === 'tomsmit', JSON.stringify(r.body && r.body.value));

  /* --------------------------- automation -------------------------- */
  process.stdout.write('\nautomation\n');

  r = await request('GET', '/api/actions');
  check('GET /api/actions lists primitives', r.status === 200 && r.body.actions.includes('goto') && r.body.actions.includes('screenshot'), JSON.stringify(r.body && r.body.actions && r.body.actions.length));

  r = await request('POST', '/api/script', {
    body: {
      tabId,
      steps: [
        { do: 'goto', url: 'https://news.ycombinator.com' },
        { do: 'waitForLoad' },
        { do: 'eval', expression: 'Array.from(document.querySelectorAll(".titleline > a")).slice(0,3).map(a=>a.textContent)' },
        { do: 'screenshot', name: 'smoke', fullPage: false },
      ],
    },
    headers: PANEL,
  });
  check('POST /api/script runs a multi-step script', r.status === 200 && r.body.ok === true, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const evalStep = r.body && r.body.results && r.body.results.find((x) => x.do === 'eval');
  check('script returned scraped data', Boolean(evalStep && evalStep.result && evalStep.result.ok), JSON.stringify(evalStep && evalStep.result || null).slice(0, 160));
  const shotStep = r.body && r.body.artifacts && r.body.artifacts[0];
  check('script wrote a screenshot artifact', Boolean(shotStep && shotStep.bytes > 3000), JSON.stringify(shotStep));

  r = await request('POST', '/api/script', { body: { tabId, steps: [{ do: 'goto', url: 'https://nonexistent.invalid-domain-xyz.test' }] }, headers: PANEL });
  check('failing step is reported, not swallowed', r.status === 422 && r.body.ok === false && r.body.results[0].ok === false, `${r.status}`);

  /* ---------------------------- sessions --------------------------- */
  process.stdout.write('\nsessions\n');

  r = await request('GET', '/api/status');
  const activeSession = (r.body && r.body.activeSessionId) || 'default';
  r = await request('POST', `/api/sessions/${encodeURIComponent(activeSession)}/save`, { headers: PANEL });
  check('session cookies persisted to disk', r.status === 200 && typeof r.body.cookies === 'number', `${r.status} ${JSON.stringify(r.body)}`);
  process.stdout.write(`      (${r.body && r.body.cookies} cookies / ${r.body && r.body.origins} origins for "${r.body && r.body.id}")\n`);

  r = await request('GET', '/api/sessions');
  check('GET /api/sessions lists profiles', r.status === 200 && Array.isArray(r.body.sessions), JSON.stringify(r.body).slice(0, 160));

  /* ---------------------------- websocket -------------------------- */
  process.stdout.write('\nwebsocket screencast\n');

  await new Promise((resolve) => {
    const wsBase = BASE.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: cookie } });
    let gotHello = false;
    let gotFrame = false;
    let gotState = false;
    let frameBytes = 0;
    const timer = setTimeout(() => finish('timeout'), 25000);

    function finish(reason) {
      clearTimeout(timer);
      check('ws hello received', gotHello);
      check('ws frame received (binary JPEG)', gotFrame && frameBytes > 3000, `bytes=${frameBytes}`);
      check('ws state received', gotState);
      process.stdout.write(`      (${reason}; first frame ${frameBytes} bytes)\n`);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', tabId }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        gotFrame = true;
        frameBytes = data.length;
        // Once we have a frame, prove input round-trips too.
        if (!ws.sentInput) {
          ws.sentInput = true;
          ws.send(JSON.stringify({ type: 'input', event: { type: 'mouse.move', x: 200, y: 200 } }));
          ws.send(JSON.stringify({ type: 'input', event: { type: 'scroll', deltaY: 120 } }));
          ws.send(JSON.stringify({ type: 'input', event: { type: 'key.type', text: 'q' } }));
          ws.send(JSON.stringify({ type: 'state' }));
          setTimeout(() => finish('done'), 3000);
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') gotHello = true;
      if (msg.type === 'state') gotState = true;
      if (msg.type === 'error') process.stdout.write(`      ws error: ${msg.code} ${msg.message}\n`);
    });
    ws.on('error', (e) => finish(`error: ${e.message}`));
  });

  /* ---------------------------- api token -------------------------- */
  process.stdout.write('\nmisc\n');

  const savedCookie = cookie;
  cookie = null;
  r = await request('GET', '/api/tabs');
  check('no cookie, no token -> 401', r.status === 401, `${r.status}`);
  cookie = savedCookie;

  r = await request('GET', '/api/status');
  check('GET /api/status reports memory + limits', r.status === 200 && r.body.memory && r.body.limits, JSON.stringify(r.body && r.body.limits));
  process.stdout.write(`      (rss ${Math.round(r.body.memory.rss / 1048576)} MB, ${r.body.tabs.length} tab(s), engine ${r.body.engine} ${r.body.version})\n`);

  r = await request('GET', '/api/nope');
  check('unknown API route -> 404 JSON', r.status === 404 && r.body.error === 'not_found', `${r.status}`);

  /* ------------------------------ done ----------------------------- */
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  if (fail) {
    process.stdout.write(`failed: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`\nsmoke test crashed: ${e.stack || e}\n`);
  process.exit(2);
});
