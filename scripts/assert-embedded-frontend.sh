#!/usr/bin/env bash
# Refuse to install a packaged binary that carries no frontend.
#
# A tauri binary compiled without the `custom-protocol` feature is a *dev*
# binary: tauri's build script sets `dev = !custom_protocol`, a dev build embeds
# no assets at all, and the window loads tauri.conf.json's `devUrl`. Installed
# behind a desktop entry and launched with no vite listening on 1420, that app
# shows one thing — WebKit's "Could not connect to localhost: Connection
# refused" page — which reads as a broken app rather than a broken build
# (hit on 2026-09-02 via package-dev.sh's inotify fallback).
#
# The check: dist/index.html names a content-hashed bundle, and a prod build
# keeps every asset path as a plain string key in the binary's phf map (only the
# asset *bytes* are compressed). No key in the binary, no frontend in it either.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${1:?usage: assert-embedded-frontend.sh <binary>}"
INDEX="$ROOT/dist/index.html"

if [ ! -f "$INDEX" ]; then
  echo "assert-embedded-frontend: no $INDEX to verify against; run npm run build first" >&2
  exit 1
fi

key="$(grep -o '/assets/[A-Za-z0-9_.-]*\.js' "$INDEX" | head -1)"
if [ -z "$key" ]; then
  echo "assert-embedded-frontend: $INDEX names no /assets/*.js bundle" >&2
  exit 1
fi

if ! grep -qF -- "$key" "$BINARY"; then
  cat >&2 <<MSG
assert-embedded-frontend: $BINARY does not embed the frontend ($key missing).
  It was built without the \`custom-protocol\` feature, so it is a dev binary and
  would open "Could not connect to localhost" instead of the app.
  Rebuild it with: cargo build --release --features custom-protocol
MSG
  exit 1
fi
