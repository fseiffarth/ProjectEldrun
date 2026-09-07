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
# This is the thing that says so. It is deliberately a plain script rather than
# anything in-app — reporting "the backend is stale" from the backend would
# need the very rebuild it is reporting on. It never starts or stops anything
# (AGENTS.md "Running"); it prints and exits.
#
# Exit 0 = the running app matches the source (or nothing is running).
# Exit 1 = a rebuild/restart is needed to pick up the changes.
set -euo pipefail

# --mobile-only reports just the embedded-PWA seam. Backend staleness is
# EXPECTED here — `--no-watch` exists precisely so src-tauri edits pile up
# until the user restarts deliberately (AGENTS.md "Running") — so anything
# that fires on its own must not shout about it, or it becomes noise and gets
# ignored. The embedded mobile bundle is the seam nothing else announces.
mobile_only=0
if [ "${1:-}" = "--mobile-only" ]; then
  mobile_only=1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${ELDRUN_APP_DIR:-$HOME/.local/share/eldrun}"
STATE_DIR="${ELDRUN_STATE_DIR:-$APP_DIR}"

# ---------------------------------------------------------------------------
# Which Eldrun is running?
#
# The hot-reload dev binary is only one of the shapes this takes: `npm run
# package:dev` freezes the tree at eldrun-dev and `npm run package` installs
# eldrun[.AppImage]. Matching only target/debug made this script print "nothing
# to be stale against" and exit 0 — a false all-clear — for precisely the
# builds whose backend cannot hot-reload at all, and whose embedded mobile PWA
# is therefore the most likely thing in the window to be months behind.
#
# Order matters: `^$APP_DIR/eldrun` prefix-matches the other two, so the
# specific paths are tried first.
# ---------------------------------------------------------------------------
app_pid=""
app_kind=""
while IFS='|' read -r path kind; do
  [ -n "$path" ] || continue
  pid="$(pgrep -f "^$path" | head -n 1 || true)"
  if [ -n "$pid" ]; then
    app_pid="$pid"
    app_kind="$kind"
    break
  fi
done <<EOF
$ROOT/target/debug/eldrun|hot-reload dev session
$ROOT/target/release/eldrun|release binary from the checkout
$APP_DIR/eldrun-dev|frozen "Eldrun (dev)" build
$APP_DIR/eldrun.AppImage|packaged AppImage
$APP_DIR/eldrun|packaged build
EOF

# An AppImage execs its payload out of a FUSE mount, so the process actually
# serving the sidecar has /tmp/.mount_*/usr/bin/eldrun on its cmdline and
# matches none of the paths above.
if [ -z "$app_pid" ]; then
  app_pid="$(pgrep -f '^/tmp/\.mount_[^/]*/usr/bin/eldrun' | head -n 1 || true)"
  if [ -n "$app_pid" ]; then
    app_kind="running AppImage"
  fi
fi

started=0
if [ -n "$app_pid" ]; then
  # The proc entry's mtime is the process start time (Linux). Preferred over
  # parsing `ps -o lstart`, whose format follows the locale.
  started="$(stat -c %Y "/proc/$app_pid" 2>/dev/null || echo 0)"
fi

newest_ts() {
  find "$@" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 | cut -d. -f1
}

mobile_entry() {
  # The hashed entry script name is the bundle's identity.
  grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$1" 2>/dev/null | head -n 1
}

# ---------------------------------------------------------------------------
# The exact check: ask the running sidecar which bundle it is serving.
#
# The phone's PWA is EMBEDDED INTO THE BINARY at compile time (src-tauri/
# build.rs bakes mobile-dist/ in), so the sidecar serves the bundle as of its
# own build and no src-tauri mtime says so. Everything else here is an mtime
# proxy; this is ground truth, and it is the one seam where the proxy is wrong
# in both directions — a rebuilt-but-byte-identical bundle looks stale, and a
# binary built somewhere else entirely looks current.
# ---------------------------------------------------------------------------
served_entry=""
probe_note=""
port="$(node -e 'const fs=require("node:fs");let p=8742;try{p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))?.eldrun_mobile_host?.port??8742}catch(e){}process.stdout.write(String(p))' \
  "$STATE_DIR/settings.json" 2>/dev/null || echo 8742)"
if command -v curl >/dev/null 2>&1; then
  shell_html="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [ -n "$shell_html" ]; then
    served_entry="$(printf '%s' "$shell_html" | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -n 1)"
  else
    probe_note="  (Eldrun Mobile is off or not listening on 127.0.0.1:$port, so the embedded
   bundle could only be checked by mtime.)"
  fi
else
  probe_note="  (curl is unavailable, so the embedded bundle could only be checked by mtime.)"
fi

built_entry="$(mobile_entry "$ROOT/mobile-dist/index.html")"

if [ -z "$app_pid" ] && [ -z "$served_entry" ]; then
  if [ "$mobile_only" = "0" ]; then
    echo "No Eldrun is running — nothing to be stale against."
  fi
  exit 0
fi

stale=0
backend_msg=""
mobile_msg=""

# --- backend sources vs. the running process -------------------------------
# Build outputs are excluded — target/ is written BY the build, so including it
# would make every run look fresh immediately after a compile.
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

if [ "$mobile_only" = "0" ] && [ "$started" != "0" ] && [ "$newest" -gt "$started" ]; then
  stale=1
  rel="${newest_file#"$ROOT"/}"
  backend_msg="BACKEND IS STALE — the running window predates your backend changes.
  running pid : $app_pid ($app_kind, started $(date -d "@$started" '+%F %T'))
  newest edit : $rel ($(date -d "@$newest" '+%F %T'))"
fi

# --- the two mobile seams --------------------------------------------------
# They go stale independently: mobile-web sources newer than the built bundle
# (the bundle needs `npm run mobile:build` — `beforeDevCommand` is `npm run
# dev`, which does NOT build it), and a built bundle the running process was
# compiled before (a rebuild re-embeds it). Both showed up as "the phone is
# missing a feature that is plainly in the code".
mobile_src="$(newest_ts "$ROOT/mobile-web/src" "$ROOT/mobile-web/public" "$ROOT/vite.mobile.config.ts" "$ROOT/tsconfig.mobile.json")"
mobile_dist="$(newest_ts "$ROOT/mobile-dist")"
if [ -n "$mobile_src" ] && [ -n "$mobile_dist" ] && [ "$mobile_src" -gt "$mobile_dist" ]; then
  stale=1
  mobile_msg="MOBILE BUNDLE IS STALE — mobile-web/ sources are newer than mobile-dist/.
  Run 'npm run mobile:build', then rebuild the backend to re-embed it."
elif [ -n "$served_entry" ] && [ -n "$built_entry" ] && [ "$served_entry" != "$built_entry" ]; then
  # Ground truth beat the mtimes: the sidecar named a different bundle.
  stale=1
  mobile_msg="EMBEDDED MOBILE PWA IS STALE — the sidecar on 127.0.0.1:$port is serving a
  different bundle than the one built in mobile-dist/. The phone is on the old one.
  serving : $served_entry
  built   : $built_entry"
elif [ -z "$served_entry" ] && [ -n "$mobile_dist" ] && [ "$started" != "0" ] && [ "$mobile_dist" -gt "$started" ]; then
  stale=1
  mobile_msg="EMBEDDED MOBILE PWA IS STALE — the running app was built before the current
  mobile-dist/ bundle ($(date -d "@$mobile_dist" '+%F %T')); the phone is being served the old one.
$probe_note"
fi

# --- the desktop frontend seam ---------------------------------------------
# Only the hot-reload session gets `src/` for free: vite serves it and HMR pushes
# every edit into the window. Every other shape — the frozen "Eldrun (dev)"
# build, the packaged one, the AppImage — has the frontend COMPILED IN, so it
# goes stale exactly like the backend does, and nothing said so. The symptom is
# not an error: the window simply renders an older UI than the hot-reload one
# and looks like a bug in the feature you are staring at (2026-09-04).
#
# Ground truth first, same as the sidecar probe above: vite renames the entry
# bundle on every rebuild, so the key baked into the running executable either
# is the one dist/index.html names or the window is on an older build. Read from
# /proc/<pid>/exe, which resolves an AppImage's payload inside its own mount too.
desktop_msg=""
if [ "$mobile_only" = "0" ] && [ -n "$app_pid" ] && [ "$app_kind" != "hot-reload dev session" ]; then
  desktop_built="$(grep -o '/assets/[A-Za-z0-9_.-]*\.js' "$ROOT/dist/index.html" 2>/dev/null | head -n 1)"
  exe="$(readlink -f "/proc/$app_pid/exe" 2>/dev/null || true)"
  if [ -n "$desktop_built" ] && [ -n "$exe" ] && [ -r "$exe" ] \
     && ! grep -qaF -- "$desktop_built" "$exe"; then
    stale=1
    # The binary also carries the phone's bundle; naming that as the desktop
    # frontend would send the reader after the wrong seam. The one to drop is
    # the bundle this very binary's sidecar is SERVING — its own mobile entry,
    # not the one currently built in mobile-dist/, which is a different key
    # precisely because the binary is stale.
    embedded="$(grep -aoE '/assets/index-[A-Za-z0-9_-]+\.js' "$exe" 2>/dev/null \
      | sort -u \
      | grep -vxF -- "${served_entry:-/dev/null}" \
      | grep -vxF -- "${built_entry:-/dev/null}" | tr '\n' ' ')"
    desktop_msg="EMBEDDED FRONTEND IS STALE — the running $app_kind was built against an older
  dist/ than the one on disk, so the window is showing an older UI than the
  hot-reload one would.
  running : ${embedded:-(no bundle key found)}
  built   : $desktop_built"
  elif [ "$started" != "0" ]; then
    src_ts="$(newest_ts "$ROOT/src" "$ROOT/index.html" "$ROOT/vite.config.ts")"
    if [ -n "$src_ts" ] && [ "$src_ts" -gt "$started" ]; then
      stale=1
      desktop_msg="FRONTEND MAY BE STALE — src/ has changes ($(date -d "@$src_ts" '+%F %T')) newer than the
  running $app_kind, which compiled its frontend in. Nothing hot-reloads here."
    fi
  fi
elif [ "$mobile_only" = "0" ] && [ -n "$served_entry" ] && [ -n "$built_entry" ] \
     && [ "$served_entry" != "$built_entry" ]; then
  # No pid — pgrep saw nothing, which also happens when this runs from inside an
  # agent tab, where the sandbox hides the host's processes. The sidecar still
  # answered over loopback, and it answered with an OLDER bundle than the one
  # just built: whatever window is open was launched from an older binary, and
  # its desktop UI is that old too, not just the phone's.
  stale=1
  desktop_msg="THE OPEN WINDOW PREDATES THE CURRENT BUILD — the sidecar is serving a bundle
  built before the one in mobile-dist/, so the window's compiled-in frontend is
  behind your tree as well. It is not only the phone that is on the old code."
  # `package:dev` installs but never relaunches (AGENTS.md "Running"), and a
  # running frozen instance keeps its old inode — so the usual shape of this is
  # a fresh snapshot sitting on disk that simply nobody has relaunched into.
  desktop_built="${desktop_built:-$(grep -o '/assets/[A-Za-z0-9_.-]*\.js' "$ROOT/dist/index.html" 2>/dev/null | head -n 1)}"
  for snapshot in "$APP_DIR/eldrun-dev" "$APP_DIR/eldrun" "$APP_DIR/eldrun.AppImage"; do
    [ -r "$snapshot" ] || continue
    [ -n "$desktop_built" ] || continue
    if grep -qaF -- "$desktop_built" "$snapshot"; then
      desktop_msg="$desktop_msg
  A CURRENT snapshot is already installed at $snapshot — quit the open
  window and relaunch it; that alone picks the new build up."
      break
    fi
  done
fi

if [ "$stale" = "0" ]; then
  if [ "$mobile_only" = "1" ]; then
    exit 0
  fi
  if [ -n "$app_pid" ]; then
    echo "Backend is current: running pid $app_pid ($app_kind) started after the newest"
    echo "src-tauri change, and its embedded mobile PWA matches mobile-dist/."
    if [ "$app_kind" != "hot-reload dev session" ]; then
      echo "Its compiled-in frontend matches dist/ too."
    fi
  else
    echo "No Eldrun process was identified, but the sidecar on 127.0.0.1:$port is serving"
    echo "$served_entry — the bundle built in mobile-dist/. The Rust side could not be checked."
  fi
  exit 0
fi

first=1
for msg in "$backend_msg" "$mobile_msg" "$desktop_msg"; do
  [ -n "$msg" ] || continue
  [ "$first" = "1" ] || echo
  echo "$msg"
  first=0
done
echo
case "$app_kind" in
  "hot-reload dev session")
    echo "Frontend (src/) changes are already live via vite HMR; only src-tauri/ (and the"
    echo "embedded mobile bundle) need this. Pick them up yourself when it suits you:"
    ;;
  "")
    echo "Pick the changes up yourself when it suits you:"
    ;;
  *)
    echo "Nothing hot-reloads in this shape — src/, src-tauri/ and both bundles are all"
    echo "compiled in. Pick the changes up yourself when it suits you:"
    ;;
esac
case "$app_kind" in
  "hot-reload dev session")
    echo "  pkill -f '$ROOT/node_modules/.bin/tauri'; pkill -f '$ROOT/target/debug/eldrun'"
    echo "  ./start-eldrun-tauri-hotreload.sh"
    ;;
  'frozen "Eldrun (dev)" build')
    echo "  npm run package:dev   # refreezes the tree, mobile bundle included"
    echo "  then quit and relaunch the \"Eldrun (dev)\" entry"
    ;;
  "packaged AppImage"|"packaged build"|"running AppImage")
    echo "  npm run package       # rebuilds and reinstalls, mobile bundle included"
    echo "  then quit and relaunch Eldrun"
    ;;
  *)
    echo "  rebuild whichever Eldrun you are running, then relaunch it"
    ;;
esac
exit 1
