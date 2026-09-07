#!/usr/bin/env bash
# Move the frozen "Eldrun (dev)" snapshot to the commit that was just made.
#
# `npm run package:dev` freezes the CURRENT WORKING TREE as a release binary
# (AGENTS.md "Running"), and the frozen window is where the day's real work
# happens — so it is only ever as good as the last time somebody remembered to
# re-run it. A commit is the honest moment to move it: it is the point where a
# change is finished, it is frequent, and it is local (never CI).
#
# Three properties make that safe to do automatically:
#
# * **It never delays the commit.** `--queue` returns at once and the build
#   runs detached, surviving the terminal that committed.
# * **It never stacks.** A second commit while a build is running leaves a
#   pending marker instead of a second build; the running one loops once more
#   when it finishes, so ten commits (or a rebase) cost one or two builds and
#   the binary ends up matching the LAST tree, not an intermediate one.
# * **It never wins a fight for the machine.** The build is nice'd, ionice'd
#   and put on SCHED_IDLE where available — the same posture heavy local jobs
#   take in this project, because a 3-4 minute release build at full tilt is
#   felt in every keystroke of the window it exists to serve.
#
# It builds and installs; it NEVER launches or stops Eldrun (user, 2026-07-29).
# A running frozen instance keeps its old inode and picks the new snapshot up
# on its next launch, which is what the completion notification says.
#
# Off switch, in order of scope:
#   git config eldrun.autoDevBuild false   # this clone, permanently
#   ELDRUN_NO_AUTO_DEV_BUILD=1 git commit  # one commit
# Log: ~/.local/share/eldrun/package-dev-auto.log (the last build's output).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/package-dev-auto.sh"
# Beside the binary package-dev.sh installs, and for the same reason it hardcodes
# that path: what is frozen here is per-user, not per-state-dir, so a sandbox
# session's ELDRUN_STATE_DIR must not send these somewhere else.
APP_DIR="$HOME/.local/share/eldrun"
BINARY="$APP_DIR/eldrun-dev"
LOCK_DIR="$APP_DIR/package-dev-auto.lock"
PENDING="$APP_DIR/package-dev-auto.pending"
STAMP="$APP_DIR/package-dev-auto.stamp"
LOG="$APP_DIR/package-dev-auto.log"
LOG_MAX_BYTES=$((4 * 1024 * 1024))

note() { printf '%s %s\n' "$(date -Is)" "$*"; }

notify() { # urgency, title, body
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send -u "$1" -a Eldrun "$2" "$3" 2>/dev/null || true
}

# Every reason not to touch the frozen build, cheapest first.
declined() {
  [ "${ELDRUN_NO_AUTO_DEV_BUILD:-}" = "1" ] && { echo "disabled for this commit"; return 0; }
  [ -n "${CI:-}" ] && { echo "running in CI"; return 0; }
  case "$(git -C "$ROOT" config --bool --get eldrun.autoDevBuild 2>/dev/null)" in
    false) echo "disabled by git config eldrun.autoDevBuild"; return 0 ;;
  esac
  # A linked worktree is somebody else's tree — an agent's, usually. Freezing
  # THAT over the user's dev binary is exactly the surprise this must not be.
  local git_dir common_dir
  git_dir="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || { echo "not a git checkout"; return 0; }
  # `--git-common-dir` answers relative to the repo, not to whatever cwd a hook
  # happened to inherit.
  common_dir="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" && pwd)" || common_dir=""
  [ "$git_dir" != "$common_dir" ] && { echo "a linked worktree, not the main checkout"; return 0; }
  [ -x "$ROOT/scripts/package-dev.sh" ] || { echo "scripts/package-dev.sh is not executable"; return 0; }
  return 1
}

# What the frozen build would be built FROM: the commit plus the dirty tree
# around it, since package-dev.sh freezes the working tree rather than HEAD.
tree_signature() {
  {
    git -C "$ROOT" rev-parse HEAD 2>/dev/null
    git -C "$ROOT" status --porcelain --untracked-files=all 2>/dev/null
  } | sha1sum | cut -d' ' -f1
}

queue() {
  if declined >/dev/null; then
    return 0
  fi
  mkdir -p "$APP_DIR" || return 0
  : >"$PENDING"
  # Detached from the committing shell: `git commit` returns now, and closing
  # the terminal (or the editor that ran it) does not take the build with it.
  setsid nohup "$SELF" --run </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  printf 'Eldrun (dev): rebuilding the frozen snapshot in the background (%s)\n' "$LOG"
}

# One build attempt. Prints into the (already redirected) log; returns the
# build's own status.
build_once() {
  local signature
  signature="$(tree_signature)"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$signature" ] && [ -x "$BINARY" ]; then
    note "tree unchanged since the installed snapshot ($signature) — nothing to build"
    return 0
  fi
  note "building $ROOT @ $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
  local -a low=()
  command -v chrt >/dev/null 2>&1 && low+=(chrt --idle 0)
  command -v ionice >/dev/null 2>&1 && low+=(ionice -c 3)
  low+=(nice -n 19)
  # A hook inherits whatever environment the committing shell had, and a GUI
  # git client's has no ~/.cargo/bin at all.
  PATH="$HOME/.cargo/bin:$PATH" "${low[@]}" npm --prefix "$ROOT" run package:dev
  local status=$?
  if [ "$status" -eq 0 ]; then
    # Stamped from the tree as it was BEFORE the build, so an edit made while
    # the build ran is not mistaken for something already frozen.
    printf '%s\n' "$signature" >"$STAMP"
  fi
  return "$status"
}

run() {
  mkdir -p "$APP_DIR" || return 0
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # Held — by a live build, whose loop will pick our marker up, or by a
    # crashed one whose lock nobody removed.
    local holder
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo 0)"
    if [ "$holder" -gt 0 ] 2>/dev/null && kill -0 "$holder" 2>/dev/null; then
      return 0
    fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || return 0
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR"' EXIT

  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
  fi
  exec >>"$LOG" 2>&1
  printf '\n=== PACKAGE:DEV (auto) %s ===\n' "$(date -Is)"

  local status=0 passes=0
  while [ -f "$PENDING" ]; do
    # Cleared BEFORE the build: a commit landing mid-build re-creates it and
    # earns the next pass, rather than being swallowed by this one.
    rm -f "$PENDING"
    passes=$((passes + 1))
    build_once
    status=$?
    note "pass $passes finished with status $status"
    [ "$status" -eq 0 ] || break
  done

  local version commit
  version="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?')"
  commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [ "$status" -eq 0 ]; then
    notify low 'Eldrun (dev) rebuilt' "$version @ $commit — relaunch Eldrun (dev) to pick it up."
  else
    notify critical 'Eldrun (dev) build failed' "$version @ $commit — see $LOG"
  fi
  return "$status"
}

case "${1:---queue}" in
  --queue) queue ;;
  --run) run ;;
  --status)
    if [ -d "$LOCK_DIR" ]; then echo "building (pid $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'))"; else echo "idle"; fi
    [ -f "$PENDING" ] && echo "a rebuild is queued"
    [ -f "$STAMP" ] && echo "installed snapshot signature: $(cat "$STAMP")"
    if reason="$(declined)"; then echo "auto-build declined: $reason"; else echo "auto-build enabled"; fi
    ;;
  *) echo "usage: $(basename "$0") [--queue|--run|--status]" >&2; exit 2 ;;
esac
exit 0
