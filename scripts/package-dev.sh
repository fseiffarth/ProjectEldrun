#!/usr/bin/env bash
# Build the CURRENT working tree as a frozen release binary and install it as
# the "Eldrun (dev)" desktop entry.
#
# A snapshot of the tree that edits cannot touch — no vite HMR, no `tauri dev`
# relaunch — for working (and spotting bugs) undisturbed; the hot-reload window
# is where a fix is then checked. The two share the real state and run one at
# a time (AGENTS.md "Running"). Re-run this script to freeze a newer snapshot;
# the entry's Comment says which commit it is.
#
# Compared with package-local.sh (the stable AppImage under the plain "Eldrun"
# entry) this skips bundling: `tauri build --no-bundle` links the release
# binary with the frontend embedded and needs no FUSE/linuxdeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/eldrun"
DESKTOP_DIR="$HOME/.local/share/applications"
BINARY_DEST="$APP_DIR/eldrun-dev"
DESKTOP_DEST="$DESKTOP_DIR/EldrunDev.desktop"
LAUNCHER="$ROOT/start-eldrun-dev-build.sh"

mkdir -p "$APP_DIR" "$DESKTOP_DIR"
cd "$ROOT"

export PATH="$HOME/.cargo/bin:$PATH"

# beforeBuildCommand runs `npm run build` (tsc + vite + mobile bundle), so a
# type error anywhere fails here, same as CI.
#
# The fallback is for one specific failure: tauri-cli builds a file watcher
# before it does anything, even for `build`, and the watcher needs an inotify
# INSTANCE — a per-user resource capped at 128 (`fs.inotify.max_user_instances`)
# that a desktop session with a running Eldrun, a vite dev server and a browser
# routinely sits just under. tauri-cli unwraps that error and aborts (SIGABRT,
# "Too many open files"), which is precisely the moment this script exists for:
# freezing the tree WHILE working. `tauri build --no-bundle` is
# `npm run build` + `cargo build --release` with the bundling step skipped, so
# run those two directly rather than asking the user to close things.
#
# `--features custom-protocol` is the part the CLI would otherwise supply, and
# it is not optional: without it tauri compiles the app in *dev* mode, which
# embeds no frontend and points the window at devUrl — a frozen build that
# opens "Could not connect to localhost" and nothing else (2026-09-02).
build_log="$(mktemp)"
trap 'rm -f "$build_log"' EXIT
if ! npm run tauri -- build --no-bundle 2>&1 | tee "$build_log"; then
  # Two ways inotify runs dry: no instance left ("Too many open files") and no
  # *watch* left ("OS file watch limit reached", fs.inotify.max_user_watches —
  # hit 2026-09-13 with the default 65536 and a dev server + Eldrun watching).
  if grep -qE "Too many open files|file watch limit reached" "$build_log"; then
    echo "package-dev: tauri-cli could not set up its file watcher; building without it." >&2
    npm run build
    cargo build --release --features custom-protocol \
      --manifest-path "$ROOT/src-tauri/Cargo.toml"
  else
    exit 1
  fi
fi

RAW_BIN=""
for candidate in "$ROOT/target/release/eldrun" "$ROOT/src-tauri/target/release/eldrun"; do
  if [[ -f "$candidate" ]]; then RAW_BIN="$candidate"; break; fi
done
if [[ -z "$RAW_BIN" ]]; then
  echo "package-dev: release binary not found after build" >&2
  exit 1
fi

# Whichever path built it, it has to be a prod binary: a dev one would install
# and launch fine and then show only WebKit's connection-refused page.
"$ROOT/scripts/assert-embedded-frontend.sh" "$RAW_BIN"

VERSION="$(node -p "require('$ROOT/package.json').version")"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then DIRTY="+local"; fi

# Record that THIS artifact passed that check against the dist/ it was built
# from. The launcher adopts on this record rather than re-running the check:
# dist/ does not stand still after a build — every `npm run build` an agent
# runs as a gate rewrites it with new content hashes, uncommitted edits and all
# — and re-checking a finished binary against whatever dist/ holds at LAUNCH
# time called four days of correct builds "stale" and left the desktop icon on
# a snapshot from before them (2026-09-14). The sha pins the record to the
# exact bytes, so a later build that fails the check cannot inherit it.
FROZEN_STAMP="$RAW_BIN.frozen"
{
  printf 'sha256=%s\n' "$(sha256sum "$RAW_BIN" | cut -d' ' -f1)"
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s%s\n' "$COMMIT" "$DIRTY"
  printf 'built=%s\n' "$(date -Is)"
} >"$FROZEN_STAMP"

# Installing into a tmpfs is not installing.
#
# Run from inside an agent tab, `services::agent_fence` has replaced $HOME with
# a tmpfs holding only the project and a couple of bound state paths. The BUILD
# above is real -- target/ is inside the bound project -- but the install below
# would write 75 MB into a directory that dies with the tab, and then print
# "Installed frozen binary". Since the post-commit hook started freezing on
# every commit, and commits are made from agent tabs, that is every freeze: the
# desktop icon opened a two-day-old window while a dozen commits each reported
# success (2026-09-04).
#
# So stop at the artifact and say so. start-eldrun-dev-build.sh adopts it at
# launch, in the user's own session, where no fence can swallow it.
if [ "$(stat -f -c %T "$APP_DIR" 2>/dev/null || echo unknown)" = "tmpfs" ] ||
   [ "${ELDRUN_AGENT_FENCE:-}" = "1" ]; then
  cat <<MSG
package-dev: built $RAW_BIN, and stopped there.
  $APP_DIR is a tmpfs, so this is running inside an agent fence and anything
  installed there evaporates with the tab. The build is real; the install
  would not be.
  The "Eldrun (dev)" launcher adopts that binary on its next start, so
  relaunching Eldrun (dev) picks this snapshot up. Nothing else to do.
MSG
  exit 0
fi

# The running frozen instance keeps its old inode; `install` replaces the path
# atomically enough that a relaunch picks the new snapshot up.
install -Dm755 "$RAW_BIN" "$BINARY_DEST"

STAMP="$(date +%Y-%m-%d)"

cat >"$DESKTOP_DEST" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Eldrun (dev)
Comment=Frozen build $VERSION @ $COMMIT$DIRTY ($STAMP) — no hot reload
Exec=$LAUNCHER
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=$(basename "$BINARY_DEST")
DESKTOP
chmod 755 "$DESKTOP_DEST"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed frozen binary: $BINARY_DEST ($VERSION @ $COMMIT$DIRTY)"
echo "Desktop entry: $DESKTOP_DEST"
