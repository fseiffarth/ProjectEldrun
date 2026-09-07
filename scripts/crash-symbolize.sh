#!/usr/bin/env bash
# Resolve the newest native-crash entry in crash.log to file:line.
#
# The signal handler in src-tauri/src/lib.rs writes a glibc backtrace as
# `module(+offset) [abs]` lines — no symbols, because resolving them is not
# async-signal-safe. This turns each Eldrun frame into `function at file:line`
# with addr2line against the executable named on the crash's `exe=` line (the
# offsets are only valid for that exact binary — a re-frozen dev build shifts
# them), and each system-library frame into `function` via its exported symbols.
#
#   scripts/crash-symbolize.sh                      # newest crash in the state dir's crash.log
#   scripts/crash-symbolize.sh path/to/crash.log    # a copied log
#   scripts/crash-symbolize.sh -n 2                 # the second-newest crash
set -euo pipefail

nth=1
log="${ELDRUN_STATE_DIR:-$HOME/.local/share/eldrun}/crash.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -n) nth="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) log="$1"; shift ;;
  esac
done
[ -r "$log" ] || { echo "no readable crash.log at $log" >&2; exit 1; }
command -v addr2line >/dev/null || { echo "addr2line (binutils) is not installed" >&2; exit 1; }

# The nth-newest block from a `=== CRASH: <SIG> code=` header to `=== CRASH END ===`.
block=$(awk -v want="$nth" '
  /^=== CRASH: [A-Z]+ code=/ { blk = $0 "\n"; inblk = 1; next }
  inblk { blk = blk $0 "\n" }
  /^=== CRASH END ===/ { if (inblk) { blocks[++n] = blk }; inblk = 0 }
  END { if (n >= want) printf "%s", blocks[n - want + 1] }
' "$log")
[ -n "$block" ] || { echo "no complete crash entry #$nth in $log (an older, one-line entry has no trace)" >&2; exit 1; }

exe=$(printf '%s' "$block" | sed -n 's/.* exe=\([^ ]*\) .*/\1/p' | head -1)
printf '%s\n' "$block" | sed -n '1,2p'
echo
if [ -n "$exe" ] && [ ! -r "$exe" ]; then
  echo "note: $exe is gone or unreadable; Eldrun frames stay unresolved" >&2
fi

printf '%s\n' "$block" | grep -E '^[^ ].*\(\+0x[0-9a-f]+\)' | while IFS= read -r line; do
  module=${line%%(*}
  offset=$(printf '%s' "$line" | sed -n 's/.*(+\(0x[0-9a-f]*\)).*/\1/p')
  [ -n "$offset" ] || { echo "  $line"; continue; }
  if [ -r "$module" ]; then
    resolved=$(addr2line -e "$module" -f -C -i -p "$offset" 2>/dev/null | head -3 | paste -sd '|' -)
    [ -n "$resolved" ] || resolved="?? (no symbols in $module)"
  else
    resolved="?? ($module not readable)"
  fi
  printf '  %-56s %s\n' "${module##*/}(+$offset)" "$resolved"
done
