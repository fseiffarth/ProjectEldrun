#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/eldrun"
DESKTOP_DIR="$HOME/.local/share/applications"
BINARY_DEST="$APP_DIR/eldrun"
DESKTOP_STABLE_DEST="$DESKTOP_DIR/Eldrun.desktop"
DESKTOP_HOTRELOAD_DEST="$DESKTOP_DIR/EldrunHotReload.desktop"

mkdir -p "$APP_DIR" "$DESKTOP_DIR"

cd "$ROOT"

# Try AppImage bundle first; fall back to raw binary if linuxdeploy fails (e.g. no FUSE).
APPIMAGE_SRC=""
if APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:bundle 2>&1; then
  APPIMAGE_SRC="$(find "$ROOT/target/release/bundle/appimage" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
fi

if [[ -n "${APPIMAGE_SRC:-}" && -f "$APPIMAGE_SRC" ]]; then
  install -Dm755 "$APPIMAGE_SRC" "$BINARY_DEST.AppImage"
  BINARY_DEST="$BINARY_DEST.AppImage"
  echo "Installed AppImage to: $BINARY_DEST"
else
  # AppImage bundling unavailable (no FUSE); use the raw release binary.
  RAW_BIN="$ROOT/target/release/eldrun"
  if [[ ! -f "$RAW_BIN" ]]; then
    # Bundle failed before linking — do a plain cargo build.
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml"
  fi
  install -Dm755 "$RAW_BIN" "$BINARY_DEST"
  echo "AppImage bundling unavailable (no FUSE); installed raw binary to: $BINARY_DEST"
fi

cat >"$DESKTOP_STABLE_DEST" <<EOF
[Desktop Entry]
Type=Application
Name=Eldrun
Comment=Terminal workspace manager
Exec=$BINARY_DEST
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=eldrun
EOF
chmod 755 "$DESKTOP_STABLE_DEST"

cat >"$DESKTOP_HOTRELOAD_DEST" <<EOF
[Desktop Entry]
Type=Application
Name=EldrunHotReload
Comment=Terminal workspace manager hot reload
Exec=$ROOT/start-eldrun-tauri-hotreload.sh
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=eldrun
EOF
chmod 755 "$DESKTOP_HOTRELOAD_DEST"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Desktop entry: $DESKTOP_STABLE_DEST"
echo "HotReload desktop entry: $DESKTOP_HOTRELOAD_DEST"
