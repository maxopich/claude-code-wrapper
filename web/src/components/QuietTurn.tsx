import type { ReactNode } from 'react';
import type { MessageView } from '../store';
import { quietMessages, type ChatTurn } from '../quietChat';

/**
 * `Cebab-ibb4`: one turn of the quiet chat — the prompt, the answer, and a
 * count of what is not being shown.
 *
 * IT RENDERS NOTHING ITSELF. Both states go through the `render` callback the
 * parent supplies, which is `MessageBlock` with the session's handlers already
 * bound, so "show the steps" produces the transcript that ships today rather
 * than a second rendering of it that could drift. That is also why the expanded
 * state renders `turn.messages` unfiltered instead of un-hiding row by row:
 * there is then no arrangement of this component in which the operator is
 * looking at something the full view would not have shown them.
 *
 * The count is on a plain toggle rather than a `<details>` because the summary
 * has to stay legible while the turn is still running — `hiddenCount` climbs as
 * the agent works, and it is the only progress signal a collapsed turn has.
 */
export function QuietTurn(props: {
  turn: ChatTurn;
  expanded: boolean;
  onToggle: () => void;
  render: (m: MessageView) => ReactNode;
}) {
  const { turn, expanded, onToggle, render } = props;
  const shown = expanded ? turn.messages : quietMessages(turn);
  const n = turn.hiddenCount;
  const noun = `step${n === 1 ? '' : 's'}`;

  return (
    <div className="quiet-turn">
      {shown.map(render)}
      {n > 0 && (
        <button
          type="button"
          className="ghost-btn quiet-steps-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          title={
            expanded
              ? 'Collapse this turn back to its answer'
              : 'Show the tool calls and their output from this turn'
          }
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{' '}
          {expanded ? `hide ${n} ${noun}` : `${n} ${noun}`}
        </button>
      )}
    </div>
  );
}
