/* browser-panel front-end.
 *
 * One iframe is shared by all tabs; switching tabs re-points it at the
 * already-signed proxied path. The panel never mints proxy URLs itself —
 * every navigation goes through /api/navigate so the server can validate the
 * target, check SSRF rules, and sign the capability.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  tabs: $('tabs'), frame: $('frame'), omnibox: $('omnibox'), suggest: $('suggest'),
  progress: $('progress'), startpage: $('startpage'), tiles: $('tiles'),
  historyList: $('historyList'), bookmarkList: $('bookmarkList'), scrim: $('scrim'),
  frequentList: $('frequentList'), cookieList: $('cookieList'), infoBox: $('infoBox'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalSub: $('modalSub'),
  toast: $('toast'), errorbar: $('errorbar'), errorMsg: $('errorMsg'),
  sidebar: $('sidebar'), menu: $('menu'),
  liveview: $('liveview'), liveBadge: $('liveBadge'), liveHint: $('liveHint'),
  engineItem: $('engineItem'), mobileItem: $('mobileItem'), errorChromium: $('errorChromium'),
  findbar: $('findbar'), findInput: $('findInput'), findCount: $('findCount'),
};

const state = {
  tabs: [],
  activeId: null,
  info: null,
  suggestions: [],
  suggestIndex: -1,
  lastSearch: '',
  // 'fit' = page lays out at the phone width; 'desktop' = fixed 1280px layout
  // scaled to fit, for sites that are unusable in a narrow viewport.
  viewMode: 'fit',
  narrow: false,
  // Live Chromium engine availability, from /api/engine.
  engine: { available: false, status: 'disabled', version: null, hint: null, maxTabs: 3 },
  engineDefault: 'proxy',
  mobileView: false,
  viewer: null,
  zoom: 1,
  find: { open: false, query: '', count: 0, index: -1 },
};

const NARROW = '(max-width: 900px)';

// Zoom steps shared by the keyboard shortcuts and the menu — the same ladder
// desktop browsers use. A slider feels nicer but a ladder is what Ctrl +/- does.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DESKTOP_WIDTH = 1280;
const isNarrow = () => window.matchMedia(NARROW).matches;

let uid = 0;
const nextId = () => `t${Date.now().toString(36)}${(++uid).toString(36)}`;

/* ------------------------------------------------------------------ helpers */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthenticated');
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(message, ms = 2200) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}${u.search}`.slice(0, 120);
  } catch { return url ?? ''; }
}

function when(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) ?? null;

/* ------------------------------------------------------------------- tabs */
function createTab(url = null, { activate = true, title = null } = {}) {
  const tab = {
    id: nextId(),
    title: title ?? 'New tab',
    url: url ?? null,
    path: null,
    mode: state.engineDefault,
    history: [],
    index: -1,
    loading: false,
  };
  state.tabs.push(tab);
  if (activate) state.activeId = tab.id;
  renderTabs();
  scrollActiveTabIntoView();
  if (activate) showTab(tab);
  if (url) navigate(tab, url, { record: false });
  else renderStartpage();
  saveSession();
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const closing = state.tabs[idx];
  if (closing?.mode === 'chromium' && state.viewer) state.viewer.close(id);
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    createTab();
    return;
  }
  if (state.activeId === id) {
    state.activeId = state.tabs[Math.max(0, idx - 1)].id;
    showTab(activeTab());
  }
  renderTabs();
  saveSession();
}

function selectTab(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  renderTabs();
  showTab(activeTab());
  scrollActiveTabIntoView();
  saveSession();
}

/** On phones the tab strip only shows ~2 tabs; keep the active one visible. */
function scrollActiveTabIntoView() {
  const el = els.tabs.querySelector('.tab.active');
  if (!el) return;
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
}

function showTab(tab, { force = false } = {}) {
  if (!tab) return;
  updateChrome(tab);
  updateEngineLabel();

  const useChromium = tab.mode === 'chromium' && state.engine.available;

  if (useChromium && (tab.url || tab.path)) {
    const url = tab.url ?? tab.path;
    els.frame.hidden = true;
    els.frame.removeAttribute('src');
    els.startpage.hidden = true;
    els.liveview.hidden = false;

    const viewer = ensureViewer();
    if (!viewer) {
      showLiveHint('The live viewer script did not load.');
      return;
    }
    viewer.connect();
    if (force || viewer.tabId !== tab.id) viewer.open(tab.id, url);
    else viewer.focus(tab.id);
    setLoading(true);
    updateStatusBar();
    return;
  }

  // Proxy mode (or an untouched new tab)
  els.liveview.hidden = true;
  if (state.viewer && tab.id) state.viewer.close(tab.id);

  if (tab.path) {
    setTimeout(() => applyZoom(state.zoom, { persist: false }), 60);
    if (els.frame.getAttribute('src') !== tab.path) els.frame.setAttribute('src', tab.path);
    els.frame.hidden = false;
    els.startpage.hidden = true;
    setLoading(true);
  } else {
    els.frame.hidden = true;
    els.startpage.hidden = false;
    setLoading(false);
  }
  renderStartpage();
}

function renderTabs() {
  els.tabs.textContent = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.id === state.activeId ? ' active' : ''}`;
    el.title = tab.url ?? 'New tab';

    const fav = document.createElement('span');
    fav.className = 'fav';
    fav.textContent = tab.loading ? '' : (hostOf(tab.url ?? '') || '•').slice(0, 1);
    if (tab.loading) {
      fav.classList.add('spin');
      fav.style.border = 'none';
      fav.style.background = 'transparent';
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.title || (tab.url ? prettyUrl(tab.url) : 'New tab');

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close tab (Ctrl+W)';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    el.append(fav, label, close);
    el.addEventListener('click', () => selectTab(tab.id));
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) closeTab(tab.id);
    });
    els.tabs.append(el);
  }
}

function updateChrome(tab) {
  if (!tab) return;
  if (document.activeElement !== els.omnibox) els.omnibox.value = tab.url ?? '';
  const secure = (tab.url ?? '').startsWith('https://');
  $('lockIcon').classList.toggle('insecure', Boolean(tab.url) && !secure);
  $('lockIcon').textContent = tab.url ? (secure ? '🔒' : '⚠︎') : '◍';
  $('backBtn').disabled = tab.index <= 0;
  $('forwardBtn').disabled = tab.index >= tab.history.length - 1;
}

/* -------------------------------------------------------------- navigation */
async function navigate(tab, input, { record = true } = {}) {
  if (!tab) return;
  const query = String(input ?? '').trim();

  // Typed a URL that is already a signed proxy path (rare, but cheap to honour).
  if (query.startsWith('/p/')) {
    loadPath(tab, query, query, { record: false, title: 'Proxied page' });
    return;
  }

  setLoading(true);
  setNote(`resolving ${query.slice(0, 60)}…`);

  // Chromium takes the raw address and does its own resolution; the proxy
  // needs the server to normalise and sign a capability URL first.
  if (tab.mode === 'chromium' && state.engine.available) {
    const viewer = ensureViewer();
    if (!viewer) return showError('The live viewer is unavailable.', () => navigate(tab, query));
    tab.url = query;
    tab.path = null;
    if (record) {
      tab.history = tab.history.slice(0, tab.index + 1);
      if (tab.history[tab.history.length - 1] !== query) tab.history.push(query);
      tab.index = tab.history.length - 1;
    }
    els.liveview.hidden = false;
    els.startpage.hidden = true;
    els.frame.hidden = true;
    viewer.connect();
    if (viewer.tabId === tab.id) viewer.command({ t: 'nav', url: query });
    else viewer.open(tab.id, query);
    renderTabs();
    updateChrome(tab);
    saveSession();
    return;
  }

  try {
    const { url, path } = await api('/api/navigate', { method: 'POST', body: { input: query } });
    loadPath(tab, path, url, { record, title: url });
  } catch (err) {
    setLoading(false);
    showError(`${err.message}`, () => navigate(tab, query));
  }
}

function loadPath(tab, path, url, { record = true, title = null } = {}) {
  if (record) {
    tab.history = tab.history.slice(0, tab.index + 1);
    if (tab.history[tab.history.length - 1] !== url) tab.history.push(url);
    tab.index = tab.history.length - 1;
  } else if (tab.history.length === 0) {
    tab.history = [url];
    tab.index = 0;
  }
  tab.url = url;
  tab.path = path;
  if (title) tab.title = title;
  els.frame.setAttribute('src', path);
  els.frame.hidden = false;
  els.startpage.hidden = true;
  setLoading(true);
  renderTabs();
  updateChrome(tab);
  saveSession();
}

function goBack() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.mode === 'chromium' && state.engine.available) {
    // Chromium owns its own history in this mode.
    state.viewer?.command({ t: 'back' });
    return;
  }
  if (tab.index <= 0) return;
  tab.index -= 1;
  mintAndLoad(tab, tab.history[tab.index], { record: false });
}

function goForward() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.mode === 'chromium' && state.engine.available) {
    state.viewer?.command({ t: 'forward' });
    return;
  }
  if (tab.index >= tab.history.length - 1) return;
  tab.index += 1;
  mintAndLoad(tab, tab.history[tab.index], { record: false });
}

async function mintAndLoad(tab, url, options) {
  try {
    const { path } = await api('/api/navigate', { method: 'POST', body: { input: url } });
    loadPath(tab, path, url, options);
  } catch (err) {
    showError(err.message);
  }
}

function reload() {
  const tab = activeTab();
  if (!tab?.url) return;
  setLoading(true);
  if (tab.mode === 'chromium' && state.engine.available) {
    state.viewer?.command({ t: 'reload' });
    return;
  }
  mintAndLoad(tab, tab.url, { record: false });
}

/* --------------------------------------------------------------- chrome UI */
function setLoading(loading) {
  const bar = els.progress.firstElementChild;
  if (loading) {
    els.progress.classList.remove('done');
    bar.style.width = '12%';
    setTimeout(() => { if (!els.progress.classList.contains('done')) bar.style.width = '68%'; }, 260);
    const tab = activeTab();
    if (tab) { tab.loading = true; renderTabs(); }
  } else {
    bar.style.width = '100%';
    els.progress.classList.add('done');
    setTimeout(() => { bar.style.width = '0'; }, 420);
    const tab = activeTab();
    if (tab) { tab.loading = false; renderTabs(); }
  }
}

function setNote(text) {
  const tab = activeTab();
  if (tab?.mode === 'chromium' && state.engine.available && text === 'loaded') return;
  $('statusNote').textContent = text;
}

function showError(message, retry) {
  els.errorMsg.textContent = message;
  els.errorbar.hidden = false;
  $('errorRetry').onclick = () => {
    els.errorbar.hidden = true;
    if (typeof retry === 'function') retry();
  };
}

/* ------------------------------------------------------------- start page */
async function renderStartpage() {
  setNote('new tab');
  try {
    const { items } = await api('/api/suggest?q=');
    const seen = new Set();
    const tiles = [];
    for (const item of items) {
      const host = hostOf(item.url);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      tiles.push({ host, url: item.url, title: item.title || host });
      if (tiles.length >= 8) break;
    }
    els.tiles.textContent = '';
    if (!tiles.length) {
      const hint = document.createElement('div');
      hint.className = 'empty';
      hint.style.textAlign = 'center';
      hint.style.width = '100%';
      hint.textContent = 'Your most visited sites will appear here once you browse a little.';
      els.tiles.append(hint);
      return;
    }
    for (const tile of tiles) {
      const button = document.createElement('button');
      button.className = 'tile';
      button.type = 'button';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = tile.host.slice(0, 2);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const b = document.createElement('b');
      b.textContent = tile.host;
      const s = document.createElement('span');
      s.textContent = tile.title === tile.host ? '' : tile.title;
      meta.append(b, s);
      button.append(badge, meta);
      button.addEventListener('click', () => {
        const tab = activeTab() ?? createTab();
        navigate(tab, tile.url);
      });
      els.tiles.append(button);
    }
  } catch {
    /* start page is non-critical */
  }
}

/* ------------------------------------------------------------- suggestions */
let suggestTimer = null;
async function refreshSuggestions(query) {
  try {
    const { items } = await api(`/api/suggest?q=${encodeURIComponent(query)}`);
    state.suggestions = items;
    state.suggestIndex = -1;
    els.suggest.textContent = '';
    if (!items.length) {
      els.suggest.classList.remove('open');
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.index = String(index);
      const kind = document.createElement('span');
      kind.className = `kind ${item.kind}`;
      kind.textContent = item.kind;
      const title = document.createElement('span');
      title.className = 't';
      title.textContent = item.title || item.url;
      const url = document.createElement('span');
      url.className = 'u';
      url.textContent = prettyUrl(item.url);
      row.append(kind, title, url);
      // pointerdown covers mouse + touch + pen; on iOS the synthesized
      // mousedown arrives after focus changes and can be swallowed.
      row.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        commitSuggestion(index);
      });
      els.suggest.append(row);
    });
    els.suggest.classList.add('open');
  } catch {
    els.suggest.classList.remove('open');
  }
}

function commitSuggestion(index) {
  const item = state.suggestions[index];
  els.suggest.classList.remove('open');
  if (!item) return;
  const tab = activeTab() ?? createTab();
  els.omnibox.blur();
  navigate(tab, item.url);
}

function moveSuggestion(delta) {
  if (!state.suggestions.length) return;
  state.suggestIndex = Math.max(-1, Math.min(state.suggestions.length - 1, state.suggestIndex + delta));
  [...els.suggest.children].forEach((row, index) => row.classList.toggle('sel', index === state.suggestIndex));
}

/* ----------------------------------------------------------------- sidebar */
async function loadHistory() {
  const q = $('historySearch').value.trim();
  const { items } = await api(`/api/history?limit=150&q=${encodeURIComponent(q)}`);
  els.historyList.textContent = '';
  if (!items.length) {
    els.historyList.innerHTML = '<div class="empty">No history yet.</div>';
    return;
  }
  for (const row of items) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<span class="t"><b></b><span></span></span><button class="x" title="Remove">✕</button>`;
    el.querySelector('b').textContent = row.title || prettyUrl(row.url);
    el.querySelector('span span').textContent = `${prettyUrl(row.url)} · ${when(row.visited_at)}${row.visit_count > 1 ? ` · ${row.visit_count}×` : ''}`;
    el.addEventListener('click', () => navigate(activeTab() ?? createTab(), row.url));
    el.querySelector('.x').addEventListener('click', async (event) => {
      event.stopPropagation();
      await api(`/api/history/${row.id}`, { method: 'DELETE' });
      loadHistory();
    });
    els.historyList.append(el);
  }
}

async function loadBookmarks() {
  const { items } = await api('/api/bookmarks');
  els.bookmarkList.textContent = '';
  if (!items.length) {
    els.bookmarkList.innerHTML = '<div class="empty">Nothing saved yet. Use the ☆ button.</div>';
    return;
  }
  for (const row of items) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<span class="t"><b></b><span></span></span><button class="x" title="Remove">✕</button>`;
    el.querySelector('b').textContent = row.title || prettyUrl(row.url);
    el.querySelector('span span').textContent = prettyUrl(row.url);
    el.addEventListener('click', () => navigate(activeTab() ?? createTab(), row.url));
    el.querySelector('.x').addEventListener('click', async (event) => {
      event.stopPropagation();
      await api(`/api/bookmarks/${row.id}`, { method: 'DELETE' });
      loadBookmarks();
    });
    els.bookmarkList.append(el);
  }
}

async function loadFrequent() {
  const { items } = await api('/api/frequent');
  els.frequentList.textContent = '';
  if (!items.length) {
    els.frequentList.innerHTML = '<div class="empty">No frequent sites yet.</div>';
    return;
  }
  for (const row of items) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<span class="t"><b></b><span></span></span>`;
    el.querySelector('b').textContent = hostOf(row.url) || row.url;
    el.querySelector('span span').textContent = `${row.visits} visit${row.visits === 1 ? '' : 's'}`;
    el.addEventListener('click', () => navigate(activeTab() ?? createTab(), row.url));
    els.frequentList.append(el);
  }
}

async function loadCookies() {
  const { items } = await api('/api/cookies');
  els.cookieList.textContent = '';
  if (!items.length) {
    els.cookieList.innerHTML = '<div class="empty">The jar is empty.</div>';
    return;
  }
  for (const row of items) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<span class="t"><b></b><span></span></span>`;
    el.querySelector('b').textContent = row.name;
    el.querySelector('span span').textContent = `${row.domain}${row.path} · ${row.expires ? `expires ${new Date(row.expires * 1000).toLocaleDateString()}` : 'session'}`;
    els.cookieList.append(el);
  }
}

async function loadInfo() {
  const info = state.info ?? (await api('/api/info'));
  state.info = info;
  const rows = [
    ['Platform', `${info.platform.name}${info.platform.region ? ` (${info.platform.region})` : ''}`],
    ['Engine', info.engine],
    [
      'Chromium engine',
      info.chromiumEngine?.available
        ? `Chromium ${info.chromiumEngine.version ?? 'ready'} (${info.chromiumEngine.status})`
        : 'unavailable — proxy only',
    ],
    ['Version', `v${info.version} · node ${info.node}`],
    ['Uptime', `${Math.floor(info.uptime_s / 60)}m ${info.uptime_s % 60}s`],
    ['Memory', `${info.memory_mb.rss} MB rss / ${info.memory_mb.heap} MB heap`],
    ['Store', info.persistent ? info.dbPath : 'in-memory (resets on deploy)'],
    ['Password source', info.ephemeralPassword ? 'generated at boot (set APP_PASSWORD!)' : 'APP_PASSWORD env var'],
    ['Private hosts', info.allowPrivateHosts ? 'allowed (SSRF guard off)' : 'blocked (SSRF guard on)'],
    ['Timeout', `${info.limits.upstreamTimeoutMs} ms`],
    ['Body limit', `${Math.round(info.limits.maxBodyBytes / 1048576)} MB`],
  ];
  els.infoBox.textContent = '';
  for (const [key, value] of rows) {
    const el = document.createElement('div');
    el.className = 'kv';
    const k = document.createElement('span');
    k.textContent = key;
    const v = document.createElement('span');
    v.textContent = String(value);
    el.append(k, v);
    els.infoBox.append(el);
  }

  $('statusPlatform').textContent = `platform: ${info.platform.name.toLowerCase()}`;
  $('statusStore').textContent = `store: ${info.persistent ? 'sqlite' : 'memory'}`;
  $('statusMem').textContent = `${info.memory_mb.rss} MB`;
  $('persistNote').textContent = info.persistent
    ? `History, bookmarks and cookies live in ${info.dbPath}.`
    : 'No writable volume detected: history/bookmarks/cookies reset when the service redeploys. Mount a volume and set DB_PATH to keep them.';
  if (info.ephemeralPassword) {
    $('statusStore').classList.add('warn');
    showError('APP_PASSWORD is not set — the panel is using a password generated at boot. Check the service logs and set the env var.', null);
  }
}

/* ---------------------------------------------------------------- messaging */
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__bp !== 1) return;
  const tab = activeTab();
  if (!tab) return;

  if (data.type === 'ready' || data.type === 'nav') {
    if (data.url && data.url !== tab.url) {
      tab.url = data.url;
      if (tab.history[tab.index] !== data.url && state.loadingRecent !== true) {
        tab.history = tab.history.slice(0, tab.index + 1);
        tab.history.push(data.url);
        tab.index = tab.history.length - 1;
      }
    }
    if (data.title) tab.title = data.title.slice(0, 120);
    else if (tab.url) tab.title = prettyUrl(tab.url);
    renderTabs();
    updateChrome(tab);
    setNote('loaded');
    setLoading(false);
    saveSession();
    return;
  }

  if (data.type === 'open' && data.url) {
    createTab(data.url, { activate: true });
    return;
  }

  if (data.type === 'find-result') {
    state.find.count = data.count ?? 0;
    state.find.index = data.index ?? -1;
    els.findCount.textContent = state.find.count
      ? `${state.find.index + 1}/${state.find.count}`
      : 'no matches';
    return;
  }

  if (data.type === 'zoom-applied') {
    // Native CSS zoom worked: drop the iframe-transform fallback.
    const native = data.native !== false;
    if (native !== state.zoomNative) {
      state.zoomNative = native;
      applyZoom(state.zoom, { persist: false });
    }
    return;
  }

  if (data.type === 'ready') {
    // Re-apply per-page state after every navigation.
    applyZoom(state.zoom, { persist: false });
    if (state.find.open && state.find.query) runFind(state.find.query);
  }

  if (data.type === 'error') {
    setNote(`script error on page: ${data.message.slice(0, 60)}`);
    return;
  }

  if (data.type === 'error-page') {
    showError(data.message || 'The page could not be loaded through the proxy.', () => reload());
  }
});

els.frame.addEventListener('load', () => {
  setLoading(false);
  if (activeTab()) {
    setNote('loaded');
  }
});

/* ------------------------------------------------------------------ actions */
$('newTab').addEventListener('click', () => createTab());
$('backBtn').addEventListener('click', goBack);
$('forwardBtn').addEventListener('click', goForward);
$('reloadBtn').addEventListener('click', reload);
function goHome() {
  const tab = activeTab() ?? createTab();
  tab.url = null;
  tab.path = null;
  tab.title = 'New tab';
  showTab(tab);
  updateChrome(tab);
  renderStartpage();
  saveSession();
}

async function toggleBookmark() {
  const tab = activeTab();
  if (!tab?.url) return toast('Nothing to bookmark yet.');
  try {
    await api('/api/bookmarks', { method: 'POST', body: { url: tab.url, title: tab.title } });
    toast('Bookmarked');
    loadBookmarks();
  } catch (err) {
    toast(`Bookmark failed: ${err.message}`);
  }
}

$('homeBtn').addEventListener('click', goHome);
function setSidebar(open) {
  els.sidebar.classList.toggle('hidden', !open);
  const showScrim = open && isNarrow();
  els.scrim.hidden = !showScrim;
  document.body.classList.toggle('drawer-open', showScrim);
}

function toggleSidebar() {
  setSidebar(els.sidebar.classList.contains('hidden'));
}

$('sidebarBtn').addEventListener('click', toggleSidebar);
$('scrim').addEventListener('click', () => setSidebar(false));

// Tapping a history/bookmark entry on a phone should reveal the page, not
// leave the drawer covering it.
els.sidebar.addEventListener('click', (event) => {
  if (isNarrow() && event.target.closest('.item')) setSidebar(false);
});
$('errorDismiss').addEventListener('click', () => { els.errorbar.hidden = true; });

$('starBtn').addEventListener('click', toggleBookmark);
$('viewBtn').addEventListener('click', () => setViewMode(state.viewMode === 'desktop' ? 'fit' : 'desktop'));

$('omniboxForm').addEventListener('submit', (event) => {
  event.preventDefault();
  els.suggest.classList.remove('open');
  const tab = activeTab() ?? createTab();
  navigate(tab, els.omnibox.value);
  els.omnibox.blur();
});

els.omnibox.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const value = els.omnibox.value;
  suggestTimer = setTimeout(() => refreshSuggestions(value), 120);
});

els.omnibox.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSuggestion(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveSuggestion(-1); }
  else if (event.key === 'Enter' && state.suggestIndex >= 0) { event.preventDefault(); commitSuggestion(state.suggestIndex); }
  else if (event.key === 'Escape') { els.suggest.classList.remove('open'); els.omnibox.blur(); }
});

els.omnibox.addEventListener('blur', () => setTimeout(() => els.suggest.classList.remove('open'), 140));
els.omnibox.addEventListener('focus', () => els.omnibox.select());

$('startSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('startSearch').value;
  $('startSearch').value = '';
  navigate(activeTab() ?? createTab(), value);
});

$('historySearch').addEventListener('input', () => {
  clearTimeout($('historySearch')._t);
  $('historySearch')._t = setTimeout(loadHistory, 180);
});

$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Delete all browsing history?')) return;
  await api('/api/history', { method: 'DELETE' });
  loadHistory();
  loadFrequent();
  toast('History cleared');
});

$('clearCookies').addEventListener('click', async () => {
  if (!confirm('Forget every cookie stored for the proxied sites?')) return;
  await api('/api/cookies', { method: 'DELETE' });
  loadCookies();
  toast('Cookie jar emptied');
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
});

/* --------------------------------------------------------------------- menu */
function openMenu() {
  const rect = $('menuBtn').getBoundingClientRect();
  els.menu.style.top = `${rect.bottom + 6}px`;
  els.menu.style.left = `${Math.max(8, rect.right - 240)}px`;
  els.menu.classList.add('open');
}
$('menuBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  if (els.menu.classList.contains('open')) els.menu.classList.remove('open');
  else openMenu();
});
document.addEventListener('click', () => {
  els.menu.classList.remove('open');
  els.suggest.classList.remove('open');
});

els.menu.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  const tab = activeTab();
  els.menu.classList.remove('open');

  if (act === 'source') {
    if (!tab?.url) return toast('Nothing open.');
    return showSource(tab.url);
  }
  if (act === 'copy') {
    if (!tab?.url) return;
    await navigator.clipboard.writeText(tab.url).catch(() => {});
    return toast('Upstream URL copied');
  }
  if (act === 'openRaw') {
    if (!tab?.url) return;
    const { path } = await api('/api/mint', { method: 'POST', body: { url: tab.url, kind: 'asset' } });
    window.open(path, '_blank', 'noopener');
    return;
  }
  if (act === 'newtab') return createTab();
  if (act === 'sidebar') return toggleSidebar();
  if (act === 'home') return goHome();
  if (act === 'reload') return reload();
  if (act === 'bookmark') return toggleBookmark();
  if (act === 'viewmode') return setViewMode(state.viewMode === 'desktop' ? 'fit' : 'desktop');
  if (act === 'engine') return setTabEngine(tab, tab?.mode === 'chromium' ? 'proxy' : 'chromium');
  if (act === 'mobile') return toggleMobileView();
  if (act === 'find') return openFind();
  if (act === 'zoom-in') return zoomStep(1);
  if (act === 'zoom-out') return zoomStep(-1);
  if (act === 'zoom-reset') return applyZoom(1);
  if (act === 'clearcookies') {
    await api('/api/cookies', { method: 'DELETE' });
    loadCookies();
    return toast('Cookie jar emptied');
  }
  if (act === 'logout') {
    await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
    return;
  }
  if (act === 'shortcuts') {
    return showModal('Keyboard shortcuts', '', [
      'Ctrl/Cmd + T        new tab',
      'Ctrl/Cmd + W        close tab',
      'Ctrl/Cmd + L        focus address bar',
      'Ctrl/Cmd + R        reload',
      'Ctrl/Cmd + B        toggle sidebar',
      'Ctrl/Cmd + 1…9      switch tab',
      'Alt + ← / →         back / forward',
      'Esc                 close menus',
      '',
      'Note: keyboard events inside the page itself belong to the remote',
      'page, not the panel — click the panel chrome first if shortcuts',
      'seem unresponsive.',
    ].join('\n'));
  }
  return undefined;
});

/* -------------------------------------------------------------------- modal */
function showModal(title, sub, body) {
  els.modalTitle.textContent = title;
  els.modalSub.textContent = sub ?? '';
  els.modalBody.textContent = body ?? '';
  els.modal.classList.add('open');
}
els.modal.addEventListener('click', (event) => {
  if (event.target.dataset.close === '1') els.modal.classList.remove('open');
});

async function showSource(url) {
  showModal('Upstream source', url, 'Fetching…');
  try {
    const data = await api(`/api/source?url=${encodeURIComponent(url)}`);
    els.modalSub.textContent = `${data.status} · ${data.contentType} · ${(data.bytes / 1024).toFixed(0)} KB${data.truncated ? ' (truncated)' : ''}`;
    els.modalBody.textContent = data.source;
  } catch (err) {
    els.modalBody.textContent = `Could not fetch source: ${err.message}`;
  }
}

/* --------------------------------------------------------------- side tabs */
$('sideTabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-panel]');
  if (!button) return;
  [...$('sideTabs').children].forEach((child) => child.classList.toggle('active', child === button));
  [...document.querySelectorAll('.side-panel')].forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${button.dataset.panel}`);
  });
  const name = button.dataset.panel;
  if (name === 'history') loadHistory();
  if (name === 'bookmarks') loadBookmarks();
  if (name === 'frequent') loadFrequent();
  if (name === 'cookies') loadCookies();
  if (name === 'about') loadInfo();
});

/* ------------------------------------------------------------- view mode */
function applyViewMode() {
  const vp = document.querySelector('.viewport');
  if (!vp) return;
  const desktop = state.viewMode === 'desktop';
  vp.classList.toggle('desktop', desktop);

  if (desktop) {
    // Emulate a desktop layout viewport and scale the whole frame down, so the
    // page's own CSS sees 1280px while the phone still shows all of it.
    const width = Math.max(1, vp.clientWidth);
    const height = Math.max(1, vp.clientHeight);
    const scale = width / DESKTOP_WIDTH;
    vp.style.setProperty('--dv-width', `${DESKTOP_WIDTH}px`);
    vp.style.setProperty('--dv-scale', String(scale.toFixed(4)));
    vp.style.setProperty('--dv-height', `${Math.round(height / scale)}px`);
  } else {
    vp.style.removeProperty('--dv-width');
    vp.style.removeProperty('--dv-scale');
    vp.style.removeProperty('--dv-height');
  }

  applyZoom(state.zoom, { persist: false });

  $('viewBtn').title = desktop ? 'Switch to fit-width view' : 'Switch to desktop viewport';
  $('viewBtn').textContent = desktop ? '▣' : '▭';
  const item = $('viewModeItem');
  if (item) item.textContent = `Desktop viewport: ${desktop ? 'on' : 'off'}`;
}

function setViewMode(mode) {
  state.viewMode = mode === 'desktop' ? 'desktop' : 'fit';
  try { localStorage.setItem('bp.viewMode', state.viewMode); } catch { /* ignore */ }
  applyViewMode();
  toast(state.viewMode === 'desktop' ? 'Desktop viewport on — pinch to read' : 'Fit to screen');
}

/* ---------------------------------------------------- responsive plumbing */
let lastNarrow = null;
function syncLayout() {
  const narrow = isNarrow();
  if (narrow !== lastNarrow) {
    // Entering phone layout: start with the drawer closed. Leaving it: the
    // sidebar is a column again, so make sure it isn't left translated away.
    setSidebar(!narrow);
    lastNarrow = narrow;
  }
  state.narrow = narrow;
  applyViewMode();
}

window.addEventListener('resize', syncLayout);
window.addEventListener('orientationchange', () => setTimeout(syncLayout, 120));
// Mobile keyboards and URL-bar collapse resize the *visual* viewport without
// firing a window resize on some browsers.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(syncLayout._t);
    syncLayout._t = setTimeout(syncLayout, 80);
  });
}

/* --------------------------------------------- live Chromium engine mode */
function refreshEngineUi() {
  const ok = state.engine.available;
  $('statusEngine2').textContent = `engine: ${ok ? 'chromium' : 'proxy'}`;
  $('statusEngine2').className = `pill ${ok ? 'chromium' : 'proxy'}`;
  $('engineBtn').style.opacity = ok ? '' : '0.45';
  $('engineBtn').title = ok
    ? 'Switch engine for this tab (Chromium / proxy)'
    : state.engine.hint || 'Chromium is not available on this instance';
  els.errorChromium.hidden = !ok;
  updateEngineLabel();
}

function updateEngineLabel() {
  const tab = activeTab();
  const mode = tab?.mode ?? 'proxy';
  els.engineItem.textContent = mode;
  $('engineBtn').textContent = mode === 'chromium' ? '◉' : '◎';
  els.mobileItem.textContent = state.mobileView ? 'on' : 'off';
  $('mobileBtn').textContent = state.mobileView ? '▮' : '▯';

  // The header chip used to be static markup from the pre-Chromium build, so
  // it kept claiming "no chromium" while a live Chromium tab was on screen.
  const chip = $('engineChip');
  if (chip) {
    const live = mode === 'chromium';
    chip.innerHTML = live
      ? '<b>chromium</b> · live'
      : '<b>proxy webview</b> · no chromium';
    chip.title = live
      ? 'This tab is a live Chromium session streamed over WebSocket'
      : 'This tab is rendered by your own browser through the proxy';
    chip.classList.toggle('live', live);
  }
  const sub = $('startSub');
  if (sub) {
    sub.textContent = state.engine.available
      ? 'Remote browser panel · live Chromium engine'
      : 'Remote browser panel · proxy webview engine';
  }
}

/** Create the viewer once, lazily — it opens a WebSocket. */
function ensureViewer() {
  if (state.viewer) return state.viewer;
  const View = window.BP_VIEW?.ChromiumView;
  if (!View) return null;
  state.viewer = new View(els.liveview, {
    onStatus: onViewerStatus,
    onEvent: onViewerEvent,
  });
  return state.viewer;
}

function onViewerStatus(status) {
  const badge = els.liveBadge;
  switch (status.status) {
    case 'connecting':
      badge.textContent = 'connecting…';
      badge.className = 'livebadge';
      break;
    case 'open':
      badge.textContent = 'connected';
      badge.className = 'livebadge ok';
      break;
    case 'ready': {
      const s = status.engine;
      badge.textContent = s?.version ? `chromium ${s.version.split('.')[0]} · live` : 'live';
      badge.className = 'livebadge ok';
      break;
    }
    case 'closed':
      badge.textContent = 'reconnecting…';
      badge.className = 'livebadge';
      break;
    case 'error':
      badge.textContent = 'offline';
      badge.className = 'livebadge bad';
      showLiveHint(status.message || 'The live browser connection failed.');
      break;
    default:
      break;
  }
  updateStatusBar();
}

function onViewerEvent(msg) {
  const tab = msg.tabId ? state.tabs.find((t) => t.id === msg.tabId) : activeTab();

  switch (msg.t) {
    case 'nav': {
      if (!tab || !msg.url || msg.url === 'about:blank') break;
      if (tab.url !== msg.url) {
        tab.url = msg.url;
        tab.path = null; // no proxied path in Chromium mode
        if (tab.history[tab.index] !== msg.url) {
          tab.history = tab.history.slice(0, tab.index + 1);
          tab.history.push(msg.url);
          tab.index = tab.history.length - 1;
        }
      }
      if (tab.id === state.activeId) updateChrome(tab);
      renderTabs();
      saveSession();
      break;
    }

    case 'title':
      if (tab && msg.title) {
        tab.title = String(msg.title).slice(0, 140);
        renderTabs();
      }
      break;

    case 'loading':
      setLoading(Boolean(msg.loading));
      break;

    case 'error':
      showError(msg.message || 'The browser reported an error.', () => reload());
      break;

    case 'page-error':
      setNote(`page script error: ${String(msg.message).slice(0, 50)}`);
      break;

    case 'download': {
      const link = `/download/${msg.id}`;
      showLiveHint(
        `Download ready: <b>${escapeHtml(msg.name)}</b> — <a href="${link}">save it</a>`,
        { sticky: true },
      );
      break;
    }

    case 'evicted':
      toast(msg.message || 'Tab suspended to free memory.');
      if (tab && tab.mode === 'chromium') {
        tab.mode = 'proxy';
        if (tab.id === state.activeId) showTab(tab, { force: true });
      }
      break;

    case 'viewport':
      state.mobileView = Boolean(msg.mobile);
      updateEngineLabel();
      break;

    case 'find':
      state.find.count = msg.count ?? 0;
      state.find.index = msg.index ?? -1;
      els.findCount.textContent = state.find.count ? `${state.find.index + 1}/${state.find.count}` : 'no matches';
      break;

    case 'panel-key':
      if (msg.key === 'f') openFind();
      if (msg.key === '0') applyZoom(1);
      break;

    default:
      break;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function showLiveHint(html, { sticky = false } = {}) {
  els.liveHint.innerHTML = html;
  els.liveHint.hidden = false;
  clearTimeout(showLiveHint._t);
  if (!sticky) showLiveHint._t = setTimeout(() => { els.liveHint.hidden = true; }, 6000);
}

async function loadEngineInfo() {
  try {
    state.engine = await api('/api/engine');
  } catch {
    state.engine = { available: false, status: 'unavailable', hint: 'Could not query the engine.' };
  }
  state.engineDefault = state.engine.available ? 'chromium' : 'proxy';
  refreshEngineUi();
}

function setTabEngine(tab, mode) {
  if (!tab) return;
  const target = mode === 'chromium' && !state.engine.available ? 'proxy' : mode;
  if (target === tab.mode) return;

  if (target === 'proxy' && state.viewer) {
    state.viewer.close(tab.id);
  }
  tab.mode = target;
  showTab(tab, { force: true });
  renderTabs();
  toast(target === 'chromium' ? 'Switched to the live Chromium engine' : 'Switched to the lightweight proxy engine');
  saveSession();
}

function toggleMobileView() {
  state.mobileView = !state.mobileView;
  if (activeTab()?.mode === 'chromium') {
    state.viewer?.command({ t: 'viewport', width: 390, height: 844, mobile: state.mobileView });
  }
  updateEngineLabel();
  toast(state.mobileView ? 'Mobile viewport on' : 'Desktop viewport');
}

/* ------------------------------------------------- zoom & find, both engines */

// The proxy engine reports back whether the page could do native CSS zoom;
// Chromium always can (it zooms the page itself, no transform involved).
state.zoomNative = true;

// Talk to the proxy iframe. Chromium tabs go over the WebSocket instead.
function framePost(payload) {
  const win = els.frame?.contentWindow;
  if (!win) return;
  try {
    win.postMessage({ __bpCmd: 1, ...payload }, '*');
  } catch {
    /* iframe not loaded, or sandboxed away from us */
  }
}

function applyZoom(level, { persist = true } = {}) {
  state.zoom = Math.max(0.25, Math.min(3, Number(level) || 1));
  const tab = activeTab();

  if (tab?.mode === 'chromium') {
    // Chromium reflows the page for real via Emulation.setPageScaleFactor, so
    // text stays crisp and there is no iframe transform to fight with.
    state.viewer?.command({ t: 'zoom', tabId: tab.id, level: state.zoom });
  } else {
    framePost({ type: 'zoom', level: state.zoom });
    // Scale the iframe only if the page told us native CSS zoom failed, and
    // never in desktop-viewport mode — that mode already owns the transform.
    const useFallback = !state.zoomNative && state.viewMode !== 'desktop';
    els.frame.style.transformOrigin = '0 0';
    els.frame.style.transform = useFallback ? `scale(${state.zoom})` : '';
    els.frame.style.width = useFallback ? `${100 / state.zoom}%` : '';
    els.frame.style.height = useFallback ? `${100 / state.zoom}%` : '';
  }

  const pct = Math.round(state.zoom * 100);
  $('zoomItem').textContent = `Reset zoom (${pct}%)`;
  const pill = $('statusZoom');
  if (pill) pill.textContent = `${pct}%`;
  if (persist) {
    try { localStorage.setItem('bp.zoom', String(state.zoom)); } catch { /* private mode */ }
  }
}

function zoomStep(direction) {
  const i = ZOOM_STEPS.findIndex((v) => Math.abs(v - state.zoom) < 0.001);
  const next = i === -1
    // Not on a rung (e.g. restored from storage): snap to the nearest one.
    ? ZOOM_STEPS.reduce((best, v) => (Math.abs(v - state.zoom) < Math.abs(best - state.zoom) ? v : best), 1)
    : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + direction))];
  applyZoom(next);
}

function runFind(query, step) {
  state.find.query = query ?? '';
  const tab = activeTab();

  if (!state.find.query) {
    if (tab?.mode === 'chromium') state.viewer?.command({ t: 'find', tabId: tab.id, query: '' });
    else framePost({ type: 'find', query: null });
    els.findCount.textContent = '0/0';
    return;
  }

  if (tab?.mode === 'chromium') {
    state.viewer?.command({ t: 'find', tabId: tab.id, query: state.find.query, step: step ?? 0 });
  } else {
    framePost({ type: 'find', query: state.find.query });
    if (step) framePost({ type: 'find-step', dir: step });
  }
}

function openFind() {
  if (!activeTab()) return toast('Open a page first.');
  state.find.open = true;
  els.findbar.hidden = false;
  els.findInput.focus();
  els.findInput.select();
  if (state.find.query) runFind(state.find.query);
}

function closeFind() {
  state.find.open = false;
  els.findbar.hidden = true;
  runFind('');            // clears highlights in whichever engine is active
  els.findCount.textContent = '0/0';
}

function updateStatusBar() {
  const stats = state.viewer?.stats;
  if (!stats || activeTab()?.mode !== 'chromium') return;
  $('statusNote').textContent = stats.connected
    ? `live ${stats.fps}fps · ${stats.width}×${stats.height} · ${stats.frames} frames`
    : 'live browser offline';
}

$('engineBtn').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  setTabEngine(tab, tab.mode === 'chromium' ? 'proxy' : 'chromium');
});
$('mobileBtn').addEventListener('click', toggleMobileView);
els.errorChromium.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  setTabEngine(tab, 'chromium');
  els.errorbar.hidden = true;
});
setInterval(updateStatusBar, 1000);

/* ------------------------------------------------------------- find bar UI */
let findDebounce = null;
els.findInput.addEventListener('input', () => {
  clearTimeout(findDebounce);
  // Debounced: every keystroke re-highlights the page, which is expensive on
  // a big document and pointless while someone is still typing.
  findDebounce = setTimeout(() => runFind(els.findInput.value.trim()), 180);
});
els.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runFind(els.findInput.value.trim(), event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  }
});
$('findPrev').addEventListener('click', () => runFind(els.findInput.value.trim(), -1));
$('findNext').addEventListener('click', () => runFind(els.findInput.value.trim(), 1));
$('findClose').addEventListener('click', closeFind);

/* -------------------------------------------------------------- shortcuts */
window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    if (state.find.open) { closeFind(); return; }
    els.modal.classList.remove('open');
    els.menu.classList.remove('open');
    els.suggest.classList.remove('open');
    if (isNarrow() && !els.sidebar.classList.contains('hidden')) setSidebar(false);
    return;
  }
  if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); return; }
  if (mod && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoomStep(1); return; }
  if (mod && (event.key === '-' || event.key === '_')) { event.preventDefault(); zoomStep(-1); return; }
  if (mod && event.key === '0') { event.preventDefault(); applyZoom(1); return; }
  if (mod && event.key.toLowerCase() === 't') { event.preventDefault(); createTab(); return; }
  if (mod && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (state.activeId) closeTab(state.activeId);
    return;
  }
  if (mod && event.key.toLowerCase() === 'l') { event.preventDefault(); els.omnibox.focus(); return; }
  if (mod && event.key.toLowerCase() === 'r') { event.preventDefault(); reload(); return; }
  if (mod && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); return; }
  if (mod && /^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    if (state.tabs[index]) { event.preventDefault(); selectTab(state.tabs[index].id); }
    return;
  }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); return; }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
});

/* ------------------------------------------------------------ session save */
function saveSession() {
  try {
    const payload = {
      activeId: state.activeId,
      tabs: state.tabs.map((tab) => ({
        id: tab.id, title: tab.title, url: tab.url, path: tab.path, mode: tab.mode,
        history: tab.history.slice(-40), index: Math.min(tab.index, 39),
      })),
    };
    localStorage.setItem('bp.session', JSON.stringify(payload));
  } catch {
    /* quota / disabled storage: not fatal */
  }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('bp.session');
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.tabs) || !payload.tabs.length) return false;
    state.tabs = payload.tabs.map((tab) => ({
      id: tab.id || nextId(),
      title: tab.title || 'New tab',
      url: tab.url ?? null,
      path: tab.path ?? null,
      mode: tab.mode === 'chromium' ? 'chromium' : 'proxy',
      history: Array.isArray(tab.history) ? tab.history : [],
      index: Number.isInteger(tab.index) ? tab.index : (tab.history?.length ?? 1) - 1,
      loading: false,
    }));
    state.activeId = payload.activeId && state.tabs.some((t) => t.id === payload.activeId)
      ? payload.activeId
      : state.tabs[0].id;
    renderTabs();
    showTab(activeTab());
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- boot */
async function boot() {
  try {
    const savedMode = localStorage.getItem('bp.viewMode');
    if (savedMode === 'desktop' || savedMode === 'fit') state.viewMode = savedMode;
    const savedZoom = Number(localStorage.getItem('bp.zoom'));
    if (Number.isFinite(savedZoom) && savedZoom >= 0.25 && savedZoom <= 3) state.zoom = savedZoom;
  } catch {
    /* ignore */
  }

  try {
    await loadInfo();
  } catch {
    /* info is cosmetic; the API calls below will surface real failures */
  }

  syncLayout();
  applyViewMode();
  await loadEngineInfo();
  loadHistory();
  loadTilesHint();
  if (!restoreSession()) createTab();
  setNote('ready');
  setInterval(async () => {
    try {
      const info = await api('/api/info');
      state.info = info;
      $('statusMem').textContent = `${info.memory_mb.rss} MB`;
    } catch {
      /* ignore */
    }
  }, 30_000);
}

function loadTilesHint() {
  if (els.startpage.hidden) return;
  renderStartpage();
}

boot();
