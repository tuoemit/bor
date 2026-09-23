#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export SCREEN_WIDTH="${SCREEN_WIDTH:-390}"
export SCREEN_HEIGHT="${SCREEN_HEIGHT:-844}"
export SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
export HOME="${HOME:-/home/browser}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/home/browser/chrome-profile}"
export PORT="${PORT:-10000}"

mkdir -p "$CHROME_USER_DATA_DIR"

cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Virtual phone-sized X display.
Xvfb "$DISPLAY" \
  -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" \
  -dpi 96 \
  -ac \
  +extension RANDR \
  +extension MIT-SHM \
  >/tmp/xvfb.log 2>&1 &

# Tiny window manager so Chromium can manage its window normally.
openbox >/tmp/openbox.log 2>&1 &

# Give X a moment to initialize.
sleep 1

# VNC password is optional. When set, x11vnc uses it for the VNC connection.
VNC_ARGS=(
  -display "$DISPLAY"
  -rfbport 5900
  -forever
  -shared
  -repeat
  -noxrecord
  -noxfixes
  -noxdamage
  -ncache 0
  -wait 5
  -defer 5
  -localhost
)

if [[ -n "${VNC_PASSWORD:-}" ]]; then
  PASSFILE=/tmp/x11vnc.pass
  x11vnc -storepasswd "$VNC_PASSWORD" "$PASSFILE" >/dev/null
  chmod 600 "$PASSFILE"
  VNC_ARGS+=( -rfbauth "$PASSFILE" )
else
  VNC_ARGS+=( -nopw )
fi

x11vnc "${VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &

# Start Chromium as the actual browser the user controls through VNC.
# --no-first-run and --disable-dev-shm-usage are useful in small containers.
# --window-size keeps the desktop close to a phone-sized canvas.
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,MediaRouter \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --disable-extensions \
  --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
  --window-position=0,0 \
  --user-data-dir="$CHROME_USER_DATA_DIR" \
  "${START_URL:-https://www.google.com}" \
  >/tmp/chromium.log 2>&1 &

# Render exposes exactly one public HTTP port. websockify serves noVNC and
# bridges its WebSocket traffic to the local VNC server on port 5900.
exec websockify \
  --web /usr/share/novnc \
  --heartbeat 30 \
  --idle-timeout 0 \
  --verbose \
  "0.0.0.0:${PORT}" \
  127.0.0.1:5900
