#!/usr/bin/env bash
# Launcher for the hot-reload Tauri dev server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Desktop entries don't source ~/.bashrc, so cargo won't be in PATH.
export PATH="$HOME/.cargo/bin:$PATH"

exec npm run tauri dev
