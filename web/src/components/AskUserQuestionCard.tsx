import { useState } from 'react';
import type { PendingAskUserQuestionView } from '@cebab/shared/protocol';

/**
 * Interactive AskUserQuestion card for the multi-agent scrollback. A bus agent
 * called `AskUserQuestion`; its turn is parked server-side until the operator
 * answers here. Each question renders its `header` chip + text, the option
 * buttons (single- or multi-select), and a free-text "Other" input (the SDK
 * always offers "Other", so we surface it regardless of the listed options).
 *
 * On submit we build `answers: Record<questionText, string>` — multi-select
 * picks are comma-joined, and any "Other" text is appended. The host sends it
 * via `multi_agent_ask_user_answer`; the server resolves the parked turn.
 */

/**
 * W04: in-progress answers, stamped with the question they belong to.
 *
 * `picks` / `other` are keyed by question INDEX, which is only meaningful
 * relative to one `toolUseId`. The card is rendered ungated by the host, so
 * `pending: null` hides it without unmounting and the state outlives the
 * question it was typed for — index 0 of the next question would arrive
 * pre-filled with index 0 of the last one, `allAnswered` already true, one
 * click from shipping a different agent's answer.
 *
 * The stamp makes the mismatch un-representable at read time: every accessor
 * goes through `answersFor`, which returns nothing unless the stamp matches
 * the question on screen. Deriving rather than resetting in an effect is
 * deliberate — an effect leaves one frame in which the stale picks are
 * rendered AND Send is enabled, which is precisely the click this guards.
 */
type StampedAnswers = {
  toolUseId: string;
  picks: Record<number, string[]>;
  other: Record<number, string>;
};

const NO_ANSWERS: Omit<StampedAnswers, 'toolUseId'> = { picks: {}, other: {} };

export function AskUserQuestionCard(props: {
  /** The active parked question, or null when there's nothing to ask. */
  pending: PendingAskUserQuestionView | null;
  onSubmit: (agent: string, toolUseId: string, answers: Record<string, string>) => void;
}) {
  const { pending } = props;
  const [answers, setAnswers] = useState<StampedAnswers | null>(null);
  // Hooks run unconditionally above; bail after so the host can render the card
  // ungated (it simply disappears when there's no pending question).
  if (!pending) return null;

  const toolUseId = pending.toolUseId;
  // Answers typed for a *previous* question read as empty rather than being
  // cleared, so there is no window in which they are visible.
  const { picks, other } = answers?.toolUseId === toolUseId ? answers : NO_ANSWERS;

  /** Re-stamp on every write, so the first edit adopts the current question. */
  function update(patch: Partial<Omit<StampedAnswers, 'toolUseId'>>): void {
    setAnswers((prev) => {
      const base = prev?.toolUseId === toolUseId ? prev : { toolUseId, ...NO_ANSWERS };
      return { ...base, ...patch };
    });
  }

  function toggle(qi: number, label: string, multi: boolean): void {
    const cur = picks[qi] ?? [];
    if (multi) {
      update({
        picks: {
          ...picks,
          [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        },
      });
      return;
    }
    // Single-select: clicking the active option clears it; otherwise replace.
    update({ picks: { ...picks, [qi]: cur.includes(label) ? [] : [label] } });
  }

  function answerFor(qi: number): string {
    const labels = [...(picks[qi] ?? [])];
    const o = (other[qi] ?? '').trim();
    if (o) labels.push(o);
    return labels.join(', ');
  }

  const allAnswered = pending.questions.every((_q, qi) => answerFor(qi).length > 0);

  // Arrow (not a hoisted `function`) so TS keeps the non-null narrowing of
  // `pending` from the early return above inside this closure.
  const submit = (): void => {
    if (!allAnswered) return;
    // Named `payload` rather than `answers` so it can't be confused with the
    // stamped state above — this one is keyed by question TEXT, for the wire.
    const payload: Record<string, string> = {};
    pending.questions.forEach((q, qi) => {
      payload[q.question] = answerFor(qi);
    });
    props.onSubmit(pending.agent, toolUseId, payload);
  };

  return (
    <div className="ask-user-card" role="group" aria-label="Question from the agent">
      <div className="ask-user-card-head">
        <span className="ask-user-card-badge">{pending.agent} asks</span>
      </div>
      {pending.questions.map((q, qi) => (
        <div key={qi} className="ask-user-q">
          <div className="ask-user-q-head">
            {q.header && <span className="ask-user-q-chip">{q.header}</span>}
            <span className="ask-user-q-text">{q.question}</span>
            {q.multiSelect && <span className="ask-user-q-multi">select any</span>}
          </div>
          <div className="ask-user-q-options">
            {q.options.map((opt) => {
              const selected = (picks[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`ask-user-option ${selected ? 'selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                >
                  <span className="ask-user-option-label">{opt.label}</span>
                  {opt.description && (
                    <span className="ask-user-option-desc">{opt.description}</span>
                  )}
                </button>
              );
            })}
          </div>
          <input
            className="ask-user-other"
            type="text"
            placeholder="Other — type a custom answer…"
            value={other[qi] ?? ''}
            aria-label={`Custom answer for: ${q.question}`}
            onChange={(e) => update({ other: { ...other, [qi]: e.target.value } })}
          />
        </div>
      ))}
      <div className="ask-user-card-actions">
        <button type="button" className="primary-btn" disabled={!allAnswered} onClick={submit}>
          Send answer
        </button>
      </div>
    </div>
  );
}
