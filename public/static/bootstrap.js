/* browser-panel webview bootstrap.
 *
 * Runs first inside every proxied document. Its job is to make a sandboxed,
 * opaque-origin page behave as if it were the real site:
 *
 *   1. route fetch/XHR through the proxy (the page's own relative URLs point
 *      at the panel origin, which is NOT the origin the site expects)
 *   2. shim document.cookie from the server-side cookie jar
 *   3. shim localStorage/sessionStorage (they throw in an opaque origin)
 *   4. report navigations/titles/errors up to the panel via postMessage
 *
 * Everything is wrapped defensively: if a shim fails, the page must still run.
 */
(function () {
  'use strict';

  var cfg = window.__BP__ || {};
  var BASE = cfg.base || location.href;
  var DYN = cfg.dyn || null;
  var ORIGIN = location.origin;

  function post(type, payload) {
    try {
      payload = payload || {};
      payload.__bp = 1;
      payload.type = type;
      parent.postMessage(payload, '*');
    } catch (e) {
      /* ignore */
    }
  }

  function absolute(input) {
    try {
      var raw = input;
      if (typeof raw !== 'string') {
        if (raw && typeof raw.url === 'string') raw = raw.url;
        else if (raw && raw.href) raw = raw.href;
        else raw = String(raw);
      }
      return new URL(raw, BASE).href;
    } catch (e) {
      return null;
    }
  }

  var rawFetch = window.fetch ? window.fetch.bind(window) : null;

  function viaDyn(url, init) {
    if (!DYN) return rawFetch ? rawFetch(url, init) : Promise.reject(new Error('no proxy'));
    var sep = DYN.indexOf('?') === -1 ? '?' : '&';
    return rawFetch(DYN + sep + 'u=' + encodeURIComponent(url), init);
  }

  /* ---------------------------------------------------------------- fetch */
  try {
    var nativeFetch = rawFetch;
    if (nativeFetch) {
      window.fetch = function (input, init) {
        try {
          var target = absolute(input);
          if (!target || !/^https?:/i.test(target)) return nativeFetch(input, init);
          var init2 = init ? Object.assign({}, init) : {};
          return viaDyn(target, init2).then(function (res) {
            var wrapped;
            try {
              wrapped = new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
              });
              Object.defineProperty(wrapped, 'url', { value: target, configurable: true });
            } catch (e) {
              wrapped = res;
            }
            return wrapped;
          });
        } catch (e) {
          return nativeFetch(input, init);
        }
      };
    }
  } catch (e) {
    /* ignore */
  }

  /* ---------------------------------------------------------------- XHR */
  try {
    if (window.XMLHttpRequest && DYN) {
      var NativeXHR = window.XMLHttpRequest;
      var nativeOpen = NativeXHR.prototype.open;
      var nativeSend = NativeXHR.prototype.send;

      function PatchedXHR() {
        var xhr = new NativeXHR();
        var target = null;

        // Instance-level overrides keep `instanceof`, readyState, events and
        // response parsing intact (unlike wrapping the object).
        xhr.open = function (method, url, async, user, pass) {
          target = absolute(url);
          var proxied = DYN + (DYN.indexOf('?') === -1 ? '?' : '&') + 'u=' + encodeURIComponent(target || url);
          try {
            return nativeOpen.call(this, method, proxied, async === undefined ? true : async, user, pass);
          } catch (e) {
            return nativeOpen.call(this, method, url, async, user, pass);
          }
        };
        xhr.send = function (body) {
          return nativeSend.call(this, body);
        };
        try {
          Object.defineProperty(xhr, 'responseURL', {
            get: function () {
              return target || BASE;
            },
            configurable: true,
          });
        } catch (e) {}
        return xhr;
      }

      PatchedXHR.prototype = NativeXHR.prototype;
      window.XMLHttpRequest = PatchedXHR;
    }
  } catch (e) {
    /* ignore */
  }

  /* --------------------------------------------------------------- cookies */
  try {
    var cookieStore = cfg.cookie || '';
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () {
        return cookieStore;
      },
      set: function (value) {
        var pair = String(value).split(';')[0];
        var parts = cookieStore ? cookieStore.split('; ') : [];
        var name = pair.split('=')[0];
        var found = false;
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].split('=')[0] === name) {
            parts[i] = pair;
            found = true;
          }
        }
        if (!found) parts.push(pair);
        cookieStore = parts.filter(Boolean).join('; ');
        if (cfg.cookiePath) {
          try {
            fetch(cfg.cookiePath, {
              method: 'POST',
              body: String(value),
              headers: { 'content-type': 'text/plain' },
            });
          } catch (e) {}
        }
      },
    });
  } catch (e) {
    /* ignore */
  }

  /* -------------------------------------------------------------- storage */
  try {
    function makeStorage(kind) {
      var map = {};
      try {
        var saved = sessionStorage.getItem('__bp_' + kind);
        if (saved) map = JSON.parse(saved);
      } catch (e) {}
      function save() {
        try {
          sessionStorage.setItem('__bp_' + kind, JSON.stringify(map));
        } catch (e) {}
      }
      var storage = {
        getItem: function (k) {
          k = String(k);
          return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
        },
        setItem: function (k, v) {
          map[String(k)] = String(v);
          save();
        },
        removeItem: function (k) {
          delete map[String(k)];
          save();
        },
        clear: function () {
          map = {};
          save();
        },
        key: function (i) {
          var keys = Object.keys(map);
          return i < keys.length ? keys[i] : null;
        },
      };
      Object.defineProperty(storage, 'length', {
        get: function () {
          return Object.keys(map).length;
        },
      });
      return storage;
    }
    try {
      Object.defineProperty(window, 'localStorage', { value: makeStorage('local'), configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(window, 'sessionStorage', { value: makeStorage('session'), configurable: true });
    } catch (e) {}
  } catch (e) {
    /* ignore */
  }

  /* ------------------------------------------------- navigation reporting */
  function currentInfo() {
    return { url: BASE, title: document.title || '', inner: location.href };
  }

  function report() {
    post('nav', currentInfo());
  }

  try {
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        var result = original.apply(this, arguments);
        setTimeout(report, 0);
        return result;
      };
    });
    window.addEventListener('popstate', report);
    window.addEventListener('hashchange', report);
  } catch (e) {
    /* ignore */
  }

  /* clicks, new tabs, and popups belong to the panel, not the frame */
  try {
    document.addEventListener(
      'click',
      function (event) {
        var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        var target = anchor.getAttribute('target');
        if (target === '_blank') {
          event.preventDefault();
          post('open', { url: anchor.href, download: !!anchor.hasAttribute('download') });
        }
      },
      true,
    );

    var nativeOpenWindow = window.open;
    window.open = function (url) {
      post('open', { url: url ? absolute(url) : null });
      return { closed: false, focus: function () {}, close: function () {}, postMessage: function () {} };
    };
    window.__bpNativeOpen = nativeOpenWindow;
  } catch (e) {
    /* ignore */
  }

  try {
    window.addEventListener('error', function (event) {
      if (!event || !event.message) return;
      post('error', { message: String(event.message).slice(0, 300), source: event.filename || '' });
    });
  } catch (e) {
    /* ignore */
  }

  try {
    document.addEventListener('DOMContentLoaded', report);
    window.addEventListener('load', report);
    report();
    setInterval(report, 4000); // SPA title/URL drift, cheap and harmless
  } catch (e) {
    /* ignore */
  }

  /* ------------------------------------------------- find in page + zoom */
  // Driven by the panel over postMessage -- the iframe is cross-origin, so a
  // command channel is the only way in.
  var findMarks = [];
  var findIndex = -1;

  function clearFind() {
    for (var i = 0; i < findMarks.length; i++) {
      var mark = findMarks[i];
      var parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    findMarks = [];
    findIndex = -1;
  }

  function markMatches(node, query) {
    var text = node.nodeValue || '';
    var lower = text.toLowerCase();
    var needle = query.toLowerCase();
    var at = lower.indexOf(needle);
    if (at === -1) return 0;

    var frag = document.createDocumentFragment();
    var made = 0;
    var pos = 0;
    while (at !== -1) {
      if (at > pos) frag.appendChild(document.createTextNode(text.slice(pos, at)));
      var mark = document.createElement('mark');
      mark.setAttribute('data-bp-find', '');
      mark.style.cssText = 'background:#fde68a;color:#111;border-radius:2px';
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      findMarks.push(mark);
      made++;
      pos = at + needle.length;
      at = lower.indexOf(needle, pos);
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
    return made;
  }

  function doFind(query) {
    clearFind();
    if (!query) return 0;
    try {
      var walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (n) {
            if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            var tag = n.parentNode && n.parentNode.nodeName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (var i = 0; i < nodes.length && findMarks.length < 500; i++) {
        markMatches(nodes[i], query);
      }
    } catch (e) {
      /* find is best-effort */
    }
    findIndex = findMarks.length ? 0 : -1;
    focusMatch();
    return findMarks.length;
  }

  function focusMatch() {
    for (var i = 0; i < findMarks.length; i++) {
      findMarks[i].style.background = '#fde68a';
    }
    if (findIndex < 0 || !findMarks[findIndex]) return;
    findMarks[findIndex].style.background = '#fb923c';
    try {
      findMarks[findIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      try { findMarks[findIndex].scrollIntoView(); } catch (e2) {}
    }
  }

  function stepFind(delta) {
    if (!findMarks.length) return;
    findIndex = (findIndex + delta + findMarks.length) % findMarks.length;
    focusMatch();
    reportFind();
  }

  function reportFind() {
    post('find-result', { count: findMarks.length, index: findIndex });
  }

  function setZoom(level) {
    var pct = Math.max(25, Math.min(300, Math.round(Number(level) * 100)));
    try {
      document.documentElement.style.zoom = String(pct / 100);
      post('zoom-applied', { level: pct / 100, native: true });
    } catch (e) {
      post('zoom-applied', { level: pct / 100, native: false });
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__bpCmd !== 1) return;

    if (data.type === 'find') {
      if (data.query === undefined || data.query === null) {
        clearFind();
      } else {
        var count = doFind(String(data.query));
        reportFind();
        if (count === 0) post('find-result', { count: 0, index: -1 });
      }
      return;
    }
    if (data.type === 'find-step') return stepFind(Number(data.dir) || 1);
    if (data.type === 'zoom') return setZoom(data.level);
    if (data.type === 'scroll-top') {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
    }
  });

  post('ready', { url: BASE });
})();
