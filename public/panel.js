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
  historyList: $('historyList'), bookmarkList: $('bookmarkList'),
  frequentList: $('frequentList'), cookieList: $('cookieList'), infoBox: $('infoBox'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalSub: $('modalSub'),
  toast: $('toast'), errorbar: $('errorbar'), errorMsg: $('errorMsg'),
  sidebar: $('sidebar'), menu: $('menu'),
};

const state = {
  tabs: [],
  activeId: null,
  info: null,
  suggestions: [],
  suggestIndex: -1,
  lastSearch: '',
};

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
    history: [],
    index: -1,
    loading: false,
  };
  state.tabs.push(tab);
  if (activate) state.activeId = tab.id;
  renderTabs();
  if (activate) showTab(tab);
  if (url) navigate(tab, url, { record: false });
  else renderStartpage();
  saveSession();
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
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
  saveSession();
}

function showTab(tab) {
  if (!tab) return;
  updateChrome(tab);
  if (tab.path) {
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
  if (!tab || tab.index <= 0) return;
  tab.index -= 1;
  const url = tab.history[tab.index];
  mintAndLoad(tab, url, { record: false });
}

function goForward() {
  const tab = activeTab();
  if (!tab || tab.index >= tab.history.length - 1) return;
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

function setNote(text) { $('statusNote').textContent = text; }

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
      row.addEventListener('mousedown', (event) => {
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
$('homeBtn').addEventListener('click', () => {
  const tab = activeTab() ?? createTab();
  tab.url = null;
  tab.path = null;
  showTab(tab);
  updateChrome(tab);
});
$('sidebarBtn').addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
$('errorDismiss').addEventListener('click', () => { els.errorbar.hidden = true; });

$('starBtn').addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab?.url) return toast('Nothing to bookmark yet.');
  try {
    await api('/api/bookmarks', { method: 'POST', body: { url: tab.url, title: tab.title } });
    toast('Bookmarked');
    loadBookmarks();
  } catch (err) {
    toast(`Bookmark failed: ${err.message}`);
  }
});

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

/* -------------------------------------------------------------- shortcuts */
window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    els.modal.classList.remove('open');
    els.menu.classList.remove('open');
    els.suggest.classList.remove('open');
    return;
  }
  if (mod && event.key.toLowerCase() === 't') { event.preventDefault(); createTab(); return; }
  if (mod && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (state.activeId) closeTab(state.activeId);
    return;
  }
  if (mod && event.key.toLowerCase() === 'l') { event.preventDefault(); els.omnibox.focus(); return; }
  if (mod && event.key.toLowerCase() === 'r') { event.preventDefault(); reload(); return; }
  if (mod && event.key.toLowerCase() === 'b') { event.preventDefault(); els.sidebar.classList.toggle('hidden'); return; }
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
        id: tab.id, title: tab.title, url: tab.url, path: tab.path,
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
    await loadInfo();
  } catch {
    /* info is cosmetic; the API calls below will surface real failures */
  }
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
