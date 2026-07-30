#!/usr/bin/env bash
# Refuse to start a second Eldrun dev session.
#
# Two concurrent instances corrupt the shared workspace state under
# ~/.local/share/eldrun. Worse, a second `tauri dev` whose vite loses the race
# for port 1420 logs the bind failure and carries on anyway, pointing its window
# at the *first* session's dev server — so the new window renders that session's
# stale, half-hot-reloaded module graph and looks like an old build. That is not
# obvious from the window, only from the log, which is why this is mechanical
# rather than a rule someone has to remember.
#
# Invoked from two places, so every documented launch path is covered:
#   - start-eldrun-tauri-hotreload.sh (the desktop entry)
#   - the `pretauri:dev` npm hook, which catches a bare `npm run tauri:dev`
# Running twice in one launch is harmless: nothing has started yet either time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_PORT=1420

bail() {
  printf 'REFUSING TO START: %s\n' "$1" >&2
  printf '  %s\n' "$2" >&2
  notify-send -u critical -a Eldrun 'Eldrun is already running' "$1" 2>/dev/null || true
  exit 1
}

app_pids="$(pgrep -f "^$ROOT/target/debug/eldrun" || true)"
dev_pids="$(pgrep -f "$ROOT/node_modules/.bin/tauri" || true)"

if [ -n "$app_pids" ] || [ -n "$dev_pids" ]; then
  bail "an Eldrun dev session is already up (app=${app_pids:-none} dev=${dev_pids:-none})." \
       "Use that window, or stop it: pkill -f '$ROOT/node_modules/.bin/tauri'; pkill -f '$ROOT/target/debug/eldrun'"
fi

# No dev session of ours, but the port is taken: an orphaned vite whose
# supervisor died. Starting now would silently attach to it.
if (exec 3<>"/dev/tcp/127.0.0.1/$DEV_PORT") 2>/dev/null; then
  exec 3>&-
  bail "port $DEV_PORT is held by an orphaned dev server (no Eldrun process owns it)." \
       "Clear it first: fuser -k $DEV_PORT/tcp"
fi
