#!/usr/bin/env bash
# Launcher for the FROZEN build behind the "Eldrun (dev)" desktop entry.
#
# Runs the release binary that scripts/package-dev.sh installed, on the REAL
# state (~/.local/share/eldrun, ~/eldrun): this is the window real work happens
# in while the hot-reload window is being edited. Nothing here watches the
# checkout, so edits never reach a window that is already open — but each
# launch adopts the newest snapshot the tree has been built into, so `npm run
# package:dev` (or any commit, via the post-commit hook) plus a relaunch moves
# it forward.
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

if pgrep -f "^$BINARY" >/dev/null; then
  bail "Eldrun (dev) is already running." "Use that window."
fi

dev_pids="$(pgrep -f "^$ROOT/target/debug/eldrun" || true)"
tauri_pids="$(pgrep -f "$ROOT/node_modules/.bin/tauri" || true)"
if [ -n "$dev_pids" ] || [ -n "$tauri_pids" ]; then
  bail "a hot-reload Eldrun is running (app=${dev_pids:-none} dev=${tauri_pids:-none}); only one Eldrun runs at a time." \
       "Close that window first, then start Eldrun (dev)."
fi

# Adopt the tree's newest snapshot, if there is one.
#
# `npm run package:dev` builds the binary and installs it here, and since
# 2026-09-03 the post-commit hook does that on every commit. But that hook
# almost always fires inside an agent tab, and `services::agent_fence` gives an
# agent a tmpfs $HOME with only the project (and two state paths) bound in: the
# BUILD is real -- target/ lives inside the bound project -- while the INSTALL
# writes 75 MB into a directory that dies with the tab, having printed
# "Installed frozen binary". That is how this launcher kept opening a two-day-old
# window through a dozen commits that each reported success (2026-09-04).
#
# So do the install here instead, where no fence can reach: this script runs
# from the desktop entry, in the user's own session. Launch is also the only
# safe moment for it -- a running instance holds the old inode until then, which
# is exactly why the checks above come first.
#
# Conservative by construction: the artifact must be newer than what is
# installed and must carry the frontend that is in dist/ right now (a half-built
# or dev-mode binary fails that and is left alone), and any failure keeps the
# installed binary. The window opens either way.
BUILT="$ROOT/target/release/eldrun"
if [ -f "$BUILT" ] && [ "$BUILT" -nt "$BINARY" ]; then
  printf 'newer snapshot in the tree: %s\n' "$BUILT"
  if "$ROOT/scripts/assert-embedded-frontend.sh" "$BUILT"; then
    if install -Dm755 "$BUILT" "$BINARY"; then
      printf 'adopted it as %s (%s @ %s)\n' "$BINARY" \
        "$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?')" \
        "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
    else
      printf 'could not install it; launching the binary that is already there\n'
    fi
  else
    printf 'not adopting it: it does not carry the current dist/ frontend\n'
  fi
fi

if [ ! -x "$BINARY" ]; then
  bail "no frozen build installed at $BINARY." "Build one: cd $ROOT && npm run package:dev"
fi

# Same reason as start-eldrun-tauri-hotreload.sh: keep the CSS-themed scrollbar.
export GTK_OVERLAY_SCROLLING=0

cd "$HOME"
exec "$BINARY"
