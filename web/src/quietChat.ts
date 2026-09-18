/**
 * `Cebab-ibb4`: the quiet chat — what a finished turn looks like once the work
 * it took is no longer the point.
 *
 * THE PROBLEM IS NOT VOLUME, IT IS RANK. A turn's tool calls and their output
 * are rendered at the same weight as the answer, in the same column, forever.
 * Twenty of them and the answer is a thin band at the bottom of a page of shell
 * output — so the operator scrolls past their own agent's reasoning to find the
 * one paragraph they asked for. The trace is not worthless; it is just not the
 * thing being read, and it is already kept twice over (the `events` table and
 * the per-session JSONL, both reachable from the chat header's own Logs
 * button). Nothing here deletes anything.
 *
 * TWO RULES DO ALL THE WORK, and the second is the one to protect.
 *
 * 1. A turn collapses to its ANSWER. Everything between the prompt and the
 *    answer is counted, not shown, and one click puts the whole turn back
 *    exactly as it renders today.
 *
 * 2. FOUR CLASSES ARE NEVER HIDDEN, because hiding them strands the run rather
 *    than tidying it: a permission card and a parked question are gates the
 *    turn is waiting on, and an error or a non-success result is the reason
 *    there is no answer to collapse to. `error_max_turns` is the sharpest of
 *    them — its card carries the Extend buttons that resume the work, so
 *    hiding it would silently remove the only control that finishes the task.
 *
 * The pin rule is a mapped type over `MessageView['kind']` rather than a
 * predicate with a `switch`, so a new message kind does not compile until
 * someone has decided which side of it the kind falls on. That is deliberate:
 * every class in rule 2 is one an operator is BLOCKED on, and the failure mode
 * of a hand-kept list is that the fifth one is added somewhere else and is
 * quietly invisible here — which reads, from the operator's chair, as a run
 * that hung.
 */
import type { MessageView } from './store';
import { readStored, writeStored } from './prefs';

/** One prompt and everything the agent did about it, in arrival order. */
export type ChatTurn = {
  /** The id of the message that opened the turn — stable across re-renders,
   *  and unique because it is a message id. */
  id: string;
  /** Every message of the turn, unfiltered. The expanded view renders exactly
   *  this, which is what makes "show the steps" mean today's transcript rather
   *  than a second, subtly different rendering of it. */
  messages: MessageView[];
  /** The message whose text the quiet view shows as the answer, or null when
   *  the turn produced none (it is still running, or it died first). */
  answerId: string | null;
  /** How many messages the quiet view leaves out — the number on the toggle.
   *  Counts only messages that would actually RENDER something, so the figure
   *  is a promise about what expanding will show. */
  hiddenCount: number;
};

/**
 * Does `MessageBlock` put anything on screen for this message?
 *
 * `system` messages are mostly bookkeeping — the per-turn `init` banner and the
 * `system_event` summaries render as nothing at all, and there are a lot of
 * them (one `init` per turn, plus every `thinking_tokens` /
 * `task_started` / `task_notification` row the SDK emits). Counting those as
 * hidden "steps" would make the toggle promise output it cannot produce.
 *
 * `MessageBlock` imports this rather than keeping its own early return, so the
 * count and the render cannot disagree. A second copy of this rule would be
 * invisible when wrong in exactly one direction: the toggle would offer to
 * reveal rows that expand into blank space.
 */
export function rendersAnything(m: MessageView): boolean {
  return m.kind === 'system' ? m.subtype === 'tool_result' : true;
}

type PinRule<K extends MessageView['kind']> = (m: Extract<MessageView, { kind: K }>) => boolean;

/**
 * Which classes survive the collapse. Exhaustive by construction — see the
 * header for why this is a mapped type and not a `switch`.
 */
const PINNED: { [K in MessageView['kind']]: PinRule<K> } = {
  // The prompt. Rendered by the turn itself, and pinned here too so the rule
  // reads completely rather than relying on the caller to remember.
  user: () => true,

  // The steps, and the answer among them — which the turn identifies by id
  // rather than by kind, since "the last assistant message with text" is not a
  // property any single message has.
  assistant: () => false,

  // Tool output, and the bookkeeping rows that render as nothing. This is the
  // bulk of what the quiet view exists to put away.
  system: () => false,

  // A slash command's output IS the answer to the operator's own `/…` — there
  // is no model turn behind it and nothing else in the turn to collapse to.
  command_output: () => true,

  // A successful result is a metadata footer (subtype · cost · duration), and
  // the turn counter in the chat header already carries the part that matters.
  // Every other subtype is a card explaining why the work stopped, and
  // `error_max_turns` carries the Extend buttons that resume it.
  result: (m) => m.subtype !== 'success',

  // The turn died. This is the answer.
  error: () => true,

  // The turn is parked on the operator. Hiding either of these hangs the run.
  permission_request: () => true,
  ask_user_question: () => true,
};

export function isPinnedInQuietView(m: MessageView): boolean {
  return (PINNED[m.kind] as (x: MessageView) => boolean)(m);
}

function isInit(m: MessageView): boolean {
  return m.kind === 'system' && m.subtype === 'init';
}

/**
 * Does this message begin a new turn, given what the current one holds?
 *
 * MEASURED AGAINST A REAL SESSION, because the obvious rule is wrong. A turn
 * on the wire is not `user` then `init`:
 *
 *     user (the operator's prompt)      ← live: appended optimistically
 *     system/hook_started               ← renders nothing
 *     system/hook_response              ← renders nothing
 *     system/init                       ← the SDK's per-turn banner
 *     system/status                     ← dropped by the reducer
 *     assistant … / tool output …
 *     result
 *     system/task_summary               ← AFTER the result, renders nothing
 *
 * A first version of this split when the current turn was not exactly one
 * message, and the two hook rows put every follow-up turn's prompt in a turn of
 * its own, with its answer in the next one. Nothing in the unit tests saw it:
 * the shape it needed was two invisible rows, which is not a shape anyone
 * writes a fixture for. A live session in the Playground found it in one
 * follow-up message.
 *
 * So the rule is about CONTENT, not position: an opener splits only once the
 * current turn has produced something the operator can see. Everything before
 * that — the prompt, the hook rows, the init, any bookkeeping — is this turn's
 * opening matter however much of it there is.
 *
 * There are TWO openers because a session can arrive with either as the first
 * thing it has. `init` is a reliable per-TURN marker (each turn is its own
 * `query()`, so the SDK re-emits it on every `--resume`), and it is the ONLY
 * marker a session replayed from before `Cebab-ibb4` has: no `ServerMsg`
 * produced a `user` message until the persisted prompt started arriving as one.
 */
function opensTurn(m: MessageView, current: readonly MessageView[]): boolean {
  if (current.length === 0) return false;
  // Anything rendered that is not the prompt itself: the turn has begun to
  // answer, so the next opener belongs to the next turn.
  const hasOutput = current.some((x) => x.kind !== 'user' && rendersAnything(x));
  if (m.kind === 'user') return hasOutput || current.some((x) => x.kind === 'user');
  if (isInit(m)) return hasOutput;
  return false;
}

/** The turn's answer: the last assistant message carrying any text.
 *
 *  "Last with text" rather than "last", because a turn that ran out of turns
 *  ends on an assistant message that is nothing but a `tool_use` — there is no
 *  answer in it, and the last thing the agent actually SAID is one message
 *  further back. The quiet row renders only the text blocks of whichever
 *  message this picks, so a trailing `tool_use` on it is never drawn. */
function answerIdOf(messages: readonly MessageView[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'assistant') continue;
    if (m.blocks.some((b) => b.type === 'text' && b.text.trim() !== '')) return m.id;
  }
  return null;
}

export function groupTurns(messages: readonly MessageView[]): ChatTurn[] {
  const groups: MessageView[][] = [];
  for (const m of messages) {
    const current = groups[groups.length - 1];
    if (current === undefined || opensTurn(m, current)) groups.push([m]);
    else current.push(m);
  }
  return groups.map((ms) => {
    const answerId = answerIdOf(ms);
    return {
      id: ms[0].id,
      messages: ms,
      answerId,
      hiddenCount: ms.filter(
        (m) => rendersAnything(m) && !isPinnedInQuietView(m) && m.id !== answerId,
      ).length,
    };
  });
}

/**
 * The messages a collapsed turn renders, in arrival order.
 *
 * The answer comes back stripped to its TEXT blocks. An assistant message is
 * frequently `[text, tool_use]` — "let me check X" and then the call — so
 * rendering the picked message whole would put a pretty-printed JSON payload
 * inside the one row that is supposed to be the answer. Order is preserved
 * rather than hoisting the answer last: a permission card always precedes the
 * answer it gated, and reordering would claim otherwise.
 */
export function quietMessages(turn: ChatTurn): MessageView[] {
  const out: MessageView[] = [];
  for (const m of turn.messages) {
    if (m.id === turn.answerId && m.kind === 'assistant') {
      out.push({ ...m, blocks: m.blocks.filter((b) => b.type === 'text') });
    } else if (isPinnedInQuietView(m)) {
      out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The preference
// ---------------------------------------------------------------------------

/**
 * Client-only, like the theme: it changes how one pane draws and nothing about
 * what runs, so it never touches the WS `SettingsView`.
 *
 * DEFAULT ON. The operator asked for this because the transcript as it stands
 * is not what they read, and a display default that has to be found before it
 * helps is a feature nobody turns on. The cost of being wrong is one click on a
 * toggle that sits in the chat header, next to the mode pills — and the count
 * on every collapsed turn says how much is behind it, so the quiet view
 * announces what it is holding rather than looking like a shorter session.
 */
const STORAGE_KEY = 'cebab.chat.quiet';

export function readStoredQuiet(): boolean {
  return readStored<boolean>(STORAGE_KEY, true, (raw) => raw !== 'false');
}

export function writeStoredQuiet(quiet: boolean): void {
  writeStored(STORAGE_KEY, quiet ? 'true' : 'false');
}
