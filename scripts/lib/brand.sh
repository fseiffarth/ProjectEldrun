# shellcheck shell=bash
# The app's names, for shell scripts. SOURCED, never run:
#
#   . "$ROOT/scripts/lib/brand.sh"
#
# No script spells the app's name itself. The name's forms are read from the
# backend's brand module (src-tauri/src/brand.rs, the one place they are
# written), and the built binary's name from src-tauri/Cargo.toml's `[[bin]]`,
# so a rename edits those two files and every script follows.
#
# Sets:
#   APP_DISPLAY       the name as shown to the user
#   APP_SLUG          lowercase form: file names, the state dir's leaf
#   APP_UPPER         uppercase form
#   APP_ENV_PREFIX    prefix of the app's environment variables
#   APP_BIN_NAME      the built main binary: target/<profile>/$APP_BIN_NAME
#   APP_DEV_BIN_NAME  the frozen dev build's installed binary
#   APP_SHARE_DIR     see app_share_dir
# Functions:
#   app_share_dir         print the per-user dir the dev tooling installs into
#   app_env NAME [DFLT]   print the app's environment variable NAME, or DFLT
#   app_export NAME VALUE export the app's environment variable NAME
#
# A name that cannot be read is an error, said out loud, and the `source`
# returns 1 — under `set -e` the caller stops there. Guessing a name instead
# would point a script at a binary or a folder that does not exist, and every
# one of these scripts fails silently when it does (a post-commit build that
# never installs, a guard that matches no process).
#
# `brand.rs` has a test (`the_shell_helper_reads_the_same_names`) that sources
# this file and holds every value to the Rust constants.

_brand_sh_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The string literal a `macro_rules! <name>` in brand.rs expands to.
_brand_sh_macro() {
  awk -v start="macro_rules! $1 {" '
    index($0, start) == 1 { found = 1; next }
    found && /^[[:space:]]*"[^"]*"[[:space:]]*$/ {
      gsub(/^[[:space:]]*"|"[[:space:]]*$/, "")
      print
      exit
    }
    found && /^}/ { exit }
  ' "$_brand_sh_root/src-tauri/src/brand.rs" 2>/dev/null
}

# `name` of the first `[[bin]]` table in src-tauri/Cargo.toml.
_brand_sh_bin_name() {
  awk '
    /^\[\[bin\]\]/ { found = 1; next }
    /^\[/ { if (found) exit }
    found && /^name[[:space:]]*=[[:space:]]*"[^"]*"/ {
      sub(/^name[[:space:]]*=[[:space:]]*"/, "")
      sub(/".*$/, "")
      print
      exit
    }
  ' "$_brand_sh_root/src-tauri/Cargo.toml" 2>/dev/null
}

APP_DISPLAY="$(_brand_sh_macro app_name)"
APP_SLUG="$(_brand_sh_macro app_slug)"
APP_UPPER="$(_brand_sh_macro app_upper)"
APP_BIN_NAME="$(_brand_sh_bin_name)"

if [ -z "$APP_DISPLAY" ] || [ -z "$APP_SLUG" ] || [ -z "$APP_UPPER" ]; then
  echo "scripts/lib/brand.sh: could not read the app's name from $_brand_sh_root/src-tauri/src/brand.rs" >&2
  return 1
fi
if [ -z "$APP_BIN_NAME" ]; then
  echo "scripts/lib/brand.sh: could not read the [[bin]] name from $_brand_sh_root/src-tauri/Cargo.toml" >&2
  return 1
fi

APP_ENV_PREFIX="${APP_UPPER}_"
APP_DEV_BIN_NAME="$APP_SLUG-dev"

# The per-user directory the dev tooling installs into and logs to:
# ~/.local/share/<slug>. On Linux that is also the default state dir, but this
# deliberately ignores the state-dir override — what is frozen or installed
# here is per user, so a sandboxed session must not send it somewhere else
# (the backend's `storage::home_share_dir()` is the same path).
app_share_dir() {
  printf '%s\n' "$HOME/.local/share/$APP_SLUG"
}
APP_SHARE_DIR="$(app_share_dir)"

# The value of the app's environment variable NAME (`<PREFIX>NAME`), or DFLT
# when it is unset or empty — `${<PREFIX>NAME:-DFLT}`.
app_env() {
  local var="${APP_ENV_PREFIX}$1"
  printf '%s' "${!var:-${2:-}}"
}

# Export the app's environment variable NAME with VALUE.
app_export() {
  export "${APP_ENV_PREFIX}$1=$2"
}
