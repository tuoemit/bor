'use strict';

/* eslint-disable no-console */

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    connDot: $('connDot'),
    enginePill: $('enginePill'),
    sessionSelect: $('sessionSelect'),
    sideToggle: $('sideToggle'),
    logoutBtn: $('logoutBtn'),
    backBtn: $('backBtn'),
    fwdBtn: $('fwdBtn'),
    reloadBtn: $('reloadBtn'),
    homeBtn: $('homeBtn'),
    urlForm: $('urlForm'),
    urlInput: $('urlInput'),
    lockIcon: $('lockIcon'),
    shotBtn: $('shotBtn'),
    extractBtn: $('extractBtn'),
    devBtn: $('devBtn'),
    streamCheck: $('streamCheck'),
    tabStrip: $('tabStrip'),
    viewport: $('viewport'),
    screen: $('screen'),
    overlay: $('overlay'),
    overlayText: $('overlayText'),
    focusHint: $('focusHint'),
    side: $('side'),
    eventList: $('eventList'),
    autoEvents: $('autoEvents'),
    clearEvents: $('clearEvents'),
    runExtract: $('runExtract'),
    copyText: $('copyText'),
    extractMeta: $('extractMeta'),
    extractLinks: $('extractLinks'),
    extractText: $('extractText'),
    exampleSelect: $('exampleSelect'),
    runScript: $('runScript'),
    scriptBox: $('scriptBox'),
    scriptSession: $('scriptSession'),
    scriptOut: $('scriptOut'),
    refreshFiles: $('refreshFiles'),
    fileList: $('fileList'),
    statusBlock: $('statusBlock'),
    statConn: $('statConn'),
    statFps: $('statFps'),
    statRtt: $('statRtt'),
    statMem: $('statMem'),
    statViewport: $('statViewport'),
    statScroll: $('statScroll'),
    statEngine: $('statEngine'),
    devModal: $('devModal'),
    devBox: $('devBox'),
    devRun: $('devRun'),
    devClose: $('devClose'),
    devOut: $('devOut'),
    vpBtn: $('vpBtn'),
    mVpBtn: $('mVpBtn'),
    mSessionSelect: $('mSessionSelect'),
    mStreamCheck: $('mStreamCheck'),
    mLogout: $('mLogout'),
    qShot: $('qShot'),
    qExtract: $('qExtract'),
    qDev: $('qDev'),
    qHome: $('qHome'),
    qReload: $('qReload'),
    keybar: $('keybar'),
    keyInput: $('keyInput'),
    keyTab: $('keyTab'),
    keyBack: $('keyBack'),
    keyHide: $('keyHide'),
    keyToggle: $('keyToggle'),
    backdrop: $('backdrop'),
    sheetHandle: document.querySelector('.sheet-handle'),
  };

  const mqMobile = window.matchMedia('(max-width: 860px)');
  const isMobile = () => mqMobile.matches;

  const VP_PRESETS = {
    desktop: { width: 1280, height: 800 },
    mobile: { width: 412, height: 840 },
  };
  const isMobileVp = () => state.viewport && state.viewport.width < 700;

  const HOME = 'https://example.com';

  const state = {
    ws: null,
    connected: false,
    activeTabId: null,
    tabs: [],
    sessions: [],
    activeSessionId: null,
    engine: 'gecko',
    viewport: { width: 1280, height: 800 },
    frameCount: 0,
    lastFrameAt: 0,
    rtt: null,
    urlFocused: false,
    lastEventAt: 0,
    reconnectDelay: 500,
  };

  /* ------------------------------ helpers -------------------------- */

  const timers = [];
  const every = (fn, ms) => {
    timers.push(setInterval(() => {
      if (state.tearingDown) return;
      fn();
    }, ms));
  };

  /** Stop all polling + the socket before navigating away (logout / 401). */
  function teardown() {
    if (state.tearingDown) return;
    state.tearingDown = true;
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    if (state.ws) {
      try {
        state.ws.onclose = null;
        state.ws.close();
      } catch {
        /* ignore */
      }
      state.ws = null;
    }
  }

  async function api(path, options = {}) {
    if (state.tearingDown) throw new Error('client shutting down');
    const res = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'panel',
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      teardown();
      location.replace('/login');
      throw new Error('unauthorized');
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  function setConn(kind, label) {
    els.connDot.className = `dot ${kind}`;
    els.statConn.textContent = label;
  }

  function showOverlay(text) {
    if (text) els.overlayText.textContent = text;
    els.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    els.overlay.classList.add('hidden');
  }

  /** Brief, unmissable message (tab-cap errors, save confirmations, etc). */
  function toast(message, kind = 'info', ms = 3200) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, ms);
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '–';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  /* ------------------------------ websocket ------------------------ */

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.reconnectDelay = 500;
      setConn('ok', 'connected');
      els.enginePill.textContent = state.engine;
      if (state.activeTabId) subscribe(state.activeTabId);
      else bootstrap();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return onBinaryFrame(ev.data);
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello':
          state.engine = msg.engine || 'gecko';
          state.viewport = msg.viewport || state.viewport;
          els.enginePill.textContent = state.engine;
          els.statEngine.textContent = state.engine;
          els.statViewport.textContent = `${state.viewport.width}×${state.viewport.height}`;
          break;
        case 'subscribed':
          state.activeTabId = msg.tab.id;
          applyTabState(msg.tab);
          break;
        case 'frame':
          state.pendingFrameMeta = msg;
          break;
        case 'state':
          applyTabState(msg.tab);
          break;
        case 'pong':
          state.rtt = Date.now() - msg.t;
          els.statRtt.textContent = `${state.rtt} ms`;
          break;
        case 'error':
          pushEvent({ type: 'error', text: `${msg.code}: ${msg.message}` });
          break;
        default:
          break;
      }
    };

    ws.onerror = () => setConn('bad', 'socket error');

    ws.onclose = () => {
      state.connected = false;
      setConn('warn', 'reconnecting…');
      showOverlay('Connection lost — reconnecting…');
      state.ws = null;
      setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.7);
    };
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function onBinaryFrame(buf) {
    const meta = state.pendingFrameMeta || {};
    state.pendingFrameMeta = null;
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    const prev = els.screen.dataset.blobUrl;
    els.screen.onload = () => {
      if (prev) URL.revokeObjectURL(prev);
      hideOverlay();
    };
    els.screen.dataset.blobUrl = url;
    els.screen.src = url;
    state.frameCount += 1;
    state.lastFrameAt = Date.now();
    if (meta.width) els.statViewport.textContent = `${meta.width}px wide`;
  }

  function subscribe(tabId) {
    send({ type: 'subscribe', tabId });
  }

  /* ------------------------------- tabs ---------------------------- */

  function renderTabs() {
    els.tabStrip.innerHTML = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = `tab${tab.id === state.activeTabId ? ' active' : ''}`;
      const label = tab.title || tab.url || 'New tab';
      el.innerHTML = `<span class="title"></span><span class="x" title="Close">✕</span>`;
      el.querySelector('.title').textContent = tab.loading ? `⏳ ${label}` : label;
      el.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('x')) {
          closeTab(tab.id);
          return;
        }
        activateTab(tab.id);
      });
      els.tabStrip.appendChild(el);
    }
    const add = document.createElement('button');
    add.className = 'icon-btn tab-new';
    add.textContent = '+';
    add.title = 'New tab';
    add.addEventListener('click', () => newTab());
    els.tabStrip.appendChild(add);
  }

  async function refreshTabs() {
    const data = await api('/tabs');
    state.tabs = data.tabs;
    state.activeSessionId = data.activeSessionId;
    if (!state.activeTabId && data.tabs.length) state.activeTabId = data.activeTabId || data.tabs[0].id;
    renderTabs();
    return data;
  }

  async function newTab(url) {
    try {
      const tab = await api('/tabs', { method: 'POST', body: JSON.stringify({ url: url || null }) });
      await refreshTabs();
      state.activeTabId = tab.id;
      renderTabs();
      subscribe(tab.id);
      showOverlay('Loading…');
    } catch (e) {
      pushEvent({ type: 'error', text: e.message });
      toast(e.message, 'error');
    }
  }

  async function closeTab(id) {
    await api(`/tabs/${id}`, { method: 'DELETE' }).catch(() => {});
    if (state.activeTabId === id) state.activeTabId = null;
    const data = await refreshTabs();
    if (!state.activeTabId && data.tabs.length) {
      state.activeTabId = data.tabs[0].id;
      subscribe(state.activeTabId);
    } else if (!data.tabs.length) {
      showOverlay('No tab open — creating one…');
      newTab();
    } else {
      subscribe(state.activeTabId);
    }
    renderTabs();
  }

  async function activateTab(id) {
    state.activeTabId = id;
    await api(`/tabs/${id}/active`, { method: 'POST' }).catch(() => {});
    renderTabs();
    subscribe(id);
  }

  function applyTabState(tab) {
    if (!tab) return;
    const idx = state.tabs.findIndex((t) => t.id === tab.id);
    if (idx >= 0) state.tabs[idx] = tab;
    else state.tabs.push(tab);
    if (tab.id === state.activeTabId && !state.urlFocused) {
      els.urlInput.value = tab.url === 'about:blank' ? '' : tab.url;
    }
    const secure = tab.url.startsWith('https://');
    els.lockIcon.textContent = tab.url.startsWith('http') ? (secure ? '🔒' : '⚠') : '–';
    els.lockIcon.className = `lock ${secure ? 'secure' : tab.url.startsWith('http') ? 'insecure' : ''}`;
    els.statScroll.textContent = tab.scroll ? `x ${Math.round(tab.scroll.x)}, y ${Math.round(tab.scroll.y)} · ${tab.content ? tab.content.height : 0}px tall` : '–';
    if (tab.viewport) {
      state.viewport = tab.viewport;
      updateVpButtons();
    }
    document.title = `${tab.title || 'Cloud Browser'} · Cloud Browser`;
    renderTabs();
  }

  /* ---------------------------- navigation ------------------------- */

  async function go(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    showOverlay('Loading…');
    els.urlInput.value = url;
    try {
      if (!state.activeTabId) await newTab(url);
      else {
        const res = await api('/navigate', { method: 'POST', body: JSON.stringify({ url, tabId: state.activeTabId }) });
        if (res.partial) pushEvent({ type: 'warn', text: res.warning || 'Navigation timed out' });
        applyTabState(res.tab);
      }
    } catch (e) {
      pushEvent({ type: 'error', text: e.message });
      hideOverlay();
    }
    // Keep the WebSocket stream pointed at the tab we just navigated, so
    // frames and injected input always target the same page.
    if (state.activeTabId) send({ type: 'subscribe', tabId: state.activeTabId });
    send({ type: 'refresh' });
  }

  /* ------------------------------ input ---------------------------- */

  /** The letterboxed sub-rect of <img> where the remote bitmap is painted. */
  function paintedRect() {
    const box = els.screen.getBoundingClientRect();
    const nw = els.screen.naturalWidth || state.viewport.width;
    const nh = els.screen.naturalHeight || state.viewport.height;
    const scale = Math.min(box.width / nw, box.height / nh);
    const pw = nw * scale;
    const ph = nh * scale;
    return {
      left: box.left + (box.width - pw) / 2,
      top: box.top + (box.height - ph) / 2,
      width: pw,
      height: ph,
      nw,
      nh,
    };
  }

  function coordsFrom(clientX, clientY) {
    const p = paintedRect();
    return {
      x: Math.max(0, Math.min(p.nw, Math.round(((clientX - p.left) / p.width) * p.nw))),
      y: Math.max(0, Math.min(p.nh, Math.round(((clientY - p.top) / p.height) * p.nh))),
    };
  }

  function toPageCoords(ev) {
    return coordsFrom(ev.clientX, ev.clientY);
  }

  function wireInput() {
    let lastMove = 0;

    els.viewport.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const { x, y } = toPageCoords(ev);
      send({ type: 'input', event: { type: 'mouse.click', x, y, button: 'right' } });
    });

    els.viewport.addEventListener('mousedown', (ev) => {
      if (ev.target !== els.screen) return;
      ev.preventDefault();
      els.viewport.focus();
      const { x, y } = toPageCoords(ev);
      send({ type: 'input', event: { type: 'mouse.down', x, y, button: buttonName(ev.button) } });
    });

    window.addEventListener('mouseup', (ev) => {
      if (!state.connected || ev.target !== els.screen) return;
      const { x, y } = toPageCoords(ev);
      send({ type: 'input', event: { type: 'mouse.up', x, y, button: buttonName(ev.button) } });
    });

    els.viewport.addEventListener('mousemove', (ev) => {
      const now = Date.now();
      if (now - lastMove < 40) return; // ~25 Hz is plenty and keeps the socket quiet
      lastMove = now;
      const { x, y } = toPageCoords(ev);
      send({ type: 'input', event: { type: 'mouse.move', x, y } });
    });

    els.viewport.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        send({ type: 'input', event: { type: 'scroll', deltaX: ev.deltaX, deltaY: ev.deltaY } });
      },
      { passive: false }
    );

    /* ---- touch: tap = click, swipe = scroll, hold = right-click ---- */
    let tStart = null;
    let tMoved = false;
    let holdFired = false;
    let holdTimer = null;
    let lastTouchScroll = 0;

    els.viewport.addEventListener(
      'touchstart',
      (ev) => {
        if (ev.touches.length !== 1) {
          tStart = null;
          clearTimeout(holdTimer);
          return;
        }
        const t = ev.touches[0];
        tStart = { x: t.clientX, y: t.clientY, at: Date.now() };
        tMoved = false;
        holdFired = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          if (tStart && !tMoved) {
            holdFired = true;
            const { x, y } = coordsFrom(tStart.x, tStart.y);
            send({ type: 'input', event: { type: 'mouse.click', x, y, button: 'right' } });
          }
        }, 550);
      },
      { passive: true }
    );

    els.viewport.addEventListener(
      'touchmove',
      (ev) => {
        ev.preventDefault(); // own the gesture: no native scroll/zoom of the panel
        if (!tStart || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        if (!tMoved && Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > 12) {
          tMoved = true;
          clearTimeout(holdTimer);
        }
        if (!tMoved) return;
        const now = Date.now();
        if (now - lastTouchScroll >= 30) {
          const p = paintedRect();
          const sx = p.nw / p.width;
          const sy = p.nh / p.height;
          const dx = Math.round((tStart.x - t.clientX) * sx);
          const dy = Math.round((tStart.y - t.clientY) * sy);
          if (dx || dy) send({ type: 'input', event: { type: 'scroll', deltaX: dx, deltaY: dy } });
          tStart.x = t.clientX;
          tStart.y = t.clientY;
          lastTouchScroll = now;
        }
      },
      { passive: false }
    );

    els.viewport.addEventListener(
      'touchend',
      () => {
        clearTimeout(holdTimer);
        if (tStart && !tMoved && !holdFired && Date.now() - tStart.at < 450) {
          const { x, y } = coordsFrom(tStart.x, tStart.y);
          send({ type: 'input', event: { type: 'mouse.click', x, y } });
          maybeShowKeyboard(x, y);
        }
        tStart = null;
      },
      { passive: true }
    );

    // Keys go to the remote page whenever the address bar is not focused.
    document.addEventListener('keydown', (ev) => {
      if (ev.target === els.keyInput) {
        // The on-screen typing bar: characters travel via its `input` event;
        // control keys are forwarded explicitly.
        if (['Enter', 'Backspace', 'Tab', 'Escape'].includes(ev.key) || ev.key.startsWith('Arrow')) {
          ev.preventDefault();
          if (ev.key === 'Escape') closeKeybar();
          else send({ type: 'input', event: { type: 'key.press', key: ev.key } });
        }
        return;
      }
      if (state.urlFocused) {
        if (ev.key === 'Escape') els.urlInput.blur();
        return;
      }
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      ev.preventDefault();
      const key = toPlaywrightKey(ev);
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        send({ type: 'input', event: { type: 'key.press', key } });
      } else if (ev.key.length === 1) {
        send({ type: 'input', event: { type: 'key.type', text: ev.key } });
      } else {
        send({ type: 'input', event: { type: 'key.press', key } });
      }
    }, true);

    els.urlInput.addEventListener('focus', () => {
      state.urlFocused = true;
      els.urlInput.select();
    });
    els.urlInput.addEventListener('blur', () => {
      state.urlFocused = false;
    });

    els.viewport.addEventListener('focus', () => {
      els.focusHint.classList.add('show');
      setTimeout(() => els.focusHint.classList.remove('show'), 1600);
    });
  }

  function buttonName(b) {
    return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
  }

  const KEY_MAP = {
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
  };

  function toPlaywrightKey(ev) {
    if (ev.key === 'Control') return 'Control';
    if (ev.key === 'Shift') return 'Shift';
    if (ev.key === 'Alt') return 'Alt';
    if (ev.key === 'Meta') return 'Meta';
    const base = KEY_MAP[ev.key] || (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key);
    const mods = [];
    if (ev.ctrlKey) mods.push('Control');
    if (ev.altKey) mods.push('Alt');
    if (ev.shiftKey && ev.key.length > 1) mods.push('Shift');
    if (ev.metaKey) mods.push('Meta');
    if (mods.length && !mods.includes(base)) return `${mods.join('+')}+${base}`;
    return base;
  }

  /* ------------------------------ events --------------------------- */

  function pushEvent(e) {
    const li = document.createElement('li');
    li.className = e.type === 'pageerror' || e.type === 'error' ? 'error' : e.type === 'warn' ? 'warn' : '';
    const t = new Date(e.at || Date.now()).toLocaleTimeString();
    li.innerHTML = `<span class="t">${t}</span> `;
    li.appendChild(document.createTextNode(`${e.type}: ${e.text || e.message || JSON.stringify(e)}`));
    els.eventList.prepend(li);
    while (els.eventList.children.length > 250) els.eventList.lastChild.remove();
  }

  async function pollEvents() {
    if (state.tearingDown || !els.autoEvents.checked || !state.activeTabId) return;
    try {
      const res = await fetch(`/api/events?tabId=${encodeURIComponent(state.activeTabId)}&since=${state.lastEventAt}`, {
        headers: { 'X-Requested-With': 'panel' },
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const e of data.events || []) {
        if (e.at > state.lastEventAt) state.lastEventAt = e.at;
        pushEvent({
          ...e,
          text: e.text || e.message || e.failure || `${e.type} ${e.url || ''}`.trim(),
        });
      }
    } catch {
      /* transient */
    }
  }

  /* ---------------------------- side panel ------------------------- */

  function wireSide() {
    document.querySelectorAll('.side-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.side-tabs button').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`pane-${btn.dataset.pane}`).classList.add('active');
        if (btn.dataset.pane === 'files') loadFiles();
        if (btn.dataset.pane === 'info') loadStatus();
      });
    });

    els.clearEvents.addEventListener('click', () => {
      els.eventList.innerHTML = '';
    });

    els.runExtract.addEventListener('click', runExtract);
    els.copyText.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.extractText.textContent);
        els.copyText.textContent = 'Copied ✓';
        setTimeout(() => (els.copyText.textContent = 'Copy text'), 1200);
      } catch {
        els.copyText.textContent = 'Blocked';
      }
    });
    els.refreshFiles.addEventListener('click', loadFiles);
    els.runScript.addEventListener('click', runScriptNow);
  }

  async function runExtract() {
    els.extractMeta.textContent = 'Extracting…';
    try {
      const data = await api(`/content?tabId=${encodeURIComponent(state.activeTabId || '')}`);
      els.extractMeta.textContent = `${data.title} · ${data.textLength.toLocaleString()} chars · ${data.images} images · ${data.forms.length} forms · ${data.inputs.length} inputs`;
      els.extractText.textContent = data.text;
      els.extractLinks.innerHTML = '';
      for (const link of data.links.slice(0, 200)) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = link.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = link.text || link.href;
        li.appendChild(a);
        els.extractLinks.appendChild(li);
      }
      switchPane('extract');
    } catch (e) {
      els.extractMeta.textContent = `Failed: ${e.message}`;
    }
  }

  async function loadFiles() {
    try {
      const data = await api('/downloads');
      els.fileList.innerHTML = '';
      if (!data.files.length) {
        const li = document.createElement('li');
        li.textContent = 'No downloads yet.';
        els.fileList.appendChild(li);
        return;
      }
      for (const f of data.files) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `/api/downloads/${f.name.split('/').map(encodeURIComponent).join('/')}`;
        a.textContent = f.name;
        li.appendChild(a);
        li.appendChild(document.createTextNode(` — ${fmtBytes(f.bytes)}`));
        els.fileList.appendChild(li);
      }
    } catch (e) {
      els.fileList.innerHTML = `<li>${e.message}</li>`;
    }
  }

  async function loadStatus() {
    try {
      const [status, health] = await Promise.all([api('/status'), api('/health')]);
      els.statusBlock.textContent = [
        `engine        ${status.engine} ${status.version || ''}`,
        `engine ready  ${status.engineReady}`,
        `uptime        ${Math.round(status.uptimeSeconds)}s`,
        `memory (rss)  ${fmtBytes(status.memory.rss)}`,
        `sessions      ${status.sessions.join(', ') || '(none)'}`,
        `active session${status.activeSessionId || ' –'}`,
        `tabs          ${status.tabs.length}/${status.limits.maxTabs} per session`,
        `viewport      ${status.viewport.width}×${status.viewport.height}`,
        `launch error  ${status.launchError || 'none'}`,
        '',
        `health        ${JSON.stringify(health)}`,
      ].join('\n');
    } catch (e) {
      els.statusBlock.textContent = `Failed: ${e.message}`;
    }
  }

  function switchPane(name) {
    document.querySelectorAll('.side-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.pane === name);
    });
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('active', p.id === `pane-${name}`);
    });
    openSide();
  }

  /* ---------------------------- automation ------------------------- */

  const EXAMPLES = {
    'Open a page and screenshot it': {
      steps: [
        { do: 'goto', url: 'https://news.ycombinator.com' },
        { do: 'waitForLoad' },
        { do: 'screenshot', name: 'hn', fullPage: true },
      ],
    },
    'Search Wikipedia and extract the result': {
      steps: [
        { do: 'goto', url: 'https://en.wikipedia.org/wiki/Special:Search' },
        { do: 'fill', selector: 'input[name="search"]', value: 'Gecko (software)' },
        { do: 'press', key: 'Enter' },
        { do: 'waitForLoad' },
        { do: 'extract', textLimit: 1500 },
      ],
    },
    'Log in and save the profile': {
      steps: [
        { do: 'goto', url: 'https://the-internet.herokuapp.com/login' },
        { do: 'fill', selector: '#username', value: 'tomsmith' },
        { do: 'fill', selector: '#password', value: 'SuperSecretPassword!' },
        { do: 'click', selector: 'button[type="submit"]' },
        { do: 'waitForLoad' },
        { do: 'extract', textLimit: 400 },
        { do: 'saveSession' },
      ],
    },
    'Collect headlines into JSON': {
      steps: [
        { do: 'goto', url: 'https://news.ycombinator.com' },
        { do: 'waitForLoad' },
        {
          do: 'eval',
          expression: 'Array.from(document.querySelectorAll(".titleline > a")).slice(0,10).map(a=>({title:a.textContent,href:a.href}))',
        },
      ],
    },
  };

  function wireAutomation() {
    for (const name of Object.keys(EXAMPLES)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      els.exampleSelect.appendChild(opt);
    }
    const saved = localStorage.getItem('cb.script');
    els.scriptBox.value = saved || JSON.stringify(EXAMPLES['Open a page and screenshot it'], null, 2);

    els.exampleSelect.addEventListener('change', () => {
      const ex = EXAMPLES[els.exampleSelect.value];
      if (ex) {
        els.scriptBox.value = JSON.stringify(ex, null, 2);
        localStorage.setItem('cb.script', els.scriptBox.value);
      }
    });
    els.scriptBox.addEventListener('input', () => localStorage.setItem('cb.script', els.scriptBox.value));
  }

  async function runScriptNow() {
    let body;
    try {
      body = JSON.parse(els.scriptBox.value);
    } catch (e) {
      els.scriptOut.textContent = `Invalid JSON: ${e.message}`;
      return;
    }
    els.runScript.disabled = true;
    els.scriptOut.textContent = 'Running…';
    showOverlay('Running script…');
    try {
      const payload = {
        steps: body.steps,
        continueOnError: Boolean(body.continueOnError),
        viewport: body.viewport,
      };
      const session = (els.scriptSession.value || '').trim();
      if (session) payload.sessionId = session;
      if (body.tabId) payload.tabId = body.tabId;
      const res = await api('/script', { method: 'POST', body: JSON.stringify(payload) });
      els.scriptOut.textContent = JSON.stringify(res, null, 2);
      await refreshTabs();
      if (res.tabId) subscribe(res.tabId);
    } catch (e) {
      els.scriptOut.textContent = `Failed: ${e.message}${e.code ? ` (${e.code})` : ''}`;
    } finally {
      hideOverlay();
      els.runScript.disabled = false;
      send({ type: 'refresh' });
    }
  }

  /* ----------------------------- sessions -------------------------- */

  async function switchSession(id) {
    try {
      await api('/sessions', { method: 'POST', body: JSON.stringify({ id }) });
      state.activeTabId = null;
      await refreshTabs();
      const tabs = state.tabs.filter((t) => t.sessionId === id);
      if (tabs.length) subscribe(tabs[0].id);
      else await newTab();
    } catch (e) {
      pushEvent({ type: 'error', text: e.message });
      toast(e.message, 'error');
    }
  }

  async function loadSessions() {
    const data = await api('/sessions');
    state.sessions = data.sessions;
    state.activeSessionId = data.activeSessionId;
    for (const sel of [els.sessionSelect, els.mSessionSelect]) {
      sel.innerHTML = '';
      for (const s of state.sessions) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.id}${s.active ? ' ●' : ''}${s.cookies ? ` (${s.cookies}🍪)` : ''}`;
        sel.appendChild(opt);
      }
      if (state.activeSessionId) sel.value = state.activeSessionId;
      sel.onchange = () => switchSession(sel.value);
    }
  }

  /* ------------------------------- misc ---------------------------- */

  async function screenshotDownload() {
    try {
      const res = await fetch(`/api/screenshot?tabId=${encodeURIComponent(state.activeTabId || '')}&fullPage=true&quality=88`, {
        headers: { 'X-Requested-With': 'panel' },
      });
      if (!res.ok) throw new Error(`Screenshot failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `screenshot-${Date.now()}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      pushEvent({ type: 'error', text: e.message });
    }
  }

  function wireDev() {
    els.devBtn.addEventListener('click', () => {
      els.devModal.hidden = false;
      els.devBox.focus();
    });
    els.devClose.addEventListener('click', () => {
      els.devModal.hidden = true;
    });
    els.devRun.addEventListener('click', async () => {
      els.devOut.textContent = 'Running…';
      try {
        const res = await api('/eval', {
          method: 'POST',
          body: JSON.stringify({ expression: els.devBox.value, tabId: state.activeTabId }),
        });
        els.devOut.textContent = JSON.stringify(res, null, 2);
      } catch (e) {
        els.devOut.textContent = `Error: ${e.message}`;
      }
    });
  }

  /* ------------------------- mobile: keyboard ---------------------- */

  function openKeybar() {
    els.keybar.classList.add('show');
    setTimeout(() => els.keyInput.focus({ preventScroll: true }), 60);
  }

  function closeKeybar() {
    els.keybar.classList.remove('show');
    els.keyInput.blur();
  }

  /** After a tap, if the remote page focused a field, raise the phone keyboard. */
  function maybeShowKeyboard() {
    if (!isMobile()) return;
    // The tap travels over the WebSocket and the probe over fetch; give the
    // click time to land before asking the page what it focused. Retry a few
    // times: focus can lag the click on slow pages.
    const FIELD_EXPR =
      "(() => { const a = document.activeElement; if (!a) return ''; const tag = a.tagName || ''; return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable) ? tag : ''; })()";
    const probe = (tries) => {
      api('/eval', {
        method: 'POST',
        body: JSON.stringify({ expression: FIELD_EXPR, tabId: state.activeTabId }),
      })
        .then((res) => {
          if (res.ok && res.value) openKeybar();
          else if (tries > 0) setTimeout(() => probe(tries - 1), 350);
        })
        .catch(() => {
          if (tries > 0) setTimeout(() => probe(tries - 1), 350);
        });
    };
    setTimeout(() => probe(4), 400);
  }

  function wireKeybar() {
    els.keyToggle.addEventListener('click', () => {
      if (els.keybar.classList.contains('show')) closeKeybar();
      else openKeybar();
    });
    els.keyHide.addEventListener('click', closeKeybar);
    els.keyBack.addEventListener('click', () => {
      if (window.__cb) window.__cb.keysSent += 1;
      send({ type: 'input', event: { type: 'key.press', key: 'Backspace' } });
    });
    els.keyTab.addEventListener('click', () => send({ type: 'input', event: { type: 'key.press', key: 'Tab' } }));

    els.keyInput.addEventListener('input', (ev) => {
      if (ev.inputType && ev.inputType.startsWith('delete')) {
        send({ type: 'input', event: { type: 'key.press', key: 'Backspace' } });
      } else if (ev.data) {
        if (window.__cb) window.__cb.keysSent += 1;
        send({ type: 'input', event: { type: 'key.type', text: ev.data, delay: 0 } });
      }
      // Keep the buffer empty so soft keyboards keep composing.
      requestAnimationFrame(() => {
        els.keyInput.value = '';
      });
    });
  }

  /* -------------------------- mobile: sheet ------------------------ */

  function openSide() {
    if (isMobile()) {
      els.side.classList.add('open');
      els.backdrop.classList.add('show');
    } else {
      els.side.classList.remove('collapsed');
    }
  }

  function closeSide() {
    if (isMobile()) {
      els.side.classList.remove('open');
      els.backdrop.classList.remove('show');
    } else {
      els.side.classList.add('collapsed');
    }
  }

  function toggleSide() {
    if (isMobile()) {
      if (els.side.classList.contains('open')) closeSide();
      else openSide();
    } else {
      els.side.classList.toggle('collapsed');
    }
  }

  /* ------------------------ viewport presets ----------------------- */

  function updateVpButtons() {
    const mob = isMobileVp();
    els.vpBtn.textContent = mob ? '🖥' : '📱';
    els.vpBtn.title = mob ? 'Render pages at desktop width' : 'Render pages at phone width';
    els.mVpBtn.textContent = mob ? '🖥 Desktop page' : '📱 Mobile page';
  }

  async function setViewportPreset(name, { quiet = false } = {}) {
    const p = VP_PRESETS[name];
    try {
      const res = await api('/viewport', {
        method: 'POST',
        body: JSON.stringify({ width: p.width, height: p.height, tabId: state.activeTabId }),
      });
      if (res.viewport) state.viewport = res.viewport;
      updateVpButtons();
      send({ type: 'refresh' });
      if (!quiet) toast(`Pages now render at ${p.width}×${p.height}`, 'ok', 1800);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function toggleViewport() {
    setViewportPreset(isMobileVp() ? 'desktop' : 'mobile');
  }

  async function bootstrap() {
    showOverlay('Starting Firefox…');
    try {
      await loadSessions();
      const data = await refreshTabs();
      if (!data.tabs.length) {
        await newTab(HOME);
      } else {
        state.activeTabId = data.activeTabId || data.tabs[0].id;
        renderTabs();
        subscribe(state.activeTabId);
      }
      // Phone clients get phone-width page rendering by default.
      if (isMobile() && !isMobileVp()) {
        await setViewportPreset('mobile', { quiet: true });
      }
    } catch (e) {
      showOverlay(`Could not start: ${e.message}`);
      pushEvent({ type: 'error', text: e.message });
    }
  }

  /* ------------------------------- boot ---------------------------- */

  function boot() {
    wireInput();
    wireSide();
    wireAutomation();
    wireDev();

    els.urlForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      go(els.urlInput.value);
    });
    els.backBtn.addEventListener('click', () => api('/back', { method: 'POST', body: JSON.stringify({ tabId: state.activeTabId }) }).catch(() => {}));
    els.fwdBtn.addEventListener('click', () => api('/forward', { method: 'POST', body: JSON.stringify({ tabId: state.activeTabId }) }).catch(() => {}));
    els.reloadBtn.addEventListener('click', () => {
      showOverlay('Reloading…');
      api('/reload', { method: 'POST', body: JSON.stringify({ tabId: state.activeTabId }) }).catch(() => {});
    });
    els.homeBtn.addEventListener('click', () => go(HOME));
    els.shotBtn.addEventListener('click', screenshotDownload);
    els.extractBtn.addEventListener('click', runExtract);
    async function doLogout() {
      teardown();
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
      }).catch(() => {});
      location.replace('/login');
    }
    els.logoutBtn.addEventListener('click', doLogout);
    els.mLogout.addEventListener('click', doLogout);

    async function doNewSession() {
      const id = prompt('New profile name (cookies + storage stay isolated):', `profile-${Date.now().toString(36)}`);
      if (!id) return;
      try {
        await api('/sessions', { method: 'POST', body: JSON.stringify({ id }) });
        state.activeTabId = null;
        await loadSessions();
        await refreshTabs();
        await newTab();
        if (isMobile()) closeSide();
      } catch (e) {
        pushEvent({ type: 'error', text: e.message });
        toast(e.message, 'error');
      }
    }

    async function doSaveSession(btn) {
      try {
        const res = await api(`/sessions/${encodeURIComponent(state.activeSessionId || 'default')}/save`, { method: 'POST' });
        pushEvent({ type: 'log', text: `Saved ${res.cookies} cookies / ${res.origins} origins for "${res.id}"` });
        toast(`Saved ${res.cookies} cookies for "${res.id}"`, 'ok');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = 'Saved ✓';
          setTimeout(() => (btn.textContent = orig), 1500);
        }
      } catch (e) {
        pushEvent({ type: 'error', text: e.message });
        toast(e.message, 'error');
      }
    }

    document.querySelectorAll('.js-new-session').forEach((b) => b.addEventListener('click', doNewSession));
    document.querySelectorAll('.js-save-session').forEach((b) => b.addEventListener('click', () => doSaveSession(b)));

    function setStream(on) {
      els.streamCheck.checked = on;
      els.mStreamCheck.checked = on;
      if (on) send({ type: 'subscribe', tabId: state.activeTabId });
      else send({ type: 'unsubscribe' });
    }
    els.streamCheck.addEventListener('change', () => setStream(els.streamCheck.checked));
    els.mStreamCheck.addEventListener('change', () => setStream(els.mStreamCheck.checked));

    // Side panel / bottom sheet.
    els.sideToggle.addEventListener('click', toggleSide);
    els.backdrop.addEventListener('click', closeSide);
    if (els.sheetHandle) els.sheetHandle.addEventListener('click', closeSide);

    // Viewport presets (phone-width vs desktop-width page rendering).
    els.vpBtn.addEventListener('click', toggleViewport);
    els.mVpBtn.addEventListener('click', toggleViewport);

    // Session-pane quick actions.
    els.qShot.addEventListener('click', screenshotDownload);
    els.qExtract.addEventListener('click', runExtract);
    els.qDev.addEventListener('click', () => {
      els.devModal.hidden = false;
      if (isMobile()) closeSide();
    });
    els.qHome.addEventListener('click', () => go(HOME));
    els.qReload.addEventListener('click', () => {
      showOverlay('Reloading…');
      api('/reload', { method: 'POST', body: JSON.stringify({ tabId: state.activeTabId }) }).catch(() => {});
    });

    wireKeybar();
    updateVpButtons();

    // Tiny read-only hook for the e2e suites (and curious humans).
    window.__cb = {
      keysSent: 0,
      get activeTab() {
        return state.activeTabId;
      },
      get connected() {
        return state.connected;
      },
    };

    every(() => send({ type: 'ping', t: Date.now() }), 5000);
    every(pollEvents, 2500);
    every(loadStatus, 10000);
    every(() => {
      const now = Date.now();
      const secs = (now - (state.fpsWindowStart || now)) / 1000 || 1;
      els.statFps.textContent = `${(state.frameCount / secs).toFixed(1)} fps`;
      state.frameCount = 0;
      state.fpsWindowStart = now;
      if (now - state.lastFrameAt > 30000 && state.connected && els.streamCheck.checked) {
        send({ type: 'refresh' });
      }
    }, 2000);

    connect();
  }

  boot();
})();
