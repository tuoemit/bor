// Rewrites upstream HTML/CSS so the whole page keeps running through the
// proxy. This is the part that replaces a browser engine: instead of parsing
// and rendering, we point every URL back at ourselves and let *your* browser
// do the rendering inside the panel's iframe.
//
// URL categories:
//   page  - enters the webview as a document (links, forms, iframes)
//   asset - subresource, served verbatim with a content-type fixup
//   dyn   - dynamic proxy endpoint used by the injected fetch/XHR shim
import * as cheerio from 'cheerio';

const SKIP_SCHEME = /^(?:data|blob|javascript|mailto|tel|sms|about|chrome|file|ws|wss|geo|magnet|intent):/i;

const PAGE_TAGS = {
  a: ['href'],
  area: ['href'],
  iframe: ['src'],
  frame: ['src'],
  form: ['action'],
  object: ['data'],
  button: ['formaction'],
  input: ['formaction'],
};

const ASSET_TAGS = {
  img: ['src', 'longdesc'],
  script: ['src'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
  input: ['src'],
  use: ['href', 'xlink:href'],
  image: ['href', 'xlink:href'],
  table: ['background'],
  td: ['background'],
  th: ['background'],
  body: ['background'],
};

const CITATION_TAGS = { blockquote: ['cite'], q: ['cite'], ins: ['cite'], del: ['cite'] };

const LINK_REL_SKIP = new Set([
  'preconnect',
  'dns-prefetch',
  'prerender',
  'canonical',
  'alternate',
  'amphtml',
  'author',
  'me',
  'license',
  'search',
  'pingback',
  'webmention',
]);

export function isRewriteable(ref) {
  if (!ref) return false;
  const trimmed = String(ref).trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  return !SKIP_SCHEME.test(trimmed);
}

export function absolutize(ref, base) {
  if (!isRewriteable(ref)) return null;
  try {
    const url = new URL(String(ref).trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** url(...) and @import inside CSS text. */
export function rewriteCss(css, base, signer) {
  let out = String(css);

  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, ref) => {
    const abs = absolutize(ref, base);
    if (!abs) return match;
    return `url("${signer.path('asset', abs)}")`;
  });

  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, ref) => {
    const abs = absolutize(ref, base);
    if (!abs) return match;
    return `@import url("${signer.path('asset', abs)}")`;
  });

  // Resolve remaining relative @import url(...) handled above.
  return out;
}

function rewriteSrcset(value, base, signer) {
  return String(value)
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const [ref, ...descriptor] = trimmed.split(/\s+/);
      const abs = absolutize(ref, base);
      if (!abs) return trimmed;
      return [signer.path('asset', abs), ...descriptor].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

export function rewriteStyleAttr(value, base, signer) {
  if (!value) return value;
  return rewriteCss(value, base, signer);
}

/**
 * @param {string} html       upstream markup
 * @param {string} baseUrl    absolute URL the markup came from
 * @param {{sid:string, path:Function}} signer
 * @param {{ bootstrap:string, extraHead?:string }} inject
 * @param {{ origin:string }} ctx
 */
export function rewriteHtml(html, baseUrl, signer, inject) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // A <base href> would silently retarget every relative URL, so fold it into
  // baseUrl and drop the tag.
  const baseTag = $('base[href]').first();
  let effectiveBase = baseUrl;
  if (baseTag.length) {
    const abs = absolutize(baseTag.attr('href'), baseUrl);
    if (abs) effectiveBase = abs;
    baseTag.remove();
  }

  const toPage = (ref) => {
    const abs = absolutize(ref, effectiveBase);
    return abs ? signer.path('page', abs) : null;
  };
  const toAsset = (ref) => {
    const abs = absolutize(ref, effectiveBase);
    return abs ? signer.path('asset', abs) : null;
  };

  // ---- element attributes
  for (const [tag, attrs] of Object.entries(PAGE_TAGS)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const proxied = toPage($(el).attr(attr));
        if (proxied) $(el).attr(attr, proxied);
      }
    });
  }

  for (const [tag, attrs] of Object.entries(ASSET_TAGS)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const raw = $(el).attr(attr);
        if (!raw) continue;
        if (attr === 'srcset') {
          $(el).attr(attr, rewriteSrcset(raw, effectiveBase, signer));
          continue;
        }
        const proxied = toAsset(raw);
        if (proxied) $(el).attr(attr, proxied);
      }
    });
  }

  for (const [tag, attrs] of Object.entries(CITATION_TAGS)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const proxied = toAsset($(el).attr(attr));
        if (proxied) $(el).attr(attr, proxied);
      }
    });
  }

  // <link> needs rel-aware treatment: stylesheets/icons are assets, but
  // canonical/preconnect/alternate leak the real origin and do nothing useful.
  $('link').each((_, el) => {
    const $el = $(el);
    const rel = String($el.attr('rel') ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (rel.some((r) => LINK_REL_SKIP.has(r)) && !rel.includes('preload')) {
      $el.remove();
      return;
    }
    const proxied = toAsset($el.attr('href'));
    if (proxied) $el.attr('href', proxied);
    else $el.removeAttr('href');
  });

  // <meta http-equiv="refresh" content="0; url=/next">
  $('meta[http-equiv]').each((_, el) => {
    const $el = $(el);
    if (String($el.attr('http-equiv')).toLowerCase() !== 'refresh') return;
    const content = $el.attr('content') ?? '';
    $el.attr(
      'content',
      content.replace(/(url\s*=\s*)(['"]?)([^'";]+)\2/i, (m, pre, q, ref) => {
        const abs = absolutize(ref, effectiveBase);
        return abs ? `${pre}"${signer.path('page', abs)}"` : m;
      }),
    );
  });

  // Inline styles + <style> blocks
  $('[style]').each((_, el) => {
    const $el = $(el);
    $el.attr('style', rewriteStyleAttr($el.attr('style'), effectiveBase, signer));
  });
  $('style').each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), effectiveBase, signer));
  });

  // Inline scripts: only fix sourcemap comments. Inline code is left alone --
  // rewriting JS bodies is where naive proxies break SPAs.
  $('script:not([src])').each((_, el) => {
    const $el = $(el);
    const code = $el.text();
    $el.text(code.replace(/(\/\/#\s*sourceMappingURL=)(\S+)/g, (m, pre, ref) => {
      const abs = absolutize(ref, effectiveBase);
      return abs ? `${pre}${signer.path('asset', abs)}` : m;
    }));
  });

  // Neutralise the things that would pop out of the panel.
  $('meta[http-equiv="Content-Security-Policy" i]').remove();
  $('a[target="_top"], a[target="_parent"]').attr('target', '_blank');

  // Upstream navigator.serviceWorker would be fatal in a proxied context.
  const guard = `<script>(function(){try{
if(navigator.serviceWorker){Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:true});}
}catch(e){}})();</script>`;

  // Bootstrap first so page scripts see the shims already installed.
  $('head').prepend(guard);
  $('head').prepend(inject.bootstrap);
  if (inject.extraHead) $('head').prepend(inject.extraHead);

  // Tell the panel what the real URL is (address bar, history, title).
  $('head').prepend(
    `<meta name="bp-url" content="${escapeAttr(baseUrl)}">` +
      `<meta name="bp-req" content="${escapeAttr(inject.requestUrl ?? baseUrl)}">`,
  );

  $('html').attr('data-bp-proxied', '1');

  return $.html();
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
