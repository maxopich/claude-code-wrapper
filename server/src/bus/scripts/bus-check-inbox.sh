#!/usr/bin/env bash
# bus-check-inbox.sh — drain an agent's inbox.
#
# Designed to run as Claude Code's Stop hook so the agent automatically
# processes pending messages at the end of every turn. Two output modes:
#
#   - When called by a Stop hook (no terminal stdin), we emit a Stop-hook
#     JSON response telling Claude to block-and-continue with the new
#     messages as the next instruction. Format:
#       {"decision": "block", "reason": "<formatted messages>"}
#     See: https://docs.claude.com/en/docs/claude-code/hooks
#
#   - When called interactively (terminal stdin), we print the messages to
#     stdout in human-readable form. Useful for debugging.
#
# Either way: each consumed message file is moved from inboxes/<self>/
# into archive/<self>/ so the same message is never replayed.
#
# Usage:
#   bus-check-inbox.sh <self>
#
# `<self>` is the agent's slug. If empty inbox, exits 0 silently.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Per-session bus root if Cebab passed $BUS_SESSION_ROOT (post-007), else
# fall back to the script's parent dir (= ~/.cebab/bus/ for legacy use).
BUS_ROOT="${BUS_SESSION_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

die() { echo "bus-check-inbox: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: bus-check-inbox.sh <self>"
self="$1"

inbox="$BUS_ROOT/inboxes/$self"
archive="$BUS_ROOT/archive/$self"
mkdir -p "$archive"

# Nothing to do if inbox is missing or empty (idempotent on repeat invocation).
if [[ ! -d "$inbox" ]]; then exit 0; fi

# Collect .msg files in deterministic order. Ignore tmp staging files.
shopt -s nullglob
msgs=("$inbox"/*.msg)
shopt -u nullglob
if [[ ${#msgs[@]} -eq 0 ]]; then exit 0; fi

# Sort by filename — our filenames are <ts>-<from>-<rand>.msg, so lex sort
# gives chronological order.
IFS=$'\n' msgs=($(printf '%s\n' "${msgs[@]}" | sort))
unset IFS

# Build the human-formatted block + record what we consumed.
formatted=""
count=0
for msg_path in "${msgs[@]}"; do
  filename="$(basename "$msg_path")"
  # Parse <ts>-<from>-<rand>.msg
  ts_part="${filename%%-*}"
  rest="${filename#*-}"
  from_part="${rest%-*}"

  body="$(cat "$msg_path")"
  formatted+="--- from ${from_part} ---"$'\n'
  formatted+="${body}"$'\n\n'

  # Move to archive (don't delete — useful for debugging replays).
  mv "$msg_path" "$archive/$filename"
  count=$((count + 1))
done

# Strip trailing blank line.
formatted="${formatted%$'\n'}"

# Detect whether we're invoked as a hook (no terminal on stdin) vs interactively.
# Stop hooks pass JSON on stdin; if stdin is a TTY we're being called by a human.
if [[ -t 0 ]]; then
  # Interactive: human-readable output.
  printf '%s new message(s) for %s:\n\n' "$count" "$self"
  printf '%s\n' "$formatted"
  exit 0
fi

# Drain whatever JSON the Stop hook sent us (we don't need to parse it for v1,
# but reading prevents a SIGPIPE if the hook framework writes more than we
# would otherwise consume). Discard to /dev/null.
cat >/dev/null 2>&1 || true

# Stop-hook response: tell Claude to continue with these messages as the next
# instruction. The text becomes the agent's new prompt.
prompt_text="You have ${count} new message(s) in your bus inbox:

${formatted}

Process these messages. To reply, run:
  bus-send-msg.sh <recipient> <text>
or pipe a longer reply via stdin:
  echo \"<long reply>\" | bus-send-msg.sh <recipient>"

node -e '
const o = {
  decision: "block",
  reason: process.argv[1],
};
process.stdout.write(JSON.stringify(o));
' -- "$prompt_text"
