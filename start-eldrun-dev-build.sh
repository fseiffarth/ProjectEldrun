#!/usr/bin/env bash
# Launcher for the FROZEN build behind the "Eldrun (dev)" desktop entry.
#
# Runs the release binary that scripts/package-dev.sh installed, on the REAL
# state (~/.local/share/eldrun, ~/eldrun): this is the window real work happens
# in while the hot-reload window is being edited. Nothing here watches the
# checkout, so edits never reach this window — re-run `npm run package:dev`
# and relaunch to move it to a newer snapshot.
#
# One Eldrun at a time (user, 2026-09-02): either this window or the
# hot-reload one, never both — they share the real state, and two instances on
# it corrupt it. So this refuses (with a desktop notification) while any
# hot-reload session is up, sandboxed or not, and the hot-reload launcher
# refuses while this one is up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$HOME/.local/share/eldrun/eldrun-dev"
LOG_DIR="$HOME/.local/share/eldrun"
LOG_FILE="$LOG_DIR/eldrun-dev.log"
LOG_MAX_BYTES=$((16 * 1024 * 1024))

mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi
exec >>"$LOG_FILE" 2>&1
printf '\n=== ELDRUN (dev) START %s ===\n' "$(date -Is)"

bail() {
  printf 'REFUSING TO START: %s\n  %s\n' "$1" "$2" >&2
  notify-send -u critical -a Eldrun 'Eldrun (dev) not started' "$1" 2>/dev/null || true
  exit 1
}

if [ ! -x "$BINARY" ]; then
  bail "no frozen build installed at $BINARY." "Build one: cd $ROOT && npm run package:dev"
fi

if pgrep -f "^$BINARY" >/dev/null; then
  bail "Eldrun (dev) is already running." "Use that window."
fi

dev_pids="$(pgrep -f "^$ROOT/target/debug/eldrun" || true)"
tauri_pids="$(pgrep -f "$ROOT/node_modules/.bin/tauri" || true)"
if [ -n "$dev_pids" ] || [ -n "$tauri_pids" ]; then
  bail "a hot-reload Eldrun is running (app=${dev_pids:-none} dev=${tauri_pids:-none}); only one Eldrun runs at a time." \
       "Close that window first, then start Eldrun (dev)."
fi

# Same reason as start-eldrun-tauri-hotreload.sh: keep the CSS-themed scrollbar.
export GTK_OVERLAY_SCROLLING=0

cd "$HOME"
exec "$BINARY"
