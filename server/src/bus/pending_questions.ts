/**
 * Interactive AskUserQuestion: the park-and-resolve registry.
 *
 * When a bus agent calls `AskUserQuestion`, the runner's `canUseTool` gate
 * blocks the in-flight SDK turn on a Promise parked here (keyed by sessionId →
 * toolUseId). The operator answers via the `multi_agent_ask_user_answer`
 * ClientMsg; the WS layer calls `resolveQuestion`, which resolves that Promise
 * with the answer string. The runner then returns `{behavior:'deny', message}`
 * to the SDK, which delivers the answer to the model as the tool result and
 * the same turn resumes — no `--resume`, no orphaned tool_use.
 *
 * Why a process-level module (not the `Conn`): a parked question must survive
 * a browser re-attach (R-A) — the live run keeps going while the browser is
 * gone, so the Promise can't live on the WS connection. It does NOT survive a
 * Cebab server restart (R-B): the Promise dies with the process and the
 * reconstructed session comes back `awaiting_continue`; the agent re-asks if
 * it still needs to. This mirrors the in-process `session_registry` lifetime.
 */
import type { AskUserQuestionView } from '@cebab/shared/protocol';

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
