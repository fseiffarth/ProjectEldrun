#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/eldrun"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
APPIMAGE_DEST="$APP_DIR/eldrun.AppImage"
ICON_DEST="$APP_DIR/icon.png"
LAUNCHER_DEST="$BIN_DIR/eldrun"
DESKTOP_DEST="$DESKTOP_DIR/Eldrun-Tauri.desktop"

mkdir -p "$APP_DIR" "$BIN_DIR" "$DESKTOP_DIR"

cd "$ROOT"
npm run tauri:bundle

APPIMAGE_SRC="$(find "$ROOT/src-tauri/target/release/bundle/appimage" -maxdepth 1 -name '*.AppImage' -print -quit)"
if [[ -z "${APPIMAGE_SRC:-}" ]]; then
  echo "No AppImage was produced under src-tauri/target/release/bundle/appimage" >&2
  exit 1
fi

install -Dm755 "$APPIMAGE_SRC" "$APPIMAGE_DEST"
install -Dm644 "$ROOT/src-tauri/icons/128x128.png" "$ICON_DEST"

cat >"$LAUNCHER_DEST" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$APPIMAGE_DEST" "\$@"
EOF
chmod +x "$LAUNCHER_DEST"

cat >"$DESKTOP_DEST" <<EOF
[Desktop Entry]
Type=Application
Name=Eldrun (Tauri)
Comment=Terminal workspace manager — Tauri/React rewrite
Exec=$LAUNCHER_DEST
Icon=$ICON_DEST
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=eldrun
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed packaged Eldrun to: $APPIMAGE_DEST"
echo "Launcher: $LAUNCHER_DEST"
echo "Desktop entry: $DESKTOP_DEST"
