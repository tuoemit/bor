'use strict';

/**
 * REST API -- the machine-facing half of the panel.
 *
 * Everything the UI can do is available here, so the browser can be driven by
 * cron jobs, GitHub Actions, another backend, or a one-off curl.
 *
 * Auth: either the panel cookie (browser) or `Authorization: Bearer $API_TOKEN`.
 */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');
const { manager, HttpError, normaliseUrl } = require('../lib/browserManager');
const { runScript, ACTIONS } = require('../lib/scriptRunner');
const { hub } = require('../lib/screencast');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------ meta ------------------------------- */

router.get(
  '/health',
  wrap(async (req, res) => {
    res.json({
      ok: true,
      engine: config.engine,
      engineReady: manager.ready,
      version: manager.ready ? manager.browser.version() : null,
      launchError: manager.launchError,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      tabs: manager.tabs.size,
      streaming: hub.stats(),
      timestamp: new Date().toISOString(),
    });
  })
);

router.get(
  '/status',
  wrap(async (req, res) => {
    res.json(manager.status());
  })
);

/* ------------------------------ tabs ------------------------------- */

router.get(
  '/tabs',
  wrap(async (req, res) => {
    res.json({
      activeTabId: manager.activeTabId,
      activeSessionId: manager.activeSessionId,
      tabs: [...manager.tabs.values()].map((t) => t.info()),
    });
  })
);

router.post(
  '/tabs',
  wrap(async (req, res) => {
    const { url, sessionId } = req.body || {};
    const tab = await manager.createTab({ sessionId });
    if (url) await tab.navigate(normaliseUrl(url)).catch(() => {});
    res.status(201).json(tab.info());
  })
);

router.get(
  '/tabs/:tabId',
  wrap(async (req, res) => {
    const tab = manager.getTab(req.params.tabId);
    await tab.refreshMeta();
    res.json(tab.info());
  })
);

router.post(
  '/tabs/:tabId/active',
  wrap(async (req, res) => {
    const tab = manager.setActive(req.params.tabId);
    res.json({ activeTabId: tab.id, tab: tab.info() });
  })
);

router.delete(
  '/tabs/:tabId',
  wrap(async (req, res) => {
    const ok = await manager.closeTab(req.params.tabId);
    res.json({ closed: ok, activeTabId: manager.activeTabId });
  })
);

/* ---------------------------- navigation --------------------------- */

router.post(
  '/navigate',
  wrap(async (req, res) => {
    const { url, tabId, waitUntil } = req.body || {};
    if (!url) throw new HttpError(400, 'bad_request', 'url is required.');
    const tab = manager.getTab(tabId);
    const result = await tab.navigate(normaliseUrl(url), { waitUntil });
    hub.broadcast(tab.id, { type: 'state', tab: tab.info() });
    res.json({ ...result, tab: tab.info() });
  })
);

router.post(
  '/back',
  wrap(async (req, res) => {
    const tab = manager.getTab((req.body || {}).tabId);
    await tab.page.goBack({ timeout: config.navTimeoutMs }).catch(() => {});
    await tab.refreshMeta();
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/forward',
  wrap(async (req, res) => {
    const tab = manager.getTab((req.body || {}).tabId);
    await tab.page.goForward({ timeout: config.navTimeoutMs }).catch(() => {});
    await tab.refreshMeta();
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/reload',
  wrap(async (req, res) => {
    const tab = manager.getTab((req.body || {}).tabId);
    await tab.page.reload({ timeout: config.navTimeoutMs }).catch(() => {});
    await tab.refreshMeta();
    res.json({ ok: true, tab: tab.info() });
  })
);

/* ----------------------------- interaction ------------------------- */

router.post(
  '/click',
  wrap(async (req, res) => {
    const { x, y, tabId, button, clickCount, selector } = req.body || {};
    const tab = manager.getTab(tabId);
    if (selector) {
      await tab.page.locator(selector).first().click({ timeout: config.actionTimeoutMs });
    } else {
      if (x === undefined || y === undefined) {
        throw new HttpError(400, 'bad_request', 'Provide x and y (CSS pixels), or a selector.');
      }
      await tab.clickAt(x, y, { button, clickCount });
    }
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/type',
  wrap(async (req, res) => {
    const { text, tabId, delay, selector } = req.body || {};
    const tab = manager.getTab(tabId);
    if (selector) await tab.page.locator(selector).first().click({ timeout: config.actionTimeoutMs }).catch(() => {});
    await tab.typeText(text ?? '', { delay });
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/fill',
  wrap(async (req, res) => {
    const { selector, value, tabId } = req.body || {};
    if (!selector) throw new HttpError(400, 'bad_request', 'selector is required.');
    const tab = manager.getTab(tabId);
    await tab.page.locator(selector).first().fill(String(value ?? ''), { timeout: config.actionTimeoutMs });
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/press',
  wrap(async (req, res) => {
    const { key, tabId } = req.body || {};
    if (!key) throw new HttpError(400, 'bad_request', 'key is required (e.g. "Enter", "Control+a").');
    const tab = manager.getTab(tabId);
    await tab.pressKey(String(key));
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/scroll',
  wrap(async (req, res) => {
    const { x, y, deltaX, deltaY, tabId } = req.body || {};
    const tab = manager.getTab(tabId);
    if (x !== undefined || y !== undefined) await tab.scrollTo(x, y);
    else await tab.scrollBy(deltaX || 0, deltaY || 0);
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/hover',
  wrap(async (req, res) => {
    const { x, y, tabId, selector } = req.body || {};
    const tab = manager.getTab(tabId);
    if (selector) await tab.page.locator(selector).first().hover({ timeout: config.actionTimeoutMs });
    else await tab.moveAt(x || 0, y || 0);
    res.json({ ok: true, tab: tab.info() });
  })
);

router.post(
  '/eval',
  wrap(async (req, res) => {
    const { expression, tabId } = req.body || {};
    if (!expression) throw new HttpError(400, 'bad_request', 'expression is required.');
    const tab = manager.getTab(tabId);
    const result = await tab.evalJs(expression);
    res.json({ tabId: tab.id, ...result });
  })
);

/* ------------------------------ capture ---------------------------- */

router.get(
  '/screenshot',
  wrap(async (req, res) => {
    const tab = manager.getTab(req.query.tabId);
    const fullPage = String(req.query.fullPage) === 'true';
    const quality = Math.min(100, Math.max(10, Number(req.query.quality) || config.frameQuality));
    const shot = await tab.screenshot({ fullPage, quality });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Width', String(shot.width));
    res.send(shot.buffer);
  })
);

router.get(
  '/content',
  wrap(async (req, res) => {
    const tab = manager.getTab(req.query.tabId);
    const data = await tab.extract({
      textLimit: Math.min(200_000, Number(req.query.textLimit) || 20_000),
      linkLimit: Math.min(1000, Number(req.query.linkLimit) || 200),
    });
    res.json({ tabId: tab.id, ...data });
  })
);

router.get(
  '/events',
  wrap(async (req, res) => {
    const tab = manager.getTab(req.query.tabId);
    res.json({ tabId: tab.id, events: tab.events });
  })
);

/* ----------------------------- automation -------------------------- */

router.post(
  '/script',
  wrap(async (req, res) => {
    const { steps, sessionId, tabId, viewport, continueOnError } = req.body || {};
    const out = await runScript({ steps, sessionId, tabId, viewport, continueOnError });
    res.status(out.ok ? 200 : 422).json(out);
  })
);

router.get('/actions', (req, res) => {
  res.json({ actions: [...ACTIONS].sort(), limits: { maxSteps: config.scriptMaxSteps, timeoutMs: config.scriptTimeoutMs } });
});

/* ------------------------------ sessions --------------------------- */

router.get(
  '/sessions',
  wrap(async (req, res) => {
    res.json({ activeSessionId: manager.activeSessionId, sessions: manager.listSessions() });
  })
);

router.post(
  '/sessions',
  wrap(async (req, res) => {
    const id = String((req.body || {}).id || `session-${Date.now().toString(36)}`)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .slice(0, 48);
    if (!id) throw new HttpError(400, 'bad_request', 'Invalid session id.');
    await manager.getContext(id, { create: true });
    const tab = await manager.createTab({ sessionId: id });
    res.status(201).json({ id, tab: tab.info(), sessions: manager.listSessions() });
  })
);

router.post(
  '/sessions/:id/save',
  wrap(async (req, res) => {
    res.json(await manager.saveSession(req.params.id));
  })
);

router.get(
  '/sessions/:id/export',
  wrap(async (req, res) => {
    res.json(await manager.exportSession(req.params.id));
  })
);

router.delete(
  '/sessions/:id',
  wrap(async (req, res) => {
    await manager.deleteSession(req.params.id);
    res.json({ deleted: req.params.id, sessions: manager.listSessions() });
  })
);

/* ----------------------------- downloads --------------------------- */

router.get(
  '/downloads',
  wrap(async (req, res) => {
    const files = [];
    const root = config.downloadsDir;
    if (fs.existsSync(root)) {
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
          else {
            const st = fs.statSync(full);
            files.push({ name: `${prefix}${entry.name}`, bytes: st.size, mtime: st.mtimeMs });
          }
        }
      };
      walk(root, '');
    }
    res.json({ root, files: files.sort((a, b) => b.mtime - a.mtime).slice(0, 200) });
  })
);

router.get('/downloads/*', (req, res) => {
  const rel = req.params[0] || '';
  const full = path.resolve(config.downloadsDir, rel);
  if (!full.startsWith(path.resolve(config.downloadsDir) + path.sep) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not_found', message: 'No such download.' });
  }
  return res.download(full);
});

module.exports = router;
