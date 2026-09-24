# Cloud Browser — a password-protected remote browser for Render & Railway

A **headless Firefox (Gecko)** browser that runs on your server, streamed to a
password-protected web panel. Open any address, click, type, scroll, run
automation scripts, and keep isolated login profiles — all from a single
deployable service.

> **No Chromium anywhere.** The engine is Firefox (`firefox.launch()`), the
> Docker base image is the official Playwright *Firefox* image, and the install
> step downloads only the Firefox build.

```
+-----------------+   HTTPS + WebSocket    +-----------------------+
|  Panel (browser)| <--------------------> |  Express + WS server  |
|  (vanilla JS)   |  frames / input        |  (auth, REST API)     |
+-----------------+                        +----------+------------+
                                                      | Playwright
                                                      v
                                           +-----------------------+
                                           |  Headless Firefox     |
                                           |  (Gecko, per-session  |
                                           |   isolated contexts)  |
                                           +-----------------------+
```

## How it works

- **Screencast**: the server screenshots the live viewport ~5×/s, sends only
  changed frames over a WebSocket, and the panel paints them. Clicks/keys/wheel
  from the panel are converted to CSS-pixel coordinates and injected into the
  page via Playwright. The result behaves like a real browser.
- **Profiles (sessions)**: each named profile is an isolated Firefox context.
  Cookies + localStorage can be saved to disk and reloaded, so a login survives
  a restart (if a volume is mounted).
- **Automation**: every UI action is also a REST endpoint, and `POST /api/script`
  runs a JSON list of steps (goto/click/fill/extract/screenshot/…) — drive it
  from cron or another service.
- **Password gate**: the panel is behind a password (`PANEL_PASSWORD`), with
  constant-time comparison, rate-limited logins, signed session cookies and CSRF
  protection. The REST API additionally accepts `Authorization: Bearer <API_TOKEN>`.

## Features

- Real Firefox rendering — any site, any address (no iframe/X-Frame-Options limits).
- Tabs, back/forward/reload, live URL bar, per-tab console/events.
- Click, type, keyboard shortcuts, scroll — injected into the real page.
- Page extraction: text, links, meta, forms, inputs. Run arbitrary JS on the page.
- Screenshots (viewport + full page) saved and downloadable.
- Downloads from pages are captured to server disk and listable.
- Isolated profiles with persisted cookies/localStorage.
- JSON automation scripts + a full REST API.
- Graceful shutdown that saves profiles on SIGTERM (both platforms send it).

## Local quickstart

```bash
npm ci                       # also downloads Firefox (postinstall)
export PANEL_PASSWORD=secret
export SESSION_SECRET=$(openssl rand -hex 32)
npm start                    # http://localhost:3000
```

Run the test suites (against a running server):

```bash
node scripts/smoke-test.js http://127.0.0.1:3000   # 39 API/WebSocket checks
node scripts/ui-test.js    http://127.0.0.1:3000   # 28 real-browser UI checks
```

---

## Deploy on Render

1. Push this folder to a Git repo (GitHub/GitLab).
2. In Render: **New + → Blueprint**, choose the repo. Render reads `render.yaml`
   and creates a free Web Service that builds the `Dockerfile`.
   *(Or: **New + → Web Service** → runtime "Docker", health check `/healthz`.)*
3. In the service's **Environment** tab set:
   - `PANEL_PASSWORD` = your password (required)
   - `SESSION_SECRET` = long random string (or let Render generate it)
   - `API_TOKEN` = optional, for curl/cron
4. Deploy. Open `https://<service>.onrender.com` → log in.

Notes:
- Render free instances **sleep after ~15 min idle**; a request or an external
  pinger hitting `/healthz` wakes them (Firefox relaunches in ~10–15 s).
- Add a **Disk** mounted at `/app/data` if you want profiles/downloads to
  survive restarts. Without it the app still works, profiles reset per boot.
- Free tier = 512 MB RAM. Firefox + Node sits around 250–400 MB; keep
  `MAX_TABS` modest (2–3) to stay comfortable.

## Deploy on Railway

1. Push this folder to a Git repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway detects the `Dockerfile` (per `railway.toml`) and builds it.
3. In **Variables** add:
   - `PANEL_PASSWORD` (required), `SESSION_SECRET`, optional `API_TOKEN`.
   Railway injects `$PORT` automatically; the app binds `0.0.0.0:$PORT`.
4. The `railway.toml` already sets the health check (`/healthz`) and restart
   policy. Deploy and open the generated public domain.

Notes:
- Railway free plan is also 512 MB; same guidance as Render.
- If you'd rather not use Docker, Railway's **Nixpacks** builder can work, but
  you must add the Firefox system libraries (GTK/NSS/etc.) and run
  `npx playwright install firefox` in a build step. The Docker path above is the
  reliable, supported route.

---

## Environment variables (summary)

| Var | Default | Purpose |
|-----|---------|---------|
| `PANEL_PASSWORD` | *(required)* | Unlocks the panel |
| `API_TOKEN` | *(off)* | Bearer token for REST automation |
| `SESSION_SECRET` | random | Signs the session cookie |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Bind address (platforms set PORT) |
| `MAX_TABS` | `4` | Tabs per profile |
| `MAX_SESSIONS` | `3` | Loaded profiles at once |
| `VIEWPORT_WIDTH/HEIGHT` | `1280/800` | Viewport size |
| `FRAME_QUALITY` | `62` | JPEG quality (bandwidth vs clarity) |
| `FRAME_INTERVAL_MS` | `180` | Screenshot cadence |
| `DATA_DIR` | `./data` | Profiles + downloads (mount a volume to persist) |
| `LAZY_BROWSER` | `0` | `1` to defer Firefox launch to first use |
| `SCRIPT_MAX_STEPS` / `SCRIPT_TIMEOUT_MS` | `60` / `120000` | Automation limits |

See `.env.example` for the full list.

---

## Using the automation API

Authenticate with `Authorization: Bearer $API_TOKEN` (or the cookie).

```bash
# Health / engine info (public)
curl -s $BASE/healthz

# Run a multi-step script
curl -s -X POST $BASE/api/script \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "steps": [
      { "do": "goto",  "url": "https://news.ycombinator.com" },
      { "do": "waitForLoad" },
      { "do": "eval",  "expression": "Array.from(document.querySelectorAll(\".titleline > a\")).slice(0,5).map(a=>a.textContent)" },
      { "do": "screenshot", "fullPage": true, "name": "hn" }
    ]
  }'
```

Available steps: `goto reload back forward wait waitForLoad waitForSelector
click dblclick hover focus fill type press select check uncheck scroll scrollBy
screenshot extract eval newTab closeTab switchTab upload saveSession log`.

List them: `GET /api/actions`.

Other useful endpoints: `GET /api/screenshot`, `GET /api/content` (text/links),
`POST /api/click|/api/type|/api/press|/api/scroll|/api/eval`, `GET|POST /api/tabs`,
`GET /api/sessions`, `POST /api/sessions/:id/save`, `GET /api/downloads`.

## Security notes

- The panel sets `X-Frame-Options: DENY` + CSP, so the panel itself can't be
  iframed (login-clickjacking resistant).
- Logins are rate-limited (10 fails / 15 min window, exponential lockout).
- Session cookies are `HttpOnly`, `SameSite=Strict`, signed HMAC, 12 h TTL.
- Keep `SESSION_SECRET` stable across deploys or everyone is logged out.

## Troubleshooting

- **Login shows "not_configured"** → `PANEL_PASSWORD` isn't set on the platform.
- **503 "engine unavailable"** → Firefox failed to launch; check logs. On free
  tiers this usually means out-of-memory: lower `MAX_TABS` / `VIEWPORT_*`.
- **Blank viewport on first open** → the free instance just woke; give it ~15 s.
- **Profiles lost after restart** → no volume mounted at `DATA_DIR`; expected on
  ephemeral filesystems. Add a disk to persist.

## Project layout

```
server/
  index.js            HTTP + WebSocket entrypoint
  lib/auth.js         password, signed cookies, rate limit, CSRF
  lib/browserManager.js  Firefox engine, profiles, tabs
  lib/screencast.js   frame streaming + input injection
  lib/scriptRunner.js automation step interpreter
  routes/api.js       REST API
public/               panel front-end (vanilla JS, no build step)
scripts/              postinstall + smoke/ui test suites
Dockerfile            Playwright-Firefox base image (Render + Railway)
render.yaml           Render blueprint
railway.toml          Railway build/deploy config
```
