#!/usr/bin/env bash
# Pre-push privacy / secret scan.
#
# This repo is intended to go public, so block a push if the staged changes
# contain real personal data or live credentials. Private values are derived at
# runtime ($USER / $HOME) rather than hardcoded, and this script excludes itself
# from the scan so its own pattern literals (e.g. "ssh-rsa AAAA") do not
# self-match. Run with changes staged: `git add -A && scripts/privacy-check.sh`.
set -uo pipefail

# Resolve a REAL grep binary. An interactive shell may shadow `grep` with a
# wrapper (e.g. a ugrep function under some tooling) that mishandles these ERE
# patterns; combined with a swallowed error that used to silently report
# "clean". Always use a known binary, and FAIL LOUDLY (exit 2) if the scan tool
# itself errors, rather than passing a scan that never actually ran.
GREP=""
for g in /usr/bin/grep /bin/grep "$(command -v grep 2>/dev/null || true)"; do
  if [ -n "${g:-}" ] && [ -x "$g" ]; then GREP="$g"; break; fi
done
if [ -z "$GREP" ]; then
  echo "privacy-check: no usable grep binary found; refusing to report clean." >&2
  exit 2
fi

# Patterns to flag in ADDED lines. $USER/$HOME are added only when non-empty so
# an empty value can't degrade into a match-everything pattern (a false pass).
patterns=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  'password[[:space:]]*[:=]' 'secret[[:space:]]*[:=]'
  'api[_-]?key[[:space:]]*[:=]' 'BEGIN [A-Z ]*PRIVATE KEY'
  'ssh-rsa AAAA' 'ghp_[A-Za-z0-9]' 'glpat-'
  '[0-9]{1,3}(\.[0-9]{1,3}){3}'
)
[ -n "${USER:-}" ] && patterns+=("$USER")
[ -n "${HOME:-}" ] && patterns+=("$HOME")

grep_args=()
for p in "${patterns[@]}"; do grep_args+=(-e "$p"); done

# Only inspect ADDED lines (+), not removed ones — deleting sensitive data must
# not trip the check. Strip the `+++` file-header lines before matching.
added=$(git diff --cached -- . ':!scripts/privacy-check.sh' \
  | "$GREP" -E '^\+' | "$GREP" -v '^[+][+][+]') || true

# Run the match grep on its own so we can tell a real grep error (rc >= 2) from
# "no matches" (rc 1). pipefail makes rc reflect grep, not the leading printf.
matched=$(printf '%s\n' "$added" | "$GREP" -nEi "${grep_args[@]}")
rc=$?
if [ "$rc" -ge 2 ]; then
  echo "privacy-check: scan tool error (grep rc=$rc); refusing to report clean." >&2
  exit 2
fi

hits=$(printf '%s\n' "$matched" | "$GREP" -vi 'noreply') || true
# The noreply filter can yield a single empty line; treat whitespace-only as none.
if [ -n "${hits//[[:space:]]/}" ]; then
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
