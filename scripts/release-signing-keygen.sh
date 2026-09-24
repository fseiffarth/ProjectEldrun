#!/usr/bin/env bash
# Generate the ECDSA P-256 key pair that signs release checksums (#160).
#
# The public half goes into the repo (src-tauri/release-signing.pub.pem) and is
# compiled into the updater; the private half never enters the repo. Put it in
# the RELEASE_SIGNING_KEY GitHub secret, keep an offline copy (a password
# manager), then delete the file:
#
#   gh secret set RELEASE_SIGNING_KEY --repo fseiffarth/ProjectEldrun < <key file>
#
# Rotating the key means a new public key ships in a release signed with the
# OLD key — builds carrying only the old key cannot verify anything else.
# A lost private key therefore means one manual update for every user.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pub="$repo_root/src-tauri/release-signing.pub.pem"
key_dir="${ELDRUN_RELEASE_KEY_DIR:-$HOME/.config/eldrun-release-signing}"
key="$key_dir/release-signing.key.pem"

if [ -e "$key" ]; then
  echo "refusing: $key already exists" >&2
  exit 1
fi

umask 077
mkdir -p "$key_dir"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key"
openssl pkey -in "$key" -pubout -out "$pub"
chmod 644 "$pub"

echo "private key: $key"
echo "public key:  $pub (commit this)"
echo "next: gh secret set RELEASE_SIGNING_KEY --repo fseiffarth/ProjectEldrun < \"$key\""
