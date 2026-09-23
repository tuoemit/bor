import atexit
import os
import threading
import shutil
import time
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request, send_file
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

app = Flask(__name__)

PORT = int(os.environ.get("PORT", "10000"))
HOST = "0.0.0.0"
APP_PASSWORD = os.environ.get("APP_PASSWORD", "").strip()

_browser_lock = threading.RLock()
_pw = None
_browser = None
_context = None
_page = None


def _auth_ok():
    if not APP_PASSWORD:
        return True
    return request.headers.get("X-Panel-Password", "") == APP_PASSWORD


def _require_auth():
    if not _auth_ok():
        return jsonify({"ok": False, "error": "Authentication required"}), 401
    return None


def _safe_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return "https://example.com"
    if "://" not in url:
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only http:// and https:// URLs are allowed")
    return url


def _ensure_browser():
    global _pw, _browser, _context, _page
    with _browser_lock:
        if _page and not _page.is_closed():
            return _page

        if _pw is None:
            _pw = sync_playwright().start()

        if _browser is None or not _browser.is_connected():
            executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser") or "/usr/bin/chromium"
            _browser = _pw.chromium.launch(
                executable_path=executable,
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-software-rasterizer",
                    "--disable-background-timer-throttling",
                    "--disable-breakpad",
                    "--disable-component-update",
                    "--disable-default-apps",
                    "--disable-features=Translate,BackForwardCache",
                    "--disable-hang-monitor",
                    "--disable-prompt-on-repost",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--no-first-run",
                    "--no-zygote",
                    "--disable-ipc-flooding-protection",
                    "--window-size=390,844",
                ],
            )

        if _context is None:
            _context = _browser.new_context(
                viewport={"width": 390, "height": 844},
                screen={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
                device_scale_factor=1,
                locale="en-US",
                timezone_id="UTC",
                ignore_https_errors=True,
                user_agent=(
                    "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/140.0.0.0 Mobile Safari/537.36"
                ),
            )
            _page = _context.new_page()
            _page.set_default_timeout(7000)
            try:
                _page.goto("https://example.com", wait_until="commit", timeout=10000)
            except PlaywrightTimeoutError:
                pass
        return _page


def _screenshot_bytes():
    with _browser_lock:
        page = _ensure_browser()
        return page.screenshot(type="jpeg", quality=62, full_page=False, animations="disabled")


def _page_info():
    with _browser_lock:
        page = _ensure_browser()
        return {"url": page.url, "title": page.title()}


@app.get("/")
def index():
    return render_template("index.html", password_enabled=bool(APP_PASSWORD))


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/state")
def state():
    auth = _require_auth()
    if auth:
        return auth
    try:
        return jsonify({"ok": True, **_page_info()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/screen")
def screen():
    auth = _require_auth()
    if auth:
        return auth
    try:
        data = _screenshot_bytes()
        return app.response_class(data, mimetype="image/jpeg", headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        })
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/navigate")
def navigate():
    auth = _require_auth()
    if auth:
        return auth
    try:
        url = _safe_url(request.json.get("url", ""))
        with _browser_lock:
            page = _ensure_browser()
            try:
                page.goto(url, wait_until="commit", timeout=15000)
            except PlaywrightTimeoutError:
                # A slow site may still be loading. Keep the page and let the UI
                # screenshot it instead of treating the navigation as a failure.
                pass
            try:
                page.wait_for_load_state("domcontentloaded", timeout=5000)
            except PlaywrightTimeoutError:
                pass
        return jsonify({"ok": True, **_page_info()})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc), **_page_info()}), 400
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/action")
def action():
    auth = _require_auth()
    if auth:
        return auth
    body = request.json or {}
    name = body.get("name")
    try:
        with _browser_lock:
            page = _ensure_browser()
            if name == "back":
                page.go_back(wait_until="commit", timeout=10000)
            elif name == "forward":
                page.go_forward(wait_until="commit", timeout=10000)
            elif name == "reload":
                page.reload(wait_until="commit", timeout=15000)
            elif name == "home":
                page.goto("https://example.com", wait_until="commit", timeout=15000)
            elif name == "scroll_up":
                page.mouse.wheel(0, -560)
            elif name == "scroll_down":
                page.mouse.wheel(0, 560)
            else:
                return jsonify({"ok": False, "error": "Unknown action"}), 400
        return jsonify({"ok": True, **_page_info()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc), **_page_info()}), 500


@app.post("/api/tap")
def tap():
    auth = _require_auth()
    if auth:
        return auth
    body = request.json or {}
    try:
        x = float(body["x"])
        y = float(body["y"])
        with _browser_lock:
            page = _ensure_browser()
            page.mouse.click(x, y)
        return jsonify({"ok": True, **_page_info()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/type")
def type_text():
    auth = _require_auth()
    if auth:
        return auth
    body = request.json or {}
    text = str(body.get("text", ""))
    press_enter = bool(body.get("enter", False))
    if not text and not press_enter:
        return jsonify({"ok": True})
    if len(text) > 2000:
        return jsonify({"ok": False, "error": "Text is limited to 2000 characters per action"}), 400
    try:
        with _browser_lock:
            page = _ensure_browser()
            if text:
                page.keyboard.insert_text(text)
            if press_enter:
                page.keyboard.press("Enter")
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/reset")
def reset():
    auth = _require_auth()
    if auth:
        return auth
    global _context, _page
    try:
        with _browser_lock:
            if _context:
                _context.close()
            _context = None
            _page = None
            _ensure_browser()
        return jsonify({"ok": True, **_page_info()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@atexit.register
def _shutdown():
    global _context, _browser, _pw
    try:
        if _context:
            _context.close()
        if _browser:
            _browser.close()
        if _pw:
            _pw.stop()
    except Exception:
        pass


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, threaded=True)
