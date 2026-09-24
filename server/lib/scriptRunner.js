'use strict';

/**
 * Script runner -- turns a JSON list of steps into real Firefox actions.
 * This is the "automation" half of the panel: the same primitives the UI uses
 * are exposed as a POSTable script so you can drive the browser from cron,
 * another service, or a shell script.
 *
 *   curl -s -X POST https://<app>/api/script \
 *     -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
 *     -d '{"session":"main","steps":[
 *           {"do":"goto","url":"https://news.ycombinator.com"},
 *           {"do":"click","selector":".titleline > a"},
 *           {"do":"waitForLoad"},
 *           {"do":"screenshot","fullPage":true,"name":"hn"}
 *         ]}'
 */

const fs = require('node:fs');
const path = require('node:path');
const { manager, HttpError, normaliseUrl } = require('./browserManager');
const config = require('./config');

const ACTIONS = new Set([
  'goto', 'reload', 'back', 'forward', 'wait', 'waitForLoad', 'waitForSelector',
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'focus', 'select',
  'check', 'uncheck', 'scroll', 'scrollBy', 'screenshot', 'extract', 'eval',
  'newTab', 'closeTab', 'switchTab', 'log', 'saveSession', 'upload',
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function target(tab, step) {
  if (step.selector) return tab.page.locator(step.selector).first();
  if (step.text) return tab.page.getByText(step.text, { exact: Boolean(step.exact) }).first();
  if (step.role && step.name) return tab.page.getByRole(step.role, { name: step.name }).first();
  throw new HttpError(400, 'bad_step', `Step "${step.do}" needs one of: selector, text, or role+name.`);
}

async function runScript({ steps, sessionId, tabId, viewport, continueOnError = false }) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new HttpError(400, 'bad_script', 'steps must be a non-empty array.');
  }
  if (steps.length > config.scriptMaxSteps) {
    throw new HttpError(400, 'script_too_long', `Max ${config.scriptMaxSteps} steps per script.`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + config.scriptTimeoutMs;
  const results = [];
  const artifacts = [];

  // Ensure we have a tab to work with.
  let tab;
  try {
    tab = manager.getTab(tabId);
  } catch {
    tab = await manager.createTab({ sessionId, url: 'about:blank' });
  }

  if (viewport && viewport.width && viewport.height) {
    await tab.page.setViewportSize({
      width: Math.min(3840, Number(viewport.width) | 0),
      height: Math.min(2160, Number(viewport.height) | 0),
    });
  }

  for (let i = 0; i < steps.length; i += 1) {
    if (Date.now() > deadline) {
      results.push({ step: i, do: steps[i] && steps[i].do, ok: false, error: 'script timeout exceeded', ms: Date.now() - startedAt });
      break;
    }
    const step = steps[i] || {};
    const t0 = Date.now();
    const record = { step: i, do: step.do, ok: true };
    try {
      if (!step.do || !ACTIONS.has(step.do)) {
        throw new HttpError(400, 'unknown_action', `Unknown action "${step.do}". Valid: ${[...ACTIONS].join(', ')}`);
      }
      const timeout = Number(step.timeout) || config.actionTimeoutMs;

      switch (step.do) {
        case 'goto': {
          const r = await tab.navigate(normaliseUrl(step.url), { waitUntil: step.waitUntil || 'load' });
          record.result = r;
          break;
        }
        case 'reload':
          await tab.page.reload({ waitUntil: step.waitUntil || 'load', timeout });
          break;
        case 'back':
          await tab.page.goBack({ waitUntil: step.waitUntil || 'load', timeout }).catch(() => {});
          break;
        case 'forward':
          await tab.page.goForward({ waitUntil: step.waitUntil || 'load', timeout }).catch(() => {});
          break;
        case 'wait':
          await sleep(Math.min(60_000, Number(step.ms) || 500));
          break;
        case 'waitForLoad':
          await tab.page.waitForLoadState(step.state || 'load', { timeout });
          break;
        case 'waitForSelector':
          await tab.page.waitForSelector(step.selector, { timeout, state: step.state || 'visible' });
          record.result = { selector: step.selector, found: true };
          break;
        case 'click':
          if (step.x !== undefined && step.y !== undefined) {
            await tab.clickAt(step.x, step.y);
          } else {
            await target(tab, step).click({ timeout });
          }
          break;
        case 'dblclick':
          await target(tab, step).dblclick({ timeout });
          break;
        case 'hover':
          await target(tab, step).hover({ timeout });
          break;
        case 'focus':
          await target(tab, step).focus({ timeout });
          break;
        case 'fill':
          await target(tab, step).fill(String(step.value ?? ''), { timeout });
          break;
        case 'type':
          if (step.selector || step.text) await target(tab, step).click({ timeout }).catch(() => {});
          await tab.typeText(String(step.value ?? ''), { delay: Number(step.delay) ?? 12 });
          break;
        case 'press':
          await tab.page.keyboard.press(String(step.key));
          break;
        case 'select':
          await target(tab, step).selectOption(step.value, { timeout });
          break;
        case 'check':
          await target(tab, step).check({ timeout });
          break;
        case 'uncheck':
          await target(tab, step).uncheck({ timeout });
          break;
        case 'scroll':
          await tab.scrollTo(step.x ?? 0, step.y ?? 0);
          break;
        case 'scrollBy':
          await tab.scrollBy(step.x ?? 0, step.y ?? 600);
          break;
        case 'screenshot': {
          const shot = await tab.screenshot({ fullPage: Boolean(step.fullPage), quality: step.quality });
          const dir = path.join(config.downloadsDir, 'scripts');
          fs.mkdirSync(dir, { recursive: true });
          const name = `${Date.now()}-${(step.name || `step-${i}`).replace(/[^\w.\-]+/g, '_')}.jpg`;
          const file = path.join(dir, name);
          fs.writeFileSync(file, shot.buffer);
          artifacts.push({ kind: 'screenshot', step: i, name, path: file, bytes: shot.buffer.length });
          record.result = { name, bytes: shot.buffer.length };
          break;
        }
        case 'extract':
          record.result = await tab.extract({ textLimit: step.textLimit, linkLimit: step.linkLimit });
          break;
        case 'eval':
          record.result = await tab.evalJs(step.expression);
          break;
        case 'newTab':
          tab = await manager.createTab({ sessionId: step.session || sessionId, url: 'about:blank' });
          if (step.url) await tab.navigate(normaliseUrl(step.url)).catch(() => {});
          record.result = { tabId: tab.id };
          break;
        case 'closeTab':
          await manager.closeTab(step.tabId || tab.id);
          tab = manager.getActiveTab();
          break;
        case 'switchTab':
          tab = manager.getTab(step.tabId);
          break;
        case 'upload':
          await target(tab, step).setInputFiles(step.files, { timeout });
          break;
        case 'saveSession':
          record.result = await manager.saveSession(step.session || sessionId);
          break;
        case 'log':
          record.result = { message: step.message };
          break;
        default:
          break;
      }
    } catch (e) {
      record.ok = false;
      record.error = String(e && e.message ? e.message : e);
      record.status = e && e.status ? e.status : 500;
      if (!continueOnError) {
        record.ms = Date.now() - t0;
        results.push(record);
        return { ok: false, stoppedAtStep: i, tabId: tab.id, results, artifacts, ms: Date.now() - startedAt };
      }
    }
    record.ms = Date.now() - t0;
    results.push(record);
  }

  return {
    ok: results.every((r) => r.ok),
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    results,
    artifacts,
    ms: Date.now() - startedAt,
  };
}

module.exports = { runScript, ACTIONS };
