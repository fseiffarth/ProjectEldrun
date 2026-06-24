#!/usr/bin/env bash
# Pre-push privacy / secret scan.
#
# This repo is intended to go public, so block a push if the staged changes
# contain real personal data or live credentials. Private values are derived at
# runtime ($USER / $HOME) rather than hardcoded, and this script excludes itself
# from the scan so its own pattern literals (e.g. "ssh-rsa AAAA") do not
# self-match. Run with changes staged: `git add -A && scripts/privacy-check.sh`.
set -uo pipefail

hits=$(git diff --cached -- . ':!scripts/privacy-check.sh' | grep -nEi \
  -e "$USER" -e "$HOME" \
  -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  -e 'password[[:space:]]*[:=]' -e 'secret[[:space:]]*[:=]' \
  -e 'api[_-]?key[[:space:]]*[:=]' -e 'BEGIN [A-Z ]*PRIVATE KEY' \
  -e 'ssh-rsa AAAA' -e 'ghp_[A-Za-z0-9]' -e 'glpat-' \
  -e '[0-9]{1,3}(\.[0-9]{1,3}){3}' \
  | grep -vi 'noreply' || true)

if [ -n "$hits" ]; then
  echo "Privacy check: potential sensitive data in staged changes:" >&2
  echo "$hits" >&2
  echo >&2
  echo "Blockers: real account email, developer real name / home path, live" >&2
  echo "API keys/tokens, private keys, internal hostnames/IPs." >&2
  echo "Expected & fine: env-var NAMES, params named 'password', UI placeholders," >&2
  echo "fake test tokens, /home/user/ fixture paths, the public io.github.* id." >&2
  echo "Review each match; re-run once resolved." >&2
  exit 1
fi

echo "Privacy check: no sensitive data detected in staged changes."
