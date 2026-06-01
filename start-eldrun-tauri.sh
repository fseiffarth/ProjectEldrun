#!/usr/bin/env bash
set -euo pipefail

APPIMAGE="$HOME/.local/share/eldrun/eldrun.AppImage"
BINARY="$HOME/.local/share/eldrun/eldrun"

if [[ -x "$APPIMAGE" ]]; then
  exec "$APPIMAGE" "$@"
elif [[ -x "$BINARY" ]]; then
  exec "$BINARY" "$@"
else
  printf '%s\n' "Eldrun package missing." \
    "Run 'npm run package' to build and install Eldrun first." >&2
  exit 1
fi
