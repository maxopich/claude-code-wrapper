#!/usr/bin/env bash
# bus-status.sh — debug snapshot of bus state.
#
# Prints:
#   - inbox depth per agent
#   - last N events from bus.log
#
# Useful when an agent or the operator wants to inspect "is anything pending?"
# without consuming messages.
#
# Usage:
#   bus-status.sh [--tail <n>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Per-session bus root if Cebab passed $BUS_SESSION_ROOT, else legacy
# ~/.cebab/bus/ via script-parent fallback.
BUS_ROOT="${BUS_SESSION_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

tail_n=10
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tail) tail_n="$2"; shift 2 ;;
    --tail=*) tail_n="${1#--tail=}"; shift ;;
    *) echo "bus-status: unknown arg: $1" >&2; exit 1 ;;
  esac
done

printf 'bus root: %s\n\n' "$BUS_ROOT"

# Inbox depths.
printf 'Inboxes:\n'
inboxes_dir="$BUS_ROOT/inboxes"
if [[ -d "$inboxes_dir" ]]; then
  shopt -s nullglob
  any=0
  for d in "$inboxes_dir"/*/; do
    any=1
    name="$(basename "$d")"
    n=$(find "$d" -maxdepth 1 -name '*.msg' -type f 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-20s %s pending\n' "$name" "$n"
  done
  shopt -u nullglob
  if [[ $any -eq 0 ]]; then printf '  (no agents registered)\n'; fi
else
  printf '  (no inboxes directory yet)\n'
fi

printf '\nLast %s event(s) from bus.log:\n' "$tail_n"
log="$BUS_ROOT/bus.log"
if [[ -f "$log" ]]; then
  tail -n "$tail_n" "$log"
else
  printf '  (no bus.log yet)\n'
fi
