/* Live Chromium viewer.
 *
 * Receives JPEG screencast frames over a WebSocket and paints them on a
 * canvas, then turns the user's mouse / keyboard / touch into input events
 * that the server replays into the real browser via CDP.
 *
 * Coordinates are normalised to 0..1 before they leave the browser, so the
 * canvas can be scaled, letterboxed or fitted however the panel likes and the
 * server never has to know the client's layout.
 */
'use strict';

const BP_VIEW = (() => {
  const MAX_BACKLOG = 1_500_000; // stop acking frames if the socket is drowning
  const RECONNECT_BASE_MS = 800;
  const RECONNECT_MAX_MS = 8000;

  class ChromiumView {
    constructor(root, { onEvent, onStatus } = {}) {
      this.root = root;
      this.canvas = root.querySelector('#chrCanvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.onEvent = onEvent || (() => {});
      this.onStatus = onStatus || (() => {});

      this.ws = null;
      this.tabId = null;
      this.connected = false;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.reconnectTimer = null;
      this.wantTab = null;

      this.frame = null;      // latest decoded ImageBitmap
      this.rendering = false;
      this.pending = null;    // latest frame waiting to be drawn
      this.lastFrameAt = 0;
      this.frameCount = 0;
      this.fpsWindow = [];
      this.viewport = { width: 1280, height: 800 };

      this.pressed = false;
      this.lastClickAt = 0;
      this.lastClickPos = { x: 0, y: 0 };
      this.touchStart = null;
      this.touchScrolled = false;

      this._bindInput();
      window.addEventListener('resize', () => this.resize());
      if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.resize());
    }

    /* ------------------------------------------------------------- socket */
    connect() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws/viewer`;
      this.onStatus({ status: 'connecting' });
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        this.onStatus({ status: 'error', message: 'WebSockets are unavailable here.' });
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.onStatus({ status: 'open' });
        if (this.wantTab) this.open(this.wantTab.tabId, this.wantTab.url);
      };

      ws.onmessage = async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        await this.handle(msg);
      };

      ws.onclose = (event) => {
        this.connected = false;
        this.canvas.style.opacity = '0.35';
        if (event.code === 4401) {
          this.onStatus({ status: 'error', message: 'Session expired — reload the panel to sign in again.' });
          return;
        }
        if (event.code === 4403) {
          this.onStatus({ status: 'error', message: 'The Chromium engine is not available on this instance.' });
          return;
        }
        this.onStatus({ status: 'closed' });
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        this.onStatus({ status: 'error', message: 'Could not reach the browser service.' });
      };
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wantTab) this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 1.7);
    }

    send(payload) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    /* ------------------------------------------------------------- protocol */
    async handle(msg) {
      switch (msg.t) {
        case 'hello':
          this.onStatus({ status: 'ready', engine: msg.status });
          return;

        case 'frame':
          this.onFrame(msg);
          return;

        case 'viewport':
          this.viewport = { width: msg.width, height: msg.height, mobile: msg.mobile };
          this.resize();
          this.onEvent(msg);
          return;

        case 'find':
          this.onEvent(msg);
          return;

        case 'screenshot': {
          const url = `data:image/png;base64,${msg.data}`;
          this.onEvent({ t: 'screenshot', tabId: msg.tabId, url });
          return;
        }

        case 'download':
          this.onEvent(msg);
          return;

        case 'evicted':
          this.onEvent({ t: 'evicted', tabId: msg.tabId, message: 'That tab was suspended to save memory.' });
          return;

        case 'unavailable':
          this.onStatus({ status: 'error', message: msg.status?.hint || 'Chromium is not available.' });
          return;

        default:
          this.onEvent(msg);
      }
    }

    /* ---------------------------------------------------------- frame paint */
    onFrame(msg) {
      if (msg.tabId !== this.tabId) return;
      this.frameCount += 1;
      const now = performance.now();
      this.lastFrameAt = now;
      this.fpsWindow.push(now);
      if (this.fpsWindow.length > 40) this.fpsWindow.shift();

      // Decode off the main thread, then draw the newest frame only. Dropping
      // stale frames this way keeps latency low on slow links.
      this.pending = msg.data;
      if (this.rendering) return;
      this.rendering = true;
      this.drainFrames();
    }

    async drainFrames() {
      try {
        while (this.pending) {
          const data = this.pending;
          this.pending = null;
          const binary = atob(data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          this.draw(bitmap);
          bitmap.close?.();
        }
      } catch {
        /* a corrupt frame is not fatal; the next one will repaint */
      } finally {
        this.rendering = false;
        this.canvas.style.opacity = '1';
      }
    }

    draw(bitmap) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = this.canvas.clientWidth || 1;
      const ch = this.canvas.clientHeight || 1;
      const targetW = Math.round(cw * dpr);
      const targetH = Math.round(ch * dpr);
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
      }

      const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const x = Math.round((targetW - w) / 2);
      const y = Math.round((targetH - h) / 2);

      this.ctx.fillStyle = '#0a0c11';
      this.ctx.fillRect(0, 0, targetW, targetH);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      this.ctx.drawImage(bitmap, x, y, w, h);
      this.imageRect = { x, y, w, h };
    }

    resize() {
      // The canvas is CSS-sized by layout; drawing again re-fits the last frame.
      if (this.lastBitmap) this.draw(this.lastBitmap);
    }

    /* --------------------------------------------------------------- input */
    /** Map a pointer event to normalised page coordinates (0..1). */
    pointFor(event) {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const img = this.imageRect ?? {
        x: 0,
        y: 0,
        w: this.canvas.width,
        h: this.canvas.height,
      };
      const px = (event.clientX - rect.left) * dpr;
      const py = (event.clientY - rect.top) * dpr;
      const nx = (px - img.x) / img.w;
      const ny = (py - img.y) / img.h;
      return { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
    }

    modifiersFor(event) {
      const mods = [];
      if (event.ctrlKey) mods.push('ctrl');
      if (event.altKey) mods.push('alt');
      if (event.shiftKey) mods.push('shift');
      if (event.metaKey) mods.push('meta');
      return mods;
    }

    clickCountFor(point) {
      const now = Date.now();
      const near =
        Math.abs(point.x - this.lastClickPos.x) < 0.01 && Math.abs(point.y - this.lastClickPos.y) < 0.01;
      const count = now - this.lastClickAt < 400 && near ? 2 : 1;
      this.lastClickAt = now;
      this.lastClickPos = point;
      return count;
    }

    _bindInput() {
      const canvas = this.canvas;
      canvas.tabIndex = 0;

      // --- mouse
      canvas.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'touch') return; // handled below
        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture?.(event.pointerId);
        this.pressed = true;
        const p = this.pointFor(event);
        this.send({
          t: 'mouse',
          tabId: this.tabId,
          kind: 'down',
          ...p,
          button: event.button,
          clickCount: 1,
          modifiers: this.modifiersFor(event),
        });
      });

      canvas.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'touch') return;
        if (!this.pressed) return; // hover is noisy; only send while dragging
        this.send({ t: 'mouse', tabId: this.tabId, kind: 'move', ...this.pointFor(event) });
      });

      canvas.addEventListener('pointerup', (event) => {
        if (event.pointerType === 'touch') return;
        this.pressed = false;
        const p = this.pointFor(event);
        const clickCount = this.clickCountFor(p);
        this.send({
          t: 'mouse',
          tabId: this.tabId,
          kind: clickCount === 2 ? 'dblclick' : 'click',
          ...p,
          button: event.button,
          clickCount,
          modifiers: this.modifiersFor(event),
        });
      });

      canvas.addEventListener('contextmenu', (event) => event.preventDefault());

      // --- wheel (trackpad + mouse wheel)
      canvas.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
          this.send({
            t: 'wheel',
            tabId: this.tabId,
            ...this.pointFor(event),
            dx: Math.round(event.deltaX * unit),
            dy: Math.round(event.deltaY * unit),
          });
        },
        { passive: false },
      );

      // --- touch: tap = click, drag = scroll (what a phone user expects)
      canvas.addEventListener(
        'touchstart',
        (event) => {
          if (event.touches.length !== 1) return;
          const t = event.touches[0];
          this.touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
          this.touchScrolled = false;
          this.lastTouch = { x: t.clientX, y: t.clientY };
        },
        { passive: true },
      );

      canvas.addEventListener(
        'touchmove',
        (event) => {
          if (event.touches.length !== 1 || !this.touchStart) return;
          event.preventDefault();
          const t = event.touches[0];
          const prev = this.lastTouch ?? { x: t.clientX, y: t.clientY };
          const dx = prev.x - t.clientX;
          const dy = prev.y - t.clientY;
          this.lastTouch = { x: t.clientX, y: t.clientY };
          if (Math.abs(dx) + Math.abs(dy) < 1) return;
          this.touchScrolled = true;
          this.send({ t: 'wheel', tabId: this.tabId, x: 0.5, y: 0.5, dx: Math.round(dx), dy: Math.round(dy) });
        },
        { passive: false },
      );

      const endTouch = (event) => {
        if (!this.touchStart) return;
        const start = this.touchStart;
        this.touchStart = null;
        const moved = this.touchScrolled;
        const duration = Date.now() - start.at;
        if (moved || duration > 700) return; // a scroll or a long press, not a tap
        const touch = event.changedTouches?.[0] ?? { clientX: start.x, clientY: start.y };
        const p = this.pointFor({ clientX: touch.clientX, clientY: touch.clientY });
        // A tap arrives as a click with coordinates: Chromium dispatches the
        // full hover/move/down/up sequence and sites behave normally.
        this.send({
          t: 'mouse',
          tabId: this.tabId,
          kind: 'click',
          ...p,
          button: 0,
          clickCount: 1,
          modifiers: [],
        });
      };
      canvas.addEventListener('touchend', endTouch, { passive: true });
      canvas.addEventListener('touchcancel', endTouch, { passive: true });

      // --- keyboard
      canvas.addEventListener('keydown', (event) => {
        if (!this.connected || !this.tabId) return;
        // Panel shortcuts stay with the panel; everything else goes to Chromium.
        const mod = event.ctrlKey || event.metaKey;
        const reserved = ['t', 'w', 'l', 'b', 'f', '0', '=', '+', '-', '_'];
        if (mod && reserved.includes(event.key.toLowerCase())) {
          // Ctrl+F and Ctrl+0 are still useful locally, so let them bubble.
          if (['f', '0'].includes(event.key.toLowerCase())) {
            this.onEvent({ t: 'panel-key', key: event.key.toLowerCase(), original: event });
          }
          return;
        }
        if (mod && /^[1-9]$/.test(event.key)) return;

        event.preventDefault();

        if (event.key.length === 1 && !mod && !event.altKey) {
          this.send({ t: 'key', tabId: this.tabId, kind: 'type', text: event.key });
          return;
        }
        this.send({
          t: 'key',
          tabId: this.tabId,
          kind: 'press',
          key: event.key,
          modifiers: this.modifiersFor(event),
        });
      });

      canvas.addEventListener('keypress', (event) => {
        // Some mobile keyboards only emit keypress; avoid double-inserting on
        // desktop by only using it when no keydown text was sent.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !this.sentKeydownText) {
          this.send({ t: 'key', tabId: this.tabId, kind: 'type', text: event.key });
        }
      });

      canvas.addEventListener('focus', () => this.onEvent({ t: 'focus' }));
    }

    /* ---------------------------------------------------------------- public */
    open(tabId, url) {
      this.wantTab = { tabId, url };
      this.tabId = tabId;
      const sent = this.send({ t: 'open', tabId, url });
      if (!sent) this.connect();
    }

    focus(tabId) {
      this.tabId = tabId;
      this.wantTab = { tabId, url: this.wantTab?.url ?? null };
      this.send({ t: 'focus', tabId });
    }

    close(tabId) {
      this.send({ t: 'close', tabId });
    }

    command(payload) {
      return this.send({ tabId: this.tabId, ...payload });
    }

    get stats() {
      const now = performance.now();
      const recent = this.fpsWindow.filter((t) => now - t < 1000).length;
      return {
        connected: this.connected,
        frames: this.frameCount,
        fps: recent,
        width: this.viewport.width,
        height: this.viewport.height,
      };
    }
  }

  return { ChromiumView, MAX_BACKLOG };
})();

window.BP_VIEW = BP_VIEW;
