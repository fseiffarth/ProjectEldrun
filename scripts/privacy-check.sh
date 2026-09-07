#!/usr/bin/env bash
# Pre-push privacy / secret scan.
#
# This repo is intended to go public, so block a push if the changes under
# review contain real personal data or live credentials. Private values are
# derived at runtime ($USER / $HOME) rather than hardcoded, and this script
# excludes itself from the scan so its own pattern literals (e.g. "ssh-rsa
# AAAA") do not self-match.
#
# Usage:
#   scripts/privacy-check.sh                 # staged changes (git add -A first)
#   scripts/privacy-check.sh <base>..<head>  # a commit range — what a push sends
#   scripts/privacy-check.sh <any git-diff args>
#
# Callers: `.githooks/pre-push` (range form, over the commits actually being
# pushed) and the `privacy` CI job. Both exist because the hook needs
# `git config core.hooksPath .githooks` per clone and a fresh clone has it off.
#
# Env:
#   PRIVACY_CHECK_SKIP_IDENTITY=1  drop the $USER/$HOME patterns. They exist to
#     catch the *developer's* identity leaking into the tree; on a CI runner
#     those values are the runner's own ("runner", "/home/runner") and would
#     match innocuous text on every run.
set -uo pipefail

# Default to the index; any argument is passed straight through to `git diff`,
# so a `<base>..<head>` range works without a flag of its own.
diff_args=("--cached")
scope="staged changes"
if [ "$#" -gt 0 ]; then
  diff_args=("$@")
  scope="$*"
fi

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

# Same reasoning for sed (used by the benign-literal scrub below): a shadowed or
# missing binary must fail loudly, never quietly clear a line.
SED=""
for s in /usr/bin/sed /bin/sed "$(command -v sed 2>/dev/null || true)"; do
  if [ -n "${s:-}" ] && [ -x "$s" ]; then SED="$s"; break; fi
done
if [ -z "$SED" ]; then
  echo "privacy-check: no usable sed binary found; refusing to report clean." >&2
  exit 2
fi

# Patterns to flag in ADDED lines. $USER/$HOME are added only when non-empty so
# an empty value can't degrade into a match-everything pattern (a false pass).
patterns=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  'password[[:space:]]*[:=]' 'secret[[:space:]]*[:=]'
  'api[_-]?key[[:space:]]*[:=]' 'BEGIN [A-Z ]*PRIVATE KEY'
  # A real key is `ssh-rsa AAAAB3NzaC1...` running on for hundreds of base64
  # characters. Requiring that tail keeps the bare literal `ssh-rsa AAAA` — which
  # appears in prose describing *this scan* — from matching, while still catching
  # every actual key, since none is anywhere near this short.
  'ssh-rsa AAAA[A-Za-z0-9+/]{20,}' 'ghp_[A-Za-z0-9]' 'glpat-'
  '[0-9]{1,3}(\.[0-9]{1,3}){3}'
)
if [ -z "${PRIVACY_CHECK_SKIP_IDENTITY:-}" ]; then
  [ -n "${USER:-}" ] && patterns+=("$USER")
  [ -n "${HOME:-}" ] && patterns+=("$HOME")
fi

grep_args=()
for p in "${patterns[@]}"; do grep_args+=(-e "$p"); done

# Literals that cannot be personal data *by construction*, and which this repo's
# code and fixtures are necessarily full of:
#
#   - Loopback and unspecified addresses. `127.0.0.0/8`, `::1`, `0.0.0.0` and
#     `255.255.255.255` name no host anywhere; a loopback address is the exact
#     opposite of the leaked-internal-IP this scan is looking for, and the Ollama
#     and CalDAV transports cannot be described or tested without writing them.
#   - IANA-reserved domains (RFC 2606 / RFC 6761): the `example`, `test`,
#     `invalid` and `localhost` TLDs plus `example.com|org|net` exist so that
#     documentation and test fixtures can name a domain that is guaranteed never
#     to be real. Mail/CalDAV fixtures use them by the hundred.
#
# These are SCRUBBED FROM THE LINE and the line is then re-matched — the whole
# line is never dropped on sight. That distinction is the point: a line pairing
# `127.0.0.1` with a live token, or a real address at a real domain, still has
# something left after the scrub and is still reported. Only a line with nothing
# left is cleared. RFC 1918 ranges (10/8, 172.16/12, 192.168/16) are deliberately
# NOT scrubbed — those do name a host on somebody's network.
scrub_args=(
  # FIRST, because every rule below reads the line as text: strip grep's own
  # `<lineno>:` prefix and the diff's `+` marker. Neither is part of the line,
  # and `+` is in the email pattern's local-part class — which is why a bare
  # `@AGENTS.md` import directive at the start of an added line scanned as an
  # address, with the diff marker standing in for the name.
  -e 's/^[0-9]+:\+//'
  -e 's/\b127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b//g'
  -e 's/\b(0\.0\.0\.0|255\.255\.255\.255)\b//g'
  # RFC 5737 documentation ranges — reserved so examples and tests can name an
  # address that is guaranteed never to route anywhere.
  -e 's/\b(192\.0\.2|198\.51\.100|203\.0\.113)\.[0-9]{1,3}\b//g'
  # RFC 3927 link-local (169.254/16): autoconfigured, never routed, and names no
  # host on anybody's network — loopback's reasoning above. Unavoidable in this
  # tree, since 169.254.169.254 is the cloud metadata endpoint the reader
  # fetch's SSRF gate exists to block, and that gate cannot be described or
  # tested without writing the address down.
  -e 's/\b169\.254\.[0-9]{1,3}\.[0-9]{1,3}\b//g'
  # Reserved domains are matched case-insensitively, because a domain IS
  # case-insensitive: `A@Example.com` names the same reserved domain as
  # `a@example.com`, and a fixture that capitalizes it is still a fixture.
  -e 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)*(example|test|invalid|localhost)\b//gI'
  -e 's/[A-Za-z0-9._%+-]+@example\.(com|org|net)\b//gI'
  # `git@<host>` is the SSH login every git host shares — a service account, not
  # a person — and it is what a clone URL and every OpenSSH failure message
  # carries. Only that exact local part: `florian@github.com` still reports.
  -e 's/\bgit@[A-Za-z0-9.-]+\.[A-Za-z]{2,}//g'
  # A credential keyword followed by a TYPE rather than a value: `password:
  # &Password` in a Rust signature declares a parameter, it does not carry one.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*:[[:space:]]*&?(mut[[:space:]]+)?[A-Z][A-Za-z0-9_]*//gI'
  # ...or by a literal that is definitionally not a credential.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*(false|true|None|null|nil|undefined|0)\b//gI'
  # ...or by a CALL: `let password = creds::get(&account)` reads a secret out of
  # the keychain at runtime, which is the pattern this repo is supposed to use —
  # the opposite of the hardcoded credential the scan is hunting for, and the
  # "params named 'password'" case the guidance below already calls expected.
  # Narrow on purpose: `=` only (a `:` is a struct/JSON/YAML field, where a value
  # really can be a literal), and the right-hand side must be an identifier or
  # `::`/`.` path ending in `(`, so `password = "hunter2"` and a bare
  # `password=hunter2` are both still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*=[[:space:]]*&?[A-Za-z_][A-Za-z0-9_]*([:.]{1,2}[A-Za-z_][A-Za-z0-9_]*)*\(//gI'
  # ...or by a BRANCH: `let password = if supplied.is_some() {` picks between two
  # runtime sources (a supplied value or the keychain), exactly as the call case
  # above does — a keyword `if`/`match`/`else` opens an expression, so what
  # follows the `=` on this line cannot be the credential itself. `=` only, for
  # the call case's reason, and the keyword must be the whole token, so
  # `password = ifconfig_out` is untouched and still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*=[[:space:]]*(if|match|else)\b//gI'
  # ...or by NOTHING AT ALL: a prompt string the SSH and OpenVPN matchers compare
  # against (`"…'s password: "`), not an assignment. Cleared only when the
  # separator is followed by a quote that ENDS the line, bar trailing
  # punctuation — so `password: "hunter2"` keeps its value and is still reported.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"[[:space:]]*[,;)]*[[:space:]]*$//gI'
  # ...or by a PLACEHOLDER word rather than a secret: `ANTHROPIC_API_KEY=sk-test`
  # is a fixture asserting the variable is passed through at all. Narrow to
  # values built out of the standard placeholder words, so a real `sk-ant-api03-`
  # value is untouched.
  -e 's/(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_-]*(test|dummy|fake|placeholder|redacted|changeme|sample)[A-Za-z0-9_-]*//gI'
  # A PEM header immediately followed by the two-character escape `\n` is a
  # string literal in source, not a key file: a real key's header is followed by
  # an actual line break. ONLY the header is cleared — any base64 body sharing
  # the line survives the scrub and is still reported.
  -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----\\n//g'
  # A token PREFIX followed by an ellipsis or an angle placeholder is a UI hint
  # showing the reader what their own token looks like (`GitLab (glpat-…)`).
  # A real token continues in base62, so it keeps its prefix and is reported.
  -e 's/\b(glpat-|ghp_|sk-)(…|\.\.\.|<)//g'
  # ...or by a placeholder WORD AND NOTHING ELSE (`git_token: "ghp_test"`), which
  # is the shape a fixture takes when the keyword itself is not one this scan
  # knows (`git_token` is not `api_key`). The trailing `\b` is what keeps it
  # narrow: a real `ghp_testAbC123…` continues into the word and still reports.
  -e 's/\b(glpat-|ghp_|sk-)(test|dummy|fake|placeholder|redacted|changeme|sample)\b//gI'
)

# Last resort for a line that is genuinely fine but that no general rule can
# clear — an inline `privacy-check: ok` marker with a reason. Deliberately narrow
# and deliberately visible: it lives on the offending line, so it shows up in the
# diff under review rather than in a side file nobody opens. Prefer a real fix
# (a reserved example domain, a runtime-derived path) over a marker.
ALLOW_MARKER='privacy-check: ok'

# Only inspect ADDED lines (+), not removed ones — deleting sensitive data must
# not trip the check. Strip the `+++` file-header lines before matching.
added=$(git diff "${diff_args[@]}" -- . ':!scripts/privacy-check.sh' \
  | "$GREP" -E '^\+' | "$GREP" -v '^[+][+][+]') || true

# Run the match grep on its own so we can tell a real grep error (rc >= 2) from
# "no matches" (rc 1). pipefail makes rc reflect grep, not the leading printf.
matched=$(printf '%s\n' "$added" | "$GREP" -nEi "${grep_args[@]}")
rc=$?
if [ "$rc" -ge 2 ]; then
  echo "privacy-check: scan tool error (grep rc=$rc); refusing to report clean." >&2
  exit 2
fi

candidates=$(printf '%s\n' "$matched" \
  | "$GREP" -vi 'noreply' | "$GREP" -vF "$ALLOW_MARKER") || true

# Re-match each candidate with the benign literals scrubbed out (see scrub_args).
# A line that no longer matches anything had only loopback addresses and reserved
# example domains in it, and is cleared; everything else is reported verbatim,
# with its original text, so a review still reads the real line.
hits=""
if [ -n "${candidates//[[:space:]]/}" ]; then
  while IFS= read -r line; do
    [ -n "${line//[[:space:]]/}" ] || continue
    stripped=$(printf '%s\n' "$line" | "$SED" -E "${scrub_args[@]}")
    src=$?
    if [ "$src" -ne 0 ]; then
      echo "privacy-check: scrub tool error (sed rc=$src); refusing to report clean." >&2
      exit 2
    fi
    if printf '%s\n' "$stripped" | "$GREP" -qEi "${grep_args[@]}"; then
      hits+="$line"$'\n'
    fi
  done <<< "$candidates"
fi

# The filters can yield a single empty line; treat whitespace-only as none.
if [ -n "${hits//[[:space:]]/}" ]; then
  echo "Privacy check: potential sensitive data in ${scope}:" >&2
  echo "$hits" >&2
  echo >&2
  echo "Blockers: real account email, developer real name / home path, live" >&2
  echo "API keys/tokens, private keys, internal hostnames/IPs." >&2
  echo "Expected & fine: env-var NAMES, params named 'password', UI placeholders," >&2
  echo "fake test tokens, /home/user/ fixture paths, the public io.github.* id." >&2
  echo "Review each match; re-run once resolved." >&2
  exit 1
fi

echo "Privacy check: no sensitive data detected in ${scope}."
