# browser-panel

A **password-protected browsing panel** that runs on **Render or Railway free tier** — the same
repo deploys to both, unmodified.

It is **not** a headless Chromium. There is no Puppeteer, no Playwright, no browser binary in the
image. Instead the server fetches the pages you ask for and rewrites them so every URL points back
through the proxy; the rendering happens in **your own browser**, inside a sandboxed `<iframe>` in
the panel. That is what makes a full browsing session fit in **512 MB / 0.1 CPU**, when a headless
Chrome alone would need ~500 MB and a build step that free tiers will time out on.

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

## Deploy in 3 minutes

### Render

**Option A — Blueprint (recommended).** Push this folder to a Git repo, then in Render:
*New +* → *Blueprint* → pick the repo. Render reads `render.yaml`, builds the `Dockerfile`,
asks you for `APP_PASSWORD`, and deploys.

**Option B — manual.** *New +* → *Web Service* → your repo →
Runtime **Docker** → Health check path `/healthz` → add env var `APP_PASSWORD`.

### Railway

**Option A — CLI.**

```bash
npm i -g @railway/cli
railway login
railway init              # create a project
railway variables --set APP_PASSWORD='your-password'
railway up                # builds the Dockerfile
railway domain            # generate a public URL
```

**Option B — dashboard.** *New Project* → *Deploy from GitHub repo*. Railway detects the
`Dockerfile` and `railway.json`; then add `APP_PASSWORD` under *Variables* and hit *Deploy*.
Railway injects `PORT` itself — the app honours it automatically.

### Docker locally

```bash
docker build -t browser-panel .
docker run -p 8080:8080 -e APP_PASSWORD=your-password browser-panel
# → http://localhost:8080
```

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

## Known limitations (please read)

These are inherent to "no Chromium + datacenter IP", not bugs to fix later:

* **Some sites will block you.** Google, YouTube, Cloudflare bot walls, banking and most
  anti-fraud systems identify a datacenter IP. You'll get a CAPTCHA or an error page. Search
  defaults to DuckDuckGo's HTML endpoint because it is the most tolerant of the big engines.
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
| History is empty after a redeploy | No volume. See *Keeping state across deploys*. |

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
