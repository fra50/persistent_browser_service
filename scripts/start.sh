#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM=${DISPLAY_NUMBER:-99}
export DISPLAY=:${DISPLAY_NUM}
XVFB_W=${XVFB_WIDTH:-1366}
XVFB_H=${XVFB_HEIGHT:-768}
XVFB_D=${XVFB_DEPTH:-24}
VNC_PORT=${VNC_PORT:-5900}
NOVNC_PORT=${NOVNC_PORT:-7900}
NOVNC_WEB=${NOVNC_WEB:-/usr/share/novnc}
PROFILE_ROOT=${PROFILE_DIR:-/profiles/default}
PASS_FILE=/tmp/x11vnc.pass
API_KEY_VALUE=${API_KEY:-}

mkdir -p "$PROFILE_ROOT"

cleanup() {
  echo "[entrypoint] cleaning up..."
  [[ -n "${NOVNC_PID:-}" ]] && kill "$NOVNC_PID" >/dev/null 2>&1 || true
  [[ -n "${VNC_PID:-}" ]] && kill "$VNC_PID" >/dev/null 2>&1 || true
  [[ -n "${FLUX_PID:-}" ]] && kill "$FLUX_PID" >/dev/null 2>&1 || true
  [[ -n "${XVFB_PID:-}" ]] && kill "$XVFB_PID" >/dev/null 2>&1 || true
  [[ -f "$PASS_FILE" ]] && rm -f "$PASS_FILE"
}
trap cleanup EXIT

Xvfb "$DISPLAY" -screen 0 ${XVFB_W}x${XVFB_H}x${XVFB_D} -ac +extension RANDR +extension GLX >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

# wait for X socket to appear
for i in $(seq 1 50); do
  if [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
    break
  fi
  sleep 0.2
done

fluxbox >/tmp/fluxbox.log 2>&1 &
FLUX_PID=$!

if [ -n "$API_KEY_VALUE" ]; then
  x11vnc -storepasswd "$API_KEY_VALUE" "$PASS_FILE" >/tmp/x11vnc_pass.log 2>&1
  X11VNC_AUTH_OPTS="-rfbauth $PASS_FILE"
else
  echo "[entrypoint] WARNING: API_KEY not set; VNC will start without a password"
  X11VNC_AUTH_OPTS="-nopw"
fi

x11vnc -display "$DISPLAY" -rfbport $VNC_PORT -forever -shared -quiet $X11VNC_AUTH_OPTS >/tmp/x11vnc.log 2>&1 &
VNC_PID=$!

if [ -d "$NOVNC_WEB" ]; then
  /usr/bin/env bash /usr/share/novnc/utils/launch.sh --vnc localhost:$VNC_PORT --listen $NOVNC_PORT >/tmp/novnc.log 2>&1 &
  NOVNC_PID=$!
  echo "[entrypoint] noVNC available on port $NOVNC_PORT"
else
  echo "[entrypoint] WARNING: noVNC assets not found; skipping web client"
fi

sleep 1

node src/index.js
