#!/usr/bin/env bash
# Is the RUNNING Eldrun older than the backend source on disk?
#
# `npm run tauri:dev` passes `--no-watch`, so a `src-tauri/` edit no longer
# rebuilds and relaunches the window out from under whoever is using it (open
# tabs, live terminals, and a frontend reloaded from whatever uncommitted WIP
# happens to be on disk — a surprise restart is indistinguishable from the app
# breaking). The cost of that is the opposite failure: a backend fix that is
# saved, compiles, and simply is not in the window, with nothing saying so.
#
# This is the thing that says so. It compares the running process's start time
# against the newest mtime under `src-tauri/`, and is deliberately a plain script
# rather than anything in-app — reporting "the backend is stale" from the backend
# would need the very rebuild it is reporting on.
#
# Exit 0 = the running app matches the source (or nothing is running).
# Exit 1 = a restart is needed to pick up backend changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

app_pid="$(pgrep -f "^$ROOT/target/debug/eldrun" | head -n 1 || true)"
if [ -z "$app_pid" ]; then
  echo "No Eldrun dev binary is running — nothing to be stale against."
  exit 0
fi

# The proc entry's mtime is the process start time (Linux). Preferred over
# parsing `ps -o lstart`, whose format follows the locale.
started="$(stat -c %Y "/proc/$app_pid" 2>/dev/null || echo 0)"
if [ "$started" = "0" ]; then
  echo "Could not read the start time of pid $app_pid; skipping the check." >&2
  exit 0
fi

# Newest source mtime. `-newermt` would need a formatted date; a max over
# `%T@` is simpler and needs no date arithmetic. Build outputs are excluded —
# `target/` is written BY the build, so including it would make every run look
# fresh immediately after a compile.
newest=0
newest_file=""
while IFS=' ' read -r ts path; do
  ts="${ts%.*}"
  if [ "$ts" -gt "$newest" ]; then
    newest="$ts"
    newest_file="$path"
  fi
done < <(
  find "$ROOT/src-tauri" \
    -path "$ROOT/src-tauri/target" -prune -o \
    -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' -o -name '*.conf.json' \) \
    -printf '%T@ %p\n'
)

stale=0
if [ "$newest" -gt "$started" ]; then
  stale=1
fi

# The phone's PWA is EMBEDDED INTO THE BINARY at compile time (src-tauri/
# build.rs bakes mobile-dist/ in), so the running sidecar serves the bundle as
# of its own build — and no src-tauri mtime says so. Two seams go stale
# independently: mobile-web sources newer than the built bundle (the bundle
# needs `npm run mobile:build`), and a built bundle newer than the running
# process (a restart re-embeds it). Both showed up as "the phone is missing a
# feature that is plainly in the code".
newest_ts() {
  find "$@" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 | cut -d. -f1
}
mobile_src="$(newest_ts "$ROOT/mobile-web/src" "$ROOT/vite.mobile.config.ts" "$ROOT/tsconfig.mobile.json")"
mobile_dist="$(newest_ts "$ROOT/mobile-dist")"
mobile_msg=""
if [ -n "$mobile_src" ] && [ -n "$mobile_dist" ] && [ "$mobile_src" -gt "$mobile_dist" ]; then
  stale=1
  mobile_msg="MOBILE BUNDLE IS STALE — mobile-web/ sources are newer than mobile-dist/.
  Run 'npm run mobile:build', then restart to re-embed it."
elif [ -n "$mobile_dist" ] && [ "$mobile_dist" -gt "$started" ]; then
  stale=1
  mobile_msg="EMBEDDED MOBILE PWA IS STALE — the running app was built before the current
  mobile-dist/ bundle ($(date -d "@$mobile_dist" '+%F %T')); the phone is being served the old one."
fi

if [ "$stale" = "0" ]; then
  echo "Backend is current: running pid $app_pid started after the newest src-tauri change,"
  echo "and its embedded mobile PWA matches mobile-dist/."
  exit 0
fi

if [ "$newest" -gt "$started" ]; then
  rel="${newest_file#"$ROOT"/}"
  echo "BACKEND IS STALE — the running window predates your backend changes."
  echo "  running pid : $app_pid (started $(date -d "@$started" '+%F %T'))"
  echo "  newest edit : $rel ($(date -d "@$newest" '+%F %T'))"
fi
if [ -n "$mobile_msg" ]; then
  echo "$mobile_msg"
fi
echo
echo "Frontend (src/) changes are already live via vite HMR; only src-tauri/ (and the embedded mobile bundle) need this."
echo "To pick them up, restart the dev session yourself when it suits you:"
echo "  pkill -f '$ROOT/node_modules/.bin/tauri'; pkill -f '$ROOT/target/debug/eldrun'"
echo "  ./start-eldrun-tauri-hotreload.sh"
exit 1
