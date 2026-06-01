#!/usr/bin/env bash
# Launcher for the Tauri dev build.
# After `cargo tauri build`, replace this with the compiled binary:
#   ~/.../target/release/eldrun
set -e
cd "$(dirname "$0")"
. "$HOME/.cargo/env"
exec cargo tauri dev
