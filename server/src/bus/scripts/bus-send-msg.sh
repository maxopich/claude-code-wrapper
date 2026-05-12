#!/usr/bin/env bash
# bus-send-msg.sh — send a message to another bus agent.
#
# Usage:
#   bus-send-msg.sh [--kind <kind>] <recipient> [<text>]
#
# If <text> is omitted, stdin is read. <kind> defaults to "reply".
# Recipient is a bus agent slug (e.g. "reviewer"), or the literal "user"
# (orchestrator-only — Cebab intercepts these and forwards to the browser).
#
# Sender is taken from the BUS_AGENT_NAME env var, which Cebab sets when it
# launches each agent's TUI from tmux. Running this script without
# BUS_AGENT_NAME is an error — we don't guess who's writing.
#
# Side effects:
#   1. Writes a .msg file into $BUS_ROOT/inboxes/<recipient>/
#   2. Appends a single JSONL event to $BUS_ROOT/bus.log
#
# $BUS_ROOT resolves like this:
#   * If $BUS_SESSION_ROOT is set, use that. Cebab passes this env var to
#     each tmux window when starting a multi-agent session (post-007), so
#     traffic lands in the per-session folder under the operator's
#     workspace.
#   * Otherwise, fall back to the script's parent dir (i.e. ~/.cebab/bus/).
#     This keeps things working for pre-007 sessions, for operators
#     running the script manually in a shell, and for any agent that
#     somehow lost the BUS_SESSION_ROOT env propagation.
#
# No external deps beyond `node` (already required by Cebab) and POSIX
# coreutils. Uses node strictly for safe JSON construction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUS_ROOT="${BUS_SESSION_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

die() { echo "bus-send-msg: $*" >&2; exit 1; }

# Parse args.
kind="reply"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      [[ $# -ge 2 ]] || die "--kind requires a value"
      kind="$2"; shift 2 ;;
    --kind=*)
      kind="${1#--kind=}"; shift ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *) break ;;
  esac
done

[[ $# -ge 1 ]] || die "usage: bus-send-msg.sh [--kind <kind>] <recipient> [<text>]"
recipient="$1"; shift

# Body: positional arg if present, else stdin.
if [[ $# -ge 1 ]]; then
  body="$1"
else
  body="$(cat)"
fi

# Sender from env.
sender="${BUS_AGENT_NAME:-}"
[[ -n "$sender" ]] || die "BUS_AGENT_NAME is unset — run this inside an agent's TUI (Cebab launches with it set)"

# Validate kind against the enum used in DB + bus.log.
case "$kind" in
  intro|prompt|reply|final|error) ;;
  *) die "invalid --kind: $kind (must be intro|prompt|reply|final|error)" ;;
esac

# Ensure target dirs exist.
inbox="$BUS_ROOT/inboxes/$recipient"
mkdir -p "$inbox"

# Filename: <ts-ms>-<from>-<rand>.msg — ts prefix sorts lexicographically by time,
# from-tag aids debugging, random suffix avoids collisions on burst.
ts_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
rand="$(node -e 'process.stdout.write(require("crypto").randomBytes(3).toString("hex"))')"
filename="${ts_ms}-${sender}-${rand}.msg"

# Atomic write: stage to tmp, rename in place. Avoids the consumer seeing
# half-written content via fs.watch.
tmp="$inbox/.tmp.$$.$rand"
printf '%s' "$body" > "$tmp"
mv "$tmp" "$inbox/$filename"

# Append a JSONL event to bus.log. Cebab tails this file and forwards events
# to the browser as multi_agent_event WS messages.
event="$(node -e '
const o = {
  ts: Number(process.argv[1]),
  source: process.argv[2],
  destination: process.argv[3],
  kind: process.argv[4],
  text: process.argv[5],
};
process.stdout.write(JSON.stringify(o));
' -- "$ts_ms" "$sender" "$recipient" "$kind" "$body")"
printf '%s\n' "$event" >> "$BUS_ROOT/bus.log"
