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
build_log="$(mktemp)"
trap 'rm -f "$build_log"' EXIT
if ! npm run tauri -- build --no-bundle 2>&1 | tee "$build_log"; then
  if grep -q "Too many open files" "$build_log"; then
    echo "package-dev: tauri-cli could not open an inotify instance; building without it." >&2
    npm run build
    cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml"
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

# The running frozen instance keeps its old inode; `install` replaces the path
# atomically enough that a relaunch picks the new snapshot up.
install -Dm755 "$RAW_BIN" "$BINARY_DEST"

VERSION="$(node -p "require('$ROOT/package.json').version")"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then DIRTY="+local"; fi
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
StartupWMClass=eldrun
DESKTOP
chmod 755 "$DESKTOP_DEST"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed frozen binary: $BINARY_DEST ($VERSION @ $COMMIT$DIRTY)"
echo "Desktop entry: $DESKTOP_DEST"
