# browser-panel

A **password-protected browsing panel** that runs on **Render or Railway free tier** — the same
repo deploys to both, unmodified.

It runs a **real Chromium** — the actual browser, driven over the Chrome DevTools Protocol — and
streams its screen to your panel as a live, fully interactive session. Click, type, scroll, open
tabs, download files: it is a browser, not a screenshot of one.

There is also a second, much lighter engine built in: a **server-side proxy webview** that fetches
and rewrites pages into an iframe rendered by your own browser. Fully-featured sites need Chromium;
the proxy costs ~150 MB instead of ~1 GB and is what lets the panel still work on a small instance.
Every tab picks its own engine.

```
┌─ your browser ────────────────────────────────────────────────┐
│  panel chrome: tabs, address bar, history, bookmarks, find     │
│  ┌─ live canvas (JPEG frames over WebSocket) ───────────────┐  │
│  │  whatever Chromium is showing, ~30 fps while it changes  │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────┬─────────────────────────────────────────────┬───────────┘
       │ input events (normalised x/y, keys, wheel)  │ frames
┌──────▼───────────────────── railway ───────────────▼───────────┐
│  Node + Express        CDP  ┌───────────────────────────────┐  │
│  auth · stats · sqlite  ◄──►│  Chromium (headless)          │  │
│  permissions · input     ──►│  real engine, real JS, real   │  │
│                             │  cookies, real downloads      │  │
│                             └───────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

```
┌─ your browser ──────────────────────────────────────────────┐
│  panel chrome (tabs, address bar, history, bookmarks)       │
│  ┌─ sandboxed iframe ────────────────────────────────────┐  │
│  │  fully rendered page — CSS, images, JS all live here  │  │
│  └───────────────────────────────────────────────────────┘  │
└───────────────┬─────────────────────────────────────────────┘
                │  /p/<signed-capability>/page/<base64 target>
┌───────────────▼─────────────── render / railway ────────────┐
│  express: auth · URL rewriting · cookie jar · sqlite state  │
│  fetch → strip X-Frame-Options/CSP → rewrite → stream back  │
└─────────────────────────────────────────────────────────────┘
```

---

## Deploy on Railway

Railway is the recommended target: it gives you the volume and the memory that
the browser needs, and it builds the included `Dockerfile` with no config.

### 1. Deploy

```bash
npm i -g @railway/cli
railway login
railway init                      # create a project
railway up                        # builds the Dockerfile and deploys
railway variables --set APP_PASSWORD='your-strong-password'
railway domain                    # generate a public https://*.up.railway.app URL
```

Or from the dashboard: **New Project → Deploy from GitHub repo**. Railway detects
`Dockerfile` + `railway.json`, and you add `APP_PASSWORD` under **Variables**.

### 2. Give it memory — this is the setting that matters

Chromium is a real browser and it costs real memory. Measured on this project
with one live tab on a heavy page (Wikipedia):

| What | Measured |
|---|---|
| Node + panel, browser **not** launched | ~150 MB |
| Chromium process tree, 1 tab | ~925 MB |
| **Total, 1 tab live** | **~1.07 GB** |
| After the engine shuts down | back to ~160 MB |

**Settings → Resources → Memory: 2 GB** (and at least 1 vCPU — 8 GB is not
needed; the engine idles low and peaks during page loads).

| Service memory | What works |
|---|---|
| 512 MB | Proxy engine only. Chromium refuses to start and the panel says why. |
| 1 GB | Chromium may start but will be killed under load. Not recommended. |
| **2 GB** | The real thing — live Chromium, up to 3 tabs. **Recommended.** |
| 4 GB | 3 tabs plus headroom; raise `MAX_BROWSER_TABS` if you want more. |

The app reads its cgroup limit at boot and **refuses to launch Chromium below
`CHROMIUM_MIN_MEMORY_MB` (1800)** rather than getting OOM-killed mid-browse —
the log and the About pane tell you the exact limit it detected.

Left alone, the engine stops itself after 10 minutes with no tabs open
(`BROWSER_IDLE_SHUTDOWN_MS`), returning the container to ~160 MB. Tabs you
aren't looking at are suspended after 15 minutes (`TAB_SLEEP_MS`).

### 3. Add a volume (makes it a real browser, not a demo)

Without a volume, history, bookmarks, cookies and saved sessions are lost on every
redeploy and restart — on Railway that's every push.

**Settings → Volumes → New Volume**, mount path **`/data`**.

That's all: the image already sets `DB_PATH=/data/browser.db`, so the next deploy
comes up persistent. Check **About** in the sidebar — it says *persistent* with the
path when the volume is mounted, *in-memory* when it isn't.

> The volume can only attach to one replica, which is why `railway.json` pins
> `numReplicas: 1`. Session signing is stateless, so horizontal scaling would
> work for *logins* — it's the SQLite history/cookies that need the single copy.

### 4. Recommended variables

| Variable | Value | Why |
|---|---|---|
| `APP_PASSWORD` | *required* | Panel password. Without it, a random one is printed to the logs each boot. |
| `SESSION_SECRET` | any long random string | Keeps you logged in across password changes and redeploys. |
| `APP_ENGINE` | `chromium` (default) / `proxy` | `proxy` = never launch Chromium; the panel falls back to the proxy engine. |
| `CHROMIUM_MIN_MEMORY_MB` | `1800` | Refuse to launch below this container limit. |
| `MAX_BROWSER_TABS` | `3` | Live tabs. Each costs ~80–150 MB. |
| `BROWSER_IDLE_SHUTDOWN_MS` | `600000` | Stop Chromium after 10 min with no tabs, freeing ~900 MB. |
| `TAB_SLEEP_MS` | `900000` | Suspend a tab after 15 min off-screen. |
| `BROWSER_JPEG_QUALITY` | `62` | Stream quality. Lower = less bandwidth to your phone. |
| `BROWSER_WIDTH` / `BROWSER_HEIGHT` | `1280` / `800` | Virtual screen the page is laid out at. |
| `CSP_FRAME_ANCESTORS` | leave as `self` | Only widen if you embed the panel in another site. |

### 5. What it costs

Railway bills by usage (~$0.000231/GB-min RAM, ~$0.000463/vCPU-min), so what
matters is *time spent with Chromium running*, not the container ceiling.

* Browser running with a tab open: ~1.1 GB → roughly **$0.35–0.45/day** if you
  browsed all day, plus a small CPU charge for page loads.
* Idle at 160 MB (engine shut down): about **$0.05/day**.
* A realistic pattern — a couple of hours of actual browsing a day — lands
  around **$10–15/month**.

Tune the two shutdown timers if you care: shorter means cheaper, at the cost of
a ~1.2 s cold start on the next tab.

### 6. Sanity check after deploy

```bash
railway logs                       # expect: "engine: Chromium available"
curl https://YOUR-APP.up.railway.app/healthz
```

Then open the URL, log in, and load any site — it should render live in
Chromium. If the memory limit is too low, the toolbar shows a chip and the
**⋯ → Switch engine** menu explains the detected limit rather than failing
silently.

---

## Configuration

Everything is env vars, so the same image runs anywhere.

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | *generated* | **Set this.** Password for the panel. If unset, a random one is generated and printed in the logs, and all sessions die on restart. |
| `SESSION_SECRET` | derived from password | Signing key for session cookies. Set it to change the password without logging everyone out. |
| `SESSION_TTL_HOURS` | `168` | Login lifetime (7 days). |
| `DB_PATH` | `./data/browser.db` | SQLite file. Point it at a mounted volume to persist history/bookmarks/cookies. |
| `PORT` | `8080` | Injected by Render/Railway. |
| `MAX_INFLIGHT_PER_SESSION` | `12` | Concurrent upstream requests; protects the free tier from a heavy page. |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Per-request upstream timeout. |
| `MAX_BODY_BYTES` | `10485760` | Largest rewritten body / proxied upload (10 MB). |
| `ALLOW_PRIVATE_HOSTS` | `0` | **Leave off.** Enables the SSRF guard; off means `169.254.169.254`, `127.0.0.1` and the private network are unreachable through the panel. |
| `BLOCKED_HOSTS` | – | Comma-separated hosts to refuse (e.g. your own admin host). |
| `CSP_FRAME_ANCESTORS` | `'self'` | Widen to `*` if the *panel itself* is embedded in another site's iframe. |
| `APP_ENGINE` | `chromium` | `chromium` = proxy + live browser, `proxy` = never launch Chromium. |
| `CHROMIUM_ENABLED` | `1` | Master switch for the Chromium engine. |
| `CHROMIUM_ARGS` | – | Extra flags appended to Chromium's command line. |
| `CHROMIUM_MIN_MEMORY_MB` | `1800` | Refuse to launch below this container limit. |
| `MAX_BROWSER_TABS` | `3` | Live tabs (each ~80–150 MB). |
| `TAB_SLEEP_MS` | `900000` | Suspend an off-screen tab after this long. |
| `BROWSER_IDLE_SHUTDOWN_MS` | `600000` | Stop Chromium after this long with no tabs, freeing ~900 MB. |
| `BROWSER_JPEG_QUALITY` | `62` | Stream quality (bandwidth vs clarity). |
| `BROWSER_WIDTH` / `BROWSER_HEIGHT` | `1280` / `800` | Virtual screen size. |
| `BROWSER_HEAP_MB` | `512` | JS heap cap per renderer. |
| `BROWSER_NAV_TIMEOUT_MS` | `45000` | Per-navigation timeout. |
| `SEARCH_URL` | DuckDuckGo HTML | Search prefix used when the address bar gets a non-URL. |
| `LOG_LEVEL` | `info` | `error`\|`warn`\|`info`\|`debug`. |

### Keeping state across deploys (optional)

Free instances have no persistent disk, so history/bookmarks/cookies reset on redeploy —
the session itself still works, because the login cookie is stateless.

* **Railway:** *New* → *Volume*, mount at `/data`, set `DB_PATH=/data/browser.db`.
* **Render:** requires a paid instance type; add a disk mounted at `/data` and set the same var.

Without a volume the app detects the unwritable path and quietly runs in-memory
(visible under *About* in the sidebar).

---

## What's in the panel

* **Tabs** (Ctrl+T / Ctrl+W / Ctrl+1…9), back/forward, reload, home.
* **Find in page** (Ctrl+F) — highlights and steps through matches inside the
  proxied frame, across the sandbox boundary.
* **Zoom** (Ctrl +/-/0) — Chromium zooms the page itself (`setPageScaleFactor`);
  the proxy engine uses CSS zoom with a transform fallback. Persists per browser.
* **Mobile viewport** (⋯ menu) — emulate a 390×844 phone with a mobile UA and
  touch, so sites serve their real mobile layout.
* **Downloads** — files Chromium downloads land in the panel as a link, so you
  can pull them off the server.
* **Address bar** with live suggestions from your bookmarks, top sites and history, plus
  search fallback when what you typed isn't a URL.
* **History / Bookmarks / Top sites** stored server-side in SQLite, so they follow you
  between devices and survive a logout.
* **Cookie jar** — per-user, server-side, so sites keep you logged in. There's a
  *Forget all cookies* button; nothing is stored in the panel's own browser storage.
* **View upstream source** — see the unmodified HTML the server received. This is the first
  thing to check when a page looks wrong.
* **About** pane — platform, memory, persistence state, and the exact limits in force.
* **Security:** password gate with an HMAC-signed HttpOnly cookie, constant-time password
  comparison, login rate limiting (8 attempts / 15 min / IP), SSRF guard on every hop, and a
  capability-signed proxy where the signature covers the target URL (a leaked asset URL can't
  be edited to fetch something else).

---

## How the webview actually works

1. **Navigate.** The panel asks `POST /api/navigate`. The server normalises the input
   (`example.com` → `https://example.com/`, free text → search), resolves DNS and rejects
   private/loopback targets, then returns a **signed path**:
   `/p/<sid>.<sig>/page/<base64 target>`.
2. **Fetch.** The server requests the page with a desktop User-Agent, a manual redirect loop
   (so `Location` headers can be rewritten), and the stored cookie jar. `Set-Cookie` goes into
   SQLite; `X-Frame-Options`, `Content-Security-Policy` and friends are stripped, because those
   headers exist to stop *other sites* framing the page and would blank our iframe.
3. **Rewrite.** Cheerio walks the markup: `<a>`/`<form>`/`<iframe>` become `page` URLs,
   `<img>`/`<script>`/`<link>`/`<source srcset>` become `asset` URLs, `style` attributes,
   `<style>` blocks and proxied `.css` files get `url(...)` and `@import` rewritten,
   `<meta refresh>` gets fixed, `<base href>` is folded in and removed. Absolute-URL-hardcoding
   JS is left alone — see limitations.
4. **Render.** The rewritten HTML goes into a sandboxed iframe
   (`allow-scripts`, **no** `allow-same-origin`). Your browser renders it at full fidelity and
   the frame can't reach back into the panel document.
5. **Bootstrap.** Because the frame is a sandboxed opaque origin, three things would normally
   break. An injected script fixes each one:
   * `fetch`/`XHR` — rewritten to go through `/dyn`, so SPA API calls work;
   * `document.cookie` — backed by the server cookie jar, writes go back through the proxy;
   * `localStorage`/`sessionStorage` — these *throw* in an opaque origin, so they're shimmed.
   It also reports URL/title changes, `window.open`, and errors up to the panel.

Without Chromium there's no JS-driven layout engine, no service workers, and no canvas/WebGL
offscreen rendering — but for the vast majority of the web, the real page renders correctly in
your browser with the server doing ~50 MB of work instead of ~500 MB.

---

## The Chromium engine

Chromium is the **primary engine**: new tabs open in it by default. An injected
page-side helper plus the CDP session give you a genuinely normal browsing
experience rather than a remote-control toy.

**What works, verified end to end against live sites:**

| Capability | How | Verified |
|---|---|---|
| Live view | CDP `Page.startScreencast` → JPEG frames → canvas | ~30 fps while the page changes, 1 frame when idle |
| Click / double-click / right-click | pointer events → `Input.dispatchMouseEvent` | ✅ focused an input and fired a button's JS handler |
| Typing, shortcuts, Enter/Tab/arrows | key events → `Input.dispatchKeyEvent` | ✅ typed into Wikipedia's search and submitted it |
| Scrolling | wheel events (+ touch drag → wheel) | ✅ `scrollY` tracked exactly |
| Tabs | one Chromium page per panel tab | ✅ switching re-points the stream |
| Cookies / logins | one persistent context, saved to SQLite | survives redeploys with a volume |
| Downloads | `Page.downloadWillBegin` → `/download/:id` | 20 most recent kept for 24 h |
| Find in page | injected script, 500-match cap | ✅ 137 matches on a Wikipedia article |
| Zoom | `Emulation.setPageScaleFactor` | ✅ |
| Mobile viewport | `setDeviceMetricsOverride` + mobile UA + touch | ✅ Wikipedia served its *mobile* skin |
| Desktop viewport | screen size override | ✅ 1280×800 layout |

**How input travels.** Your clicks carry the coordinate you actually clicked
relative to the image, normalised to 0..1 on the client. The server multiplies
by the emulated viewport size and dispatches real CDP input at that point. That
indirection is why the panel can letterbox, fit or scale the canvas freely and
still click in exactly the right place.

**Frames are dropped, not queued.** Each frame is ACKed (`Page.screencastFrameAck`)
and if the socket has more than ~1.5 MB backed up the next frame is skipped. A
slow phone connection degrades to fewer frames per second instead of drifting
further and further behind the browser.

### The proxy engine, and why it still ships

Chromium costs ~1 GB. The proxy engine costs ~150 MB and renders using *your*
browser through a sandboxed iframe. It's not a legacy leftover: it's what makes
the panel usable when you're on a smaller instance, it's instant (no stream
latency), and for text-heavy sites it's arguably nicer — real text selection,
crisp at any zoom, works offline from the server's point of view.

Use the **◉ button** in the toolbar, or **⋯ → Switch engine**, to move a tab
between engines. The status bar shows which one the active tab is using.

## Phone & touch support

The panel is built mobile-first from the top down, so the whole thing is usable on a phone with
no app, no native shell, and no separate layout to maintain.

* **Drawer sidebar.** Below 900 px the sidebar stops being a column and becomes a slide-over
  drawer with a scrim; it closes itself when you pick a history/bookmark entry, and it can't be
  tab-focused while off-screen.
* **Condensed chrome.** Below 620 px the wordmark, engine chip and status bar drop out and the
  toolbar tightens. *Home*, *Bookmark*, *Reload*, *Toggle sidebar*, *Desktop viewport* and the
  source viewer all move into the **⋯** menu so nothing becomes unreachable; below 380 px the
  reload button joins them.
* **Real viewport height.** The shell uses `100dvh` with a `100vh` fallback, and re-measures on
  `visualViewport` resize, so the collapsing mobile address bar and the on-screen keyboard don't
  clip the UI.
* **Safe areas.** `viewport-fit=cover` plus `env(safe-area-inset-*)` padding keeps the toolbar out
  from under the notch and the bottom sheet above the home indicator.
* **Touch, not hover.** Delete buttons and tab close buttons are hover-gated on desktop but always
  visible under `@media (hover: none)`; targets are ≥ 40 px on coarse pointers; tap highlight and
  double-tap zoom are suppressed on controls.
* **No iOS focus zoom.** Every input is 16 px on small screens, which is the threshold below which
  Safari zooms the viewport when a field is focused.
* **Desktop viewport mode.** Sites that are unusable at 360 px (old dashboards, wide data tables)
  can be laid out at 1280 px and scaled to fit the screen — tap **▭** in the toolbar or use the
  ⋯ menu. It's a client-side transform only: nothing changes server-side, and the page still
  renders in your browser. Your choice persists in `localStorage`.
* **Menus and modals adapt.** The ⋯ menu becomes a bottom sheet on phones and the source viewer
  goes full-bleed.

Worth knowing: touch gestures inside the **webview** belong to the remote page, so panel gestures
(pull-to-refresh, edge-swipe-to-open-the-drawer) are deliberately absent — use the toolbar and the
drawer button. Keyboard shortcuts (Ctrl+T etc.) are desktop conveniences; every one of them has a
menu or button equivalent for touch.

---

## Known limitations (please read)

These are inherent to "no Chromium + datacenter IP", not bugs to fix later:

* **Datacenter IP blocking still applies.** Chromium fixes *rendering* and *compatibility*,
  not geography. Google, YouTube, Cloudflare bot walls and banking sites see a Railway IP and
  will CAPTCHA or block you, exactly as any other server would. (They render perfectly — you
  just get served the challenge.) Put a residential proxy in front if this matters.
* **Streaming costs bandwidth.** A busy page at ~30 fps and quality 62 is roughly 1–3 MB/s.
  Not a problem on wifi; noticeable on mobile data. Drop `BROWSER_JPEG_QUALITY` or raise the
  socket backlog threshold to trade smoothness for data.
* **Video playback won't feel right.** Frames are JPEG at up to 30 fps; audio is muted
  (`--mute-audio`) because it can't be streamed through this path at all.
* **Aggressive SPAs may break.** Apps that hardcode absolute API URLs, use module workers,
  service workers, `import()` with literal URLs, or require `document.cookie` before first paint
  can misbehave. The bootstrap covers the common cases; it can't cover all of them.
* **CSP-protected sites are only partially helped.** We strip upstream CSP in the iframe, but a
  page that enforces its own restrictions in JS still wins.
* **No plugin/media playback guarantees.** Video needs a direct media URL; DRM never works.
* **Downloads** arrive as proxied URLs (`allow-downloads` is set on the sandbox), so very large
  files pass through the instance — mind `MAX_BODY_BYTES` and the platform's bandwidth.

---

## Local development

```bash
npm install
cp .env.example .env      # set APP_PASSWORD
APP_PASSWORD=dev DB_PATH=./data/browser.db npm start
# → http://localhost:8080
```

For the Chromium engine locally, install the browser once (it's not bundled
with `playwright-core`):

```bash
npx playwright-core install --with-deps chromium   # needs sudo for the deps
npm start
```

Without it the panel still runs — every tab just uses the proxy engine.

`npm run dev` uses `node --watch` for restarts. There are no native modules to build — SQLite
is `sql.js` (WASM) — so installs are fast and cold starts are short.

### API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health check (public, used by both platforms). |
| `POST` | `/login`, `/logout` | Session. |
| `POST` | `/api/navigate` | Normalise + validate + sign a target → ready-to-load path. |
| `POST` | `/api/mint` | Sign an arbitrary target for a new tab/download. |
| `GET` | `/api/history`, `/api/bookmarks`, `/api/frequent`, `/api/cookies`, `/api/suggest`, `/api/source`, `/api/info` | Panel data. |
| `*` | `/p/<capability>/<kind>/<target>` | The proxy itself. `kind` ∈ `page`, `asset`, `dyn`, `cookie`. |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Proxied link expired" | The capability no longer verifies — usually the password (and therefore the derived signing key) changed. Set `SESSION_SECRET` explicitly to keep links stable across password changes. |
| Everything 302s to `/login` | Cookie not being stored. Over https the cookie is `SameSite=None; Secure`; make sure TLS terminates with `X-Forwarded-Proto: https` (both platforms do this for you). |
| Page loads but assets are missing | Open **View upstream source** and check whether the HTML hardcodes absolute URLs in JS. Also check the logs for `private_ip` or `dns_failure` lines. |
| Infinite/blank loading | Likely a heavy SPA exceeding `MAX_INFLIGHT_PER_SESSION`; raise it, or check the logs for `429`. |
| Logs say "generated a one-time password" | `APP_PASSWORD` isn't set. Set it, or copy the password from the logs (sessions reset on restart). |
| History/cookies empty after a redeploy | No volume mounted. On Railway: Settings → Volumes → mount at `/data`. |
| "This container is limited to N MB…" | Below `CHROMIUM_MIN_MEMORY_MB`. Raise memory in Settings → Resources, or set `APP_ENGINE=proxy` for proxy-only. |
| First tab takes ~2 s to appear | Chromium cold start. Keep `BROWSER_IDLE_SHUTDOWN_MS=0` to leave it warm (costs memory while idle). |
| Live view is choppy | Bandwidth or CPU. Lower `BROWSER_JPEG_QUALITY`, drop `BROWSER_WIDTH/HEIGHT`, or check the fps in the status bar. |
| Screen frozen but tabs work | The screencast stalled; switching tabs restarts it. Check `railway logs` for a renderer crash. |
| Tabs get suspended | `MAX_BROWSER_TABS` (3) evicts the least recently used tab and the panel tells you which. |
| Downloads disappear | Only the 20 most recent are kept, and `/tmp` is cleared on redeploy. |

---

## Project layout

```
browser-panel/
├── Dockerfile              # one image, both platforms, no build step
├── render.yaml             # Render Blueprint
├── railway.json            # Railway config
├── server.js               # wiring: middleware order, health, shutdown
├── src/
│   ├── config.js           # env → typed config, header policy
│   ├── db.js               # sql.js (WASM SQLite) with debounced atomic writes
│   ├── store.js            # history / bookmarks / cookie-jar data access
│   ├── log.js              # leveled logger with secret redaction
│   ├── chromium/
│   │   ├── browser.js      # launch/lifecycle, memory guard, storage persistence
│   │   ├── session.js      # per-tab page, screencast, input, downloads, tabs
│   │   └── ws.js           # /ws/viewer socket: frames out, input in
│   ├── proxy/
│   │   ├── index.js        # /p/* router, inflight limits, error pages
│   │   ├── upstream.js     # manual-redirect fetch, cookie jar injection
│   │   ├── rewrite.js      # HTML + CSS URL rewriting
│   │   ├── sign.js         # capability signing, double-proxy unwrapping
│   │   ├── bootstrap.js    # builds the injected boot script
│   │   └── registry.js     # sid → user, last document base (orphan recovery)
│   └── web/
│       ├── auth.js         # password gate, sessions, rate limiting
│       ├── api.js          # panel API
│       └── suggest.js      # omnibox ranking
└── public/
    ├── index.html          # panel chrome
    ├── panel.css, panel.js # UI
    ├── login.html
    └── static/bootstrap.js # in-iframe shims (fetch/XHR/cookie/storage)
```
