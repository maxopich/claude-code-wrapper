import { useState } from 'react';
import type { RecoveryContextView } from '@cebab/shared/protocol';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Item #7: read-only "▾ Recovery details" disclosure mounted inside the
 * awaiting-continue banner ([MultiAgentTab.tsx]). Surfaces the per-agent
 * "may have been interrupted" verdict + last-persisted activity wall-clock
 * + a "side effects not rolled back" warning so the operator can judge
 * whether resuming is safe.
 *
 * Default-open when at least one agent is flagged interrupted (operator
 * sees the warning without clicking); default-closed otherwise (the
 * disclosure is still mountable so the "all clear" signal is checkable).
 * The data is server-derived in `computeRecoveryContext`; this component
 * is pure presentation.
 */
export function RecoveryDisclosure(props: { recovery: RecoveryContextView }) {
  const { interruptedAgents, staleSinceTs } = props.recovery;
  const hasInterruption = interruptedAgents.length > 0;
  const [open, setOpen] = useState(hasInterruption);

  return (
    <div className="recovery-disclosure">
      <button
        type="button"
        className="ghost-btn"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={
          hasInterruption
            ? 'Open to see which workers may have unfinished turns.'
            : 'Open to confirm all workers checkpointed cleanly.'
        }
      >
        {open ? '▾' : '▸'} Recovery details
        {hasInterruption && (
          <span className="recovery-warn-marker">
            {' '}
            · {interruptedAgents.length} possibly interrupted
          </span>
        )}
      </button>
      {open && (
        <div className="recovery-body">
          <p>
            Last persisted activity: <code>{formatTime(staleSinceTs)}</code>.
          </p>
          {hasInterruption ? (
            <>
              <p>These workers may have unfinished turns:</p>
              <ul className="recovery-agent-list">
                {interruptedAgents.map((a) => (
                  <li key={a.agentName}>
                    <code>{a.agentName}</code> — last activity{' '}
                    <code>{formatTime(a.lastEventTs)}</code>, last successful checkpoint{' '}
                    <code>
                      {a.lastCheckpointTs !== null ? formatTime(a.lastCheckpointTs) : 'never'}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="recovery-warn">
                Cebab does not roll back filesystem changes from interrupted turns. Review with{' '}
                <code>git status</code> in each worker's project before continuing.
              </p>
            </>
          ) : (
            <p>All agents had completed their turns cleanly.</p>
          )}
        </div>
      )}
    </div>
  );
}
