// Thin client for the servo-fetch HTTP API.
// Endpoints used: /health, /version, /v1/screenshot, /v1/fetch
//
// Field names matter here: the API takes camelCase (`fullPage`), and
// /v1/fetch always answers with a single `content` string whose meaning
// depends on the requested `format`:
//   markdown (default) -> Readability markdown  (can be a stub on some sites)
//   json               -> a JSON *string*: { title, content, textContent, byline, excerpt }
//   text               -> document.body.innerText (full page, never empty)
//   html               -> raw post-JS HTML
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { log } from '../log.js';
import { ProxyError } from '../util/net.js';
import { ensureRunning, status, touch } from './manager.js';

const { servo } = config;

const base = () => `http://${servo.host}:${servo.port}`;

async function call(path, { body, accept, timeoutMs = servo.timeoutMs } = {}) {
  await ensureRunning();
  touch();

  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        accept: accept ?? '*/*',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new ProxyError(504, `Servo timed out after ${timeoutMs}ms`, 'servo_timeout');
    }
    throw new ProxyError(502, `Servo sidecar unreachable: ${err.cause?.code ?? err.message}`, 'servo_unreachable');
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      detail = data.error ?? data.message ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ProxyError(res.status === 500 ? 502 : res.status, `Servo: ${detail}`, 'servo_error');
  }

  return res;
}

/** Render a page to a PNG buffer. This is "fidelity mode". */
export async function screenshot(url, { fullPage = false, width, height } = {}) {
  const body = { url, format: 'png', fullPage };
  if (width) body.viewportWidth = width;
  if (height) body.viewportHeight = height;

  log.debug(`[servo] screenshot ${url}${fullPage ? ' (full page)' : ''}`);
  const res = await call('/v1/screenshot', { body, accept: 'image/png' });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new ProxyError(502, 'Servo returned an empty image', 'servo_empty');
  return { buffer, contentType: res.headers.get('content-type') ?? 'image/png' };
}

function stripHtml(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="__bp">${String(html)}</div>`);
  $('#__bp script, #__bp style, #__bp noscript').remove();
  return $('#__bp').text().replace(/\n{3,}/g, '\n\n').trim();
}

async function rawFetch(url, format) {
  const res = await call('/v1/fetch', { body: { url, format }, accept: 'application/json' });
  const data = await res.json();
  return typeof data.content === 'string' ? data.content : '';
}

/**
 * Reader mode. Tries the Readability path first, then falls back to raw page
 * text, because Readability returns just a nav stub on some sites (Wikipedia
 * among them) and an empty reader is worse than a slightly noisy one.
 */
export async function document(url, { maxChars = 400_000 } = {}) {
  log.debug(`[servo] reader ${url}`);

  let title = null;
  let content = '';
  let strategy = 'readability';

  try {
    const inner = JSON.parse(await rawFetch(url, 'json'));
    title = inner.title ?? null;
    const markdown = inner.textContent ?? '';
    const html = inner.content ?? '';
    content = markdown.length >= 200 ? markdown : stripHtml(html) || markdown;
    if (inner.byline) title = title ? `${title} — ${inner.byline}` : inner.byline;
  } catch (err) {
    log.debug(`[servo] readability path failed: ${err.message}`);
  }

  if (content.trim().length < 200) {
    strategy = 'full-text';
    const text = await rawFetch(url, 'text');
    if (text.trim().length > content.trim().length) content = text;
    if (strategy === 'full-text') {
      content = content
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line, i, arr) => line.trim() !== '' || arr[i - 1]?.trim() !== '')
        .join('\n');
    }
  }

  const truncated = content.length > maxChars;
  if (truncated) content = `${content.slice(0, maxChars)}\n\n… [truncated]`;

  return {
    url,
    title,
    strategy,
    format: strategy === 'readability' ? 'markdown' : 'text',
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    truncated,
  };
}

export async function healthy() {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

export { status };
