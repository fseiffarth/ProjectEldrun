#!/usr/bin/env bash
# Thin launcher for the packaged Eldrun AppImage.
set -euo pipefail

APPIMAGE="$HOME/.local/share/eldrun/eldrun.AppImage"

if [[ ! -x "$APPIMAGE" ]]; then
  printf '%s\n' "Eldrun is not packaged yet." \
    "Run 'npm run package' to build and install the AppImage first." >&2
  exit 1
fi

exec "$APPIMAGE" "$@"
