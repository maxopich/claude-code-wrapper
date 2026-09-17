/**
 * Interactive AskUserQuestion: the park-and-resolve registry, shared by BOTH
 * run paths.
 *
 * When an agent calls `AskUserQuestion`, the `canUseTool` gate blocks the
 * in-flight SDK turn on a Promise parked here (keyed by sessionId → toolUseId).
 * The operator answers — `multi_agent_ask_user_answer` from the bus tab,
 * `ask_user_answer` from single-agent chat — and the WS layer calls
 * `resolveQuestion`, which resolves that Promise with the answer string. The
 * caller then returns `{behavior:'deny', message}` to the SDK, which delivers
 * the answer to the model as the tool result and the same turn resumes — no
 * `--resume`, no orphaned tool_use.
 *
 * `Cebab-uhn2` gave it the second caller. Nothing here was bus-specific — the
 * registry is keyed by session id and the bus's own `agent` field is carried by
 * the CALLER, not stored here — so single-agent reuses it unchanged rather than
 * growing a second copy that could drift. The one asymmetry is lifetime, and it
 * is the callers' to enforce: a bus question survives a browser re-attach (R-A)
 * because the run does, while a single-agent question is drained on disconnect
 * because that turn is aborted with the socket.
 *
 * Why a process-level module (not the `Conn`): a parked question must survive
 * a browser re-attach (R-A) — the live run keeps going while the browser is
 * gone, so the Promise can't live on the WS connection. It does NOT survive a
 * Cebab server restart (R-B): the Promise dies with the process and the
 * reconstructed session comes back `awaiting_continue`; the agent re-asks if
 * it still needs to. This mirrors the in-process `session_registry` lifetime.
 */
import type { AskUserQuestionOption, AskUserQuestionView } from '@cebab/shared/protocol';

type ParkedQuestion = {
  agent: string;
  toolUseId: string;
  questions: AskUserQuestionView[];
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};

/** sessionId → (toolUseId → parked question). */
const parked = new Map<string, Map<string, ParkedQuestion>>();

export type ParkedQuestionView = {
  agent: string;
  toolUseId: string;
  questions: AskUserQuestionView[];
};

/**
 * Park a question and return a Promise that resolves with the operator's
 * answer (or rejects when drained on stop/interrupt). The runner awaits this
 * inside `canUseTool`, which blocks the SDK turn until it settles.
 */
export function parkQuestion(sessionId: string, q: ParkedQuestionView): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let perSession = parked.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      parked.set(sessionId, perSession);
    }
    perSession.set(q.toolUseId, {
      agent: q.agent,
      toolUseId: q.toolUseId,
      questions: q.questions,
      resolve,
      reject,
    });
  });
}

/**
 * Resolve a parked question with the operator's answer. Returns false if no
 * matching parked question exists (already answered, drained, or unknown id)
 * — the WS handler uses that to decide whether to echo `_resolved`.
 */
export function resolveQuestion(sessionId: string, toolUseId: string, answer: string): boolean {
  const perSession = parked.get(sessionId);
  const entry = perSession?.get(toolUseId);
  if (!perSession || !entry) return false;
  perSession.delete(toolUseId);
  if (perSession.size === 0) parked.delete(sessionId);
  entry.resolve(answer);
  return true;
}

/**
 * Reject + drop every parked question for a session. Called from the same
 * teardown sites as `cleanupPendingPermissionsForSession` (interrupt / stop /
 * end) so a parked `canUseTool` doesn't dangle after the run is gone. The
 * runner's catch turns the rejection into a deny, which is harmless on a turn
 * that's already being torn down.
 */
export function rejectQuestionsForSession(sessionId: string, reason: string): void {
  const perSession = parked.get(sessionId);
  if (!perSession) return;
  parked.delete(sessionId);
  for (const entry of perSession.values()) {
    try {
      entry.reject(new Error(reason));
    } catch {
      /* a settled Promise can't re-settle; ignore */
    }
  }
}

/**
 * Snapshot the parked questions for a session (no side effects). Used by the
 * WS attach path to re-emit a pending card after a browser refresh (R-A).
 */
export function listParkedQuestions(sessionId: string): ParkedQuestionView[] {
  const perSession = parked.get(sessionId);
  if (!perSession) return [];
  return [...perSession.values()].map((e) => ({
    agent: e.agent,
    toolUseId: e.toolUseId,
    questions: e.questions,
  }));
}

/** Test-only: wipe all parked state so cases don't leak across each other. */
export function __clearAllParkedQuestions(): void {
  parked.clear();
}

/**
 * Format the operator's per-question answers into the single string the model
 * receives as the AskUserQuestion tool result (and that we persist to the
 * scrollback). Keys are the question texts; values are the chosen labels
 * (multi-select pre-joined by the client) or the free-text "Other".
 */
export function formatAskUserAnswer(answers: Record<string, string>): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return 'The user submitted no answer.';
  const lines = entries.map(([question, answer]) => `• ${question}\n  → ${answer}`);
  return `The user answered:\n${lines.join('\n')}`;
}

/**
 * Flatten an `AskUserQuestion` tool input into the wire/card shape.
 *
 * Lives here rather than in `bus/runner.ts`, where it was written, because it
 * is the input half of THIS registry and `Cebab-uhn2` gave it a second caller:
 * the single-agent gate in `ws/server.ts`. Importing the 2000-line bus runner
 * into the single-agent turn path to reach one pure function would have been a
 * real dependency for a cosmetic reason.
 *
 * TOTAL rather than throwing, and that is the security-relevant part: every
 * field here is MODEL-authored, so a malformed or hostile shape must degrade to
 * a smaller valid structure instead of killing the turn. An option with no
 * usable `label` is dropped (the label is what the operator clicks and what is
 * fed back as the answer, so a blank one is an unanswerable button), and a
 * non-array `questions` yields `[]` — which the caller reads as "nothing to
 * ask" and refuses, rather than parking the turn on an empty card nobody can
 * dismiss.
 */
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionView[] {
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  const out: AskUserQuestionView[] = [];
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === 'string' ? o.question : '';
    const header = typeof o.header === 'string' ? o.header : '';
    const multiSelect = o.multiSelect === true;
    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(o.options)) {
      for (const op of o.options) {
        if (!op || typeof op !== 'object') continue;
        const oo = op as Record<string, unknown>;
        const label = typeof oo.label === 'string' ? oo.label : '';
        if (!label) continue;
        const description = typeof oo.description === 'string' ? oo.description : undefined;
        options.push(description !== undefined ? { label, description } : { label });
      }
    }
    out.push({ question, header, options, multiSelect });
  }
  return out;
}

/** The tool whose calls are ANSWERED rather than approved. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * `Cebab-uhn2`. Both texts reach the MODEL as a `canUseTool` deny message, so
 * each has to say enough for the model to choose a sensible next move without
 * being told what that move is.
 *
 * They are deliberately different. "Dismissed" is a live operator signal — the
 * turn was interrupted, the socket closed, or the browser went away — and
 * re-asking the same question would be the wrong reflex, so the text points at
 * plain chat instead. "Malformed" is the model's own input being unusable, and
 * re-asking IS the right move there, so that one says so.
 */
export const ASK_USER_DISMISSED_TEXT =
  'The question was dismissed without an answer (the operator interrupted the ' +
  'turn, or their browser disconnected). Do not re-send the same question — ' +
  'continue in plain text, or ask again in your reply.';

export const ASK_USER_MALFORMED_TEXT =
  'That AskUserQuestion call carried no usable questions, so nothing could be ' +
  'shown to the operator. Re-send it with a non-empty `questions` array where ' +
  'every option has a label, or just ask in plain text.';
