#!/usr/bin/env bash
# The app's name is spelled in ONE place per language — src-tauri/src/brand.rs,
# src/lib/brand.ts, and the scripts read it through scripts/lib/brand.sh. This
# fails when a tracked file outside the allowlist below spells it itself, so a
# hard-coded name cannot creep back in between the rename's phases.
#
#   scripts/brand-check.sh            # check; exit 1 and list every hit
#   scripts/brand-check.sh --list     # also print how many hits each allowlist
#                                     # entry is still covering (what is left
#                                     # for the flip), and entries covering none
#
# What is checked: every tracked text file's content, and every tracked path,
# case-insensitively, for the name's lowercase form — the current one and the
# old one (`app_slug!` / `legacy_slug!` in brand.rs; the same word until the
# rename's flip).
#
# What is let through:
#   * a path on the ALLOW list below. Each entry says why it is there and which
#     phase of docs/rename_plan.md removes it;
#   * a line carrying `brand-check: allow` (with the reason), or the line right
#     after one. For the few spellings no constant can reach — a serde key, an
#     `include_bytes!` path;
#   * comments (see COMMENTS_ARE_PROSE). They tell the code's history and are
#     prose like the docs; the flip rewrites both with one sed.
#
# Runs in CI next to privacy-check.sh, and by hand with the other gates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_SLUG, $APP_LEGACY_SLUG, …
. "$ROOT/scripts/lib/brand.sh"
cd "$ROOT"

# Phase 3 (the flip): set to 0 once the prose sed has rewritten the comments,
# so that a comment naming the old brand fails like any other line.
COMMENTS_ARE_PROSE=1

# ---------------------------------------------------------------------------
# The allowlist. One bash `case` pattern per entry (`*` also matches `/`),
# matched against the path from the repo root. Keep every entry explained, and
# keep it as narrow as the reason: a whole directory only where every file in
# it has the same reason.
#
# "flip" = the name-carrying spot `scripts/brand-flip.sh` rewrites in the
# phase-3 flip commit; "prose" = text the phase-3 sed rewrites. Entries marked
# "stays" survive release B.
# ---------------------------------------------------------------------------
ALLOW=(
  # --- The brand modules: the one place per language the name is written. ---
  # Stays. After the flip they hold the new name and the LEGACY_* old one.
  'src-tauri/src/brand.rs'
  'src/lib/brand.ts'

  # --- Prose: documentation and notes. Phase 3 (prose sed). -----------------
  # History prose ("formerly …") in README/changelog stays after release B.
  # `*.md` covers README, DOCUMENTATION, AGENTS, todo/, docs/help, …, and the
  # frozen scaffold texts in src-tauri/src/commands/scaffold_history/, which
  # stay byte-identical for good (they recognise an unedited copy in a project).
  '*.md'
  # The docs folder's non-markdown files: sample launchers and desktop entries.
  'docs/*'
  'LICENSE-MIT'
  'LICENSE-APACHE'
  # Translatable prose in a registry that scripts/untested.mjs parses as text.
  'src/lib/untested.ts'

  # --- Frozen texts: must stay byte-identical, whatever the app is called. ---
  # Signed-release test fixtures (checksums over asset names). Stays.
  'src-tauri/src/services/app_update.rs'
  # Recorded state and inputs older builds wrote, for round-trip tests. Stays
  # (the phase-2 migrator's tests read old-shaped data on purpose).
  'test-fixtures/*'
  'src/__tests__/fixtures/*'
  'src-tauri/tests/fixtures/*'

  # --- Flip points: package and bundle metadata. Phase 3 (brand-flip.sh). ---
  'Cargo.toml'
  'Cargo.lock'
  'src-tauri/Cargo.toml'
  'package.json'
  'package-lock.json'
  'src-tauri/tauri.conf.json'
  'src-tauri/tauri.macos.conf.json'
  'src-tauri/capabilities/*'
  'src-tauri/gen/*'
  'src-tauri/entitlements.plist'
  # Static pages and manifests no module can fill in. BrandMirror.test.ts
  # holds each to the brand module. Phase 3.
  'index.html'
  'mobile-web/index.html'
  'mobile-web/terminal-preview.html'
  'mobile-web/public/manifest.webmanifest'
  'mobile-web/public/sw.js'
  # Artwork: the name in <title>/aria-label and the wordmark. Phase 3.
  '*.svg'
  # Blob ids of reviewed binaries, listed with their paths. Phase 3, when the
  # renamed files are re-recorded.
  'scripts/privacy-reviewed-binaries.txt'

  # --- Flip points: files NAMED after the app. Phase 3 (renamed, with a ------
  # forwarding stub under the old name until release B). Their contents read
  # the name through scripts/lib/brand.sh already, unless listed further down.
  # Spelled with the helper's old-name variable: this script is checked too.
  "start-$APP_LEGACY_SLUG-dev-build.sh"
  "start-$APP_LEGACY_SLUG-dev-sandbox.sh"
  "start-$APP_LEGACY_SLUG-tauri-hotreload.sh"
  "screenshots/$APP_LEGACY_SLUG-current.png"

  # --- Flip points: tooling that cannot source the brand helper. Phase 3. ---
  # Git hooks: run in any state of the tree, so they stay self-contained. The
  # plan renames their environment variables at the flip.
  '.githooks/*'
  # CI: artifact names, the dmg rename and release-note text. Phase 3; the
  # repository URL in it moves in phase 4.
  '.github/*'
  # The sandbox image's build context: runs inside `docker build`, away from
  # the repo. Phase 3.
  'docker/*'
  # Ignore lists name the app's folders literally. Phase 3.
  '.gitignore'
  'eslint.config.js'
  # The shims the app copies into agent homes (`include_bytes!`, so they run
  # with no repo around them), and the Windows dev launcher. Phase 3 renames
  # them and ships the old send name as a logging alias (phase 2 builds it).
  "scripts/$APP_LEGACY_SLUG-send.sh"
  "scripts/$APP_LEGACY_SLUG-send.ps1"
  "scripts/$APP_LEGACY_SLUG-send.cmd"
  "scripts/$APP_LEGACY_SLUG-dev.cmd"
  # Standalone scripts that still spell the name, the state dir or a persisted
  # key themselves. Phase 2 for the lookups (state dir and the phone-host
  # settings key need the old-name fallback there), phase 3 for the text.
  'scripts/install_phone.sh'
  'scripts/install_phone.ps1'
  'scripts/take-screenshot.sh'
  'scripts/copilot-probe.py'
  'scripts/parse-qa.mjs'
  'scripts/release-signing-keygen.sh'
  # Finds the app's own block in Cargo.lock by package name. Phase 3.
  'scripts/bump-version.sh'
  # The privacy scan's own per-user config dir and a fixture address. Phase 3.
  'scripts/privacy-check.sh'

  # --- The rename's own tooling. Removed when the rename is finished. --------
  # The codemods search for the name by design.
  'scripts/rename-codemods/*'
)

# ---------------------------------------------------------------------------

list=0
case "${1:-}" in
  --list) list=1 ;;
  '') ;;
  *) echo "usage: brand-check.sh [--list]" >&2; exit 2 ;;
esac

# The words to look for, lowercase, as one ERE alternation.
needle="$APP_LEGACY_SLUG"
if [ "$APP_SLUG" != "$APP_LEGACY_SLUG" ]; then
  needle="$APP_LEGACY_SLUG|$APP_SLUG"
fi

# Index of the ALLOW entry covering a path, or nothing.
allow_index() {
  local i
  for i in "${!ALLOW[@]}"; do
    # shellcheck disable=SC2254  # the entry IS a pattern
    case "$1" in ${ALLOW[$i]}) printf '%s\n' "$i"; return 0 ;; esac
  done
  return 1
}

declare -a covered=()
for i in "${!ALLOW[@]}"; do covered[i]=0; done
declare -a scan=()
bad=0

# Paths that carry the name.
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if i="$(allow_index "$path")"; then
    covered[i]=$((covered[i] + 1))
  else
    printf '%s: the path itself names the app\n' "$path"
    bad=$((bad + 1))
  fi
done < <(git ls-files | grep -iE -- "$needle" || true)

# Text files whose content carries it (-I: binaries are not text to read).
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if i="$(allow_index "$path")"; then
    covered[i]=$((covered[i] + 1))
  else
    scan+=("$path")
  fi
done < <(git grep -I -i -l -E -e "$needle" || true)

if [ "${#scan[@]}" -gt 0 ]; then
  # One pass over the remaining files: drop what is a comment in that file's
  # language, honour the allow marker, report what is left.
  #
  # The comment rules are deliberately narrow, so that they err towards
  # reporting: `//` and `#` open a comment only at the start of a line or
  # after whitespace (not the `//` of a URL in a string, not `$#`), and `/*`
  # only there or after `{` / `(` (not the `/*` of a glob like `**/*.ts`).
  hits="$(awk -v needle="$needle" -v prose="$COMMENTS_ARE_PROSE" '
    function style_of(name,   base, ext) {
      base = name; sub(/^.*\//, "", base)
      if (base !~ /\./ || base ~ /^\.[^.]*$/ || base == "Dockerfile") return "hash"
      ext = base; sub(/^.*\./, "", ext)
      if (ext ~ /^(rs|ts|tsx|js|jsx|mjs|cjs|css)$/) return "c"
      if (ext ~ /^(sh|bash|py|yml|yaml|toml|ps1|conf|desktop)$/) return "hash"
      if (ext ~ /^(html|htm|xml|plist)$/) return "xml"
      if (ext ~ /^(cmd|bat)$/) return "cmd"
      return "none"
    }
    # Remove the comments of a C-like line; `inblock` carries a `/* … */`
    # across lines.
    function strip_c(s,   out, lc, bc, end) {
      out = ""
      while (1) {
        if (inblock) {
          end = index(s, "*/")
          if (!end) return out
          s = substr(s, end + 2); inblock = 0
          continue
        }
        lc = match(s, /(^|[ \t])\/\//) ? RSTART : 0
        bc = match(s, /(^|[ \t{(])\/\*/) ? RSTART : 0
        if (!lc && !bc) return out s
        if (lc && (!bc || lc <= bc)) return out substr(s, 1, lc - 1)
        out = out substr(s, 1, bc)
        s = substr(s, bc + 1)
        sub(/^[^\/]*\/\*/, "", s)
        inblock = 1
      }
    }
    function strip_xml(s,   out, start, end) {
      out = ""
      while (1) {
        if (inblock) {
          end = index(s, "-->")
          if (!end) return out
          s = substr(s, end + 3); inblock = 0
          continue
        }
        start = index(s, "<!--")
        if (!start) return out s
        out = out substr(s, 1, start - 1)
        s = substr(s, start + 4); inblock = 1
      }
    }
    function strip(s) {
      if (!prose) return s
      if (style == "c") return strip_c(s)
      if (style == "xml") return strip_xml(s)
      if (style == "hash") { if (match(s, /(^|[ \t])#/)) return substr(s, 1, RSTART - 1); return s }
      if (style == "cmd") { if (s ~ /^[ \t]*(@?[Rr][Ee][Mm]([ \t]|$)|::)/) return ""; return s }
      return s
    }
    FNR == 1 { inblock = 0; marked = 0; style = style_of(FILENAME) }
    {
      mark = index($0, "brand-check: allow") > 0
      code = strip($0)
      if (!mark && !marked && tolower(code) ~ needle) printf "%s:%d: %s\n", FILENAME, FNR, $0
      marked = mark
    }
  ' "${scan[@]}")"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    bad=$((bad + $(printf '%s\n' "$hits" | wc -l)))
  fi
fi

if [ "$list" = 1 ]; then
  echo
  echo "Allowlist coverage (paths and files with a hit, per entry):"
  for i in "${!ALLOW[@]}"; do
    if [ "${covered[i]}" -eq 0 ]; then
      printf '  %5s  %s   <- covers nothing; delete the entry\n' 0 "${ALLOW[$i]}"
    else
      printf '  %5d  %s\n' "${covered[i]}" "${ALLOW[$i]}"
    fi
  done
fi

if [ "$bad" -gt 0 ]; then
  cat >&2 <<MSG

brand-check: $bad place(s) spell the app's name outside the brand modules.
  Rust: use a constant or macro from src-tauri/src/brand.rs (crate::brand::…).
  TypeScript: use BRAND / NAMES / storageKey(…) from src/lib/brand.ts.
  Shell: source scripts/lib/brand.sh and use \$APP_DISPLAY, \$APP_SLUG, ….
  Where no constant can reach (a serde key, an include path), put
  "brand-check: allow — <why>" on the line or the line above it.
MSG
  exit 1
fi
echo "brand-check: the app's name is spelled only in the brand modules and the allowlist (${#ALLOW[@]} entries)."
