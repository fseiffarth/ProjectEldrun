#!/usr/bin/env bash
# Launcher for the hot-reload Tauri dev server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.local/share/eldrun"
LOG_FILE="$LOG_DIR/hotreload.log"

mkdir -p "$LOG_DIR"
exec >>"$LOG_FILE" 2>&1

printf '\n=== HOTRELOAD START %s ===\n' "$(date -Is)"
trap 'status=$?; printf "=== HOTRELOAD EXIT %s status=%s ===\n" "$(date -Is)" "$status"' EXIT

cd "$ROOT"

# Desktop entries don't source ~/.bashrc, so Rust tools may not be in PATH.
export PATH="$HOME/.cargo/bin:$PATH"

printf 'root=%s\n' "$ROOT"
printf 'PATH=%s\n' "$PATH"
command -v node
node --version
command -v npm
npm --version
command -v cargo
cargo --version
command -v rustc
rustc --version

exec npm run tauri:dev
