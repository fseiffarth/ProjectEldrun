#!/usr/bin/env bash
# Launcher for the hot-reload Tauri dev server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.local/share/eldrun"
LOG_FILE="$LOG_DIR/hotreload.log"
LOG_MAX_BYTES=$((64 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# `tauri dev` streams every cargo build bar and vite HMR line in here, so the
# log grows without bound (it reached 2 GB once). Keep one generation.
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

exec >>"$LOG_FILE" 2>&1

# The rotation above only runs at launch, which caps the log across sessions and
# not within one -- and a hot-reload session is measured in days. A single run
# had put 255 MB into the live file and 613 MB into the generation before it
# (2026-09-01), i.e. four times the cap in the one file the cap is about.
#
# So keep a watchdog on it. It TRUNCATES IN PLACE (tail into a temp, copy back
# over the same inode) rather than rotating: every writer above holds this file
# open in append mode, and a `mv` would leave `tauri dev`, vite and cargo all
# writing to an unlinked inode for the rest of the session -- a log that looks
# rotated and then never grows again. `O_APPEND` writers resume at the new end
# of a shortened file, so shortening it under them is safe.
#
# The watchdog dies with the launcher: `$$` is checked each pass so an orphan
# left by a `kill -9` stops on its own, and the EXIT trap kills it outright.
LOG_KEEP_BYTES=$((16 * 1024 * 1024))
(
  while sleep 300; do
    kill -0 "$$" 2>/dev/null || exit 0
    size="$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)"
    [ "$size" -gt "$LOG_MAX_BYTES" ] || continue
    tmp="$LOG_FILE.trim.$$"
    if tail -c "$LOG_KEEP_BYTES" "$LOG_FILE" >"$tmp" 2>/dev/null; then
      cat "$tmp" >"$LOG_FILE" 2>/dev/null || true
    fi
    rm -f "$tmp"
  done
) &
LOG_TRIMMER=$!

printf '\n=== HOTRELOAD START %s ===\n' "$(date -Is)"
trap 'status=$?; kill "$LOG_TRIMMER" 2>/dev/null || true; printf "=== HOTRELOAD EXIT %s status=%s ===\n" "$(date -Is)" "$status"' EXIT

cd "$ROOT"

# Refuse to become a second instance. Also runs again via the `pretauri:dev`
# npm hook below, which is what covers a bare `npm run tauri:dev`.
"$ROOT/scripts/guard-single-instance.sh"

# Desktop entries don't source ~/.bashrc, so Rust tools may not be in PATH.
export PATH="$HOME/.cargo/bin:$PATH"

# With GTK overlay scrolling on (the default on Cinnamon/GNOME), WebKitGTK draws
# a native GTK overlay scrollbar and ignores the app's CSS `scrollbar-color`, so
# the themed (blue) scrollbars fall back to the system GTK theme (white/grey in
# Adwaita light). Disabling it forces the legacy scrollbar, which WebKitGTK
# renders itself and themes from our CSS. Harmless where it's already off.
export GTK_OVERLAY_SCROLLING=0

printf 'root=%s\n' "$ROOT"
printf 'PATH=%s\n' "$PATH"
command -v node
node --version
command -v npm
npm --version
command -v cargo
cargo --version
command -v rustc
rustc --version

exec npm run tauri:dev
