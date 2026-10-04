#!/usr/bin/env bash
# Bring up the whole browser-fetch stack: bridge + a dedicated Firefox window
# with the extension loaded. Idempotent: skips whatever is already running.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH="${BROWSER_FETCH_BRIDGE:-http://127.0.0.1:8798}/health"
PROFILE="${BROWSER_FETCH_PROFILE:-$HOME/snap/firefox/common/browser-fetch-profile}"
FIREFOX="${FIREFOX_BIN:-$(command -v /snap/bin/firefox || command -v firefox)}"
LOGDIR="${XDG_STATE_HOME:-$HOME/.local/state}/browser-fetch"
mkdir -p "$LOGDIR" "$PROFILE"

health() { curl -fsS --max-time 2 "$HEALTH" 2>/dev/null; }
wait_for() { # wait_for <pattern> <seconds>
  for _ in $(seq "$2"); do health | grep -q "$1" && return 0; sleep 1; done; return 1
}

# 1. Bridge
if ! health >/dev/null; then
  echo "starting bridge (log: $LOGDIR/bridge.log)"
  nohup node "$ROOT/server/bridge.mjs" >"$LOGDIR/bridge.log" 2>&1 &
  wait_for extensionConnected 10 || { echo "bridge failed to start"; tail "$LOGDIR/bridge.log"; exit 1; }
fi

# 2. Firefox + extension
if health | grep -q '"extensionConnected":true'; then
  echo "stack already up"; exit 0
fi

# A shell outside the desktop session has no display vars; borrow the session's.
uid=$(id -u)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export DISPLAY="${DISPLAY:-:0}"
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/wayland-0" ]; then
  export WAYLAND_DISPLAY=wayland-0
fi

echo "launching Firefox with extension (log: $LOGDIR/firefox.log)"
cd "$ROOT"
nohup npx -y web-ext run --source-dir extension \
  --firefox="$FIREFOX" --firefox-profile="$PROFILE" --keep-profile-changes \
  --no-reload --arg=--new-instance --arg=-no-remote --start-url about:blank \
  >"$LOGDIR/firefox.log" 2>&1 &

if wait_for '"extensionConnected":true' 60; then
  echo "stack up: extension connected"
else
  echo "extension did not connect within 60s"; tail -20 "$LOGDIR/firefox.log"; exit 1
fi
