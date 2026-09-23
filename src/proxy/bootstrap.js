// Builds the boot script injected at the top of every proxied document.
// It is the only piece of client JS the server controls inside the webview;
// public/static/bootstrap.js does the actual work.
import { cookieJarGet } from '../store.js';

export function bootstrapTag(signer, baseUrl, userId) {
  let cookieString = '';
  try {
    cookieString = cookieJarGet(userId, baseUrl).join('; ');
  } catch {
    cookieString = '';
  }

  const cfg = {
    base: baseUrl,
    dyn: `/p/${signer.prefix('dyn', '')}/dyn/q`,
    cookiePath: signer.path('cookie', baseUrl),
    cookie: cookieString,
    version: 1,
  };

  const json = JSON.stringify(cfg)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  // Inline config, then a blocking external script: the external file keeps
  // client code readable and unescaped, and blocking (no defer/async) means
  // it runs before any page script.
  return `<script>window.__BP__=${json};</script><script src="/static/bootstrap.js"></script>`;
}
