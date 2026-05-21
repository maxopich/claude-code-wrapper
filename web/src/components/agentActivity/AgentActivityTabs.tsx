/**
 * Top-level `Agents | Artifacts` tablist for the active multi-agent run.
 *
 * WAI-ARIA tablist:
 *   - Container has `role="tablist"`.
 *   - Each tab has `role="tab"`, `aria-selected`, and an `id`.
 *   - Each panel has `role="tabpanel"`, `aria-labelledby` matching the
 *     active tab's id.
 *   - Keyboard: ArrowLeft / ArrowRight move focus + activate; Home / End
 *     jump to the extremes; Enter / Space activate the focused tab.
 *
 * Count badges show the visible-count for each surface:
 *   - Agents: number of derived lanes (real participants).
 *   - Artifacts: number of unique files with at least one confirmed
 *     mutation (matches the grouping in ArtifactsView).
 */
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AgentLanes } from './AgentLanes';
import { ArtifactsView } from './ArtifactsView';
import { deriveLanes } from './laneDerivation';
import type { MultiAgentRun } from '../../store';

type TabKey = 'agents' | 'artifacts';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'artifacts', label: 'Artifacts' },
];

export function AgentActivityTabs(props: { run: MultiAgentRun }) {
  const { run } = props;
  const [active, setActive] = useState<TabKey>('agents');
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    agents: null,
    artifacts: null,
  });

  // Counts for the tab badges. Cheap O(events) / O(mutations) — recomputed
  // whenever the inputs change.
  const agentCount = useMemo(() => deriveLanes(run).length, [run]);
  const artifactCount = useMemo(() => {
    const seen = new Set<string>();
    for (const m of run.mutations) {
      if (m.filePath !== null && m.confirmedAt !== null) seen.add(m.filePath);
    }
    return seen.size;
  }, [run.mutations]);
  const counts: Record<TabKey, number> = { agents: agentCount, artifacts: artifactCount };

  function focusTab(key: TabKey) {
    setActive(key);
    // Focus moves with selection (the "automatic activation" tablist pattern).
    // Defer to the next microtask so the just-rendered tab is the focus target.
    queueMicrotask(() => tabRefs.current[key]?.focus());
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: TabKey) {
    const idx = TABS.findIndex((t) => t.key === key);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusTab(TABS[(idx + 1) % TABS.length]!.key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(TABS[(idx - 1 + TABS.length) % TABS.length]!.key);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(TABS[0]!.key);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(TABS[TABS.length - 1]!.key);
    }
    // Enter / Space don't need explicit handling — the button click handler
    // fires natively on either.
  }

  return (
    <div className="agent-activity">
      <div className="agent-activity-tabs" role="tablist" aria-label="Active run views">
        {TABS.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el;
              }}
              id={`activity-tab-${t.key}`}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`activity-panel-${t.key}`}
              tabIndex={isActive ? 0 : -1}
              className={`agent-activity-tab${isActive ? ' is-active' : ''}`}
              onClick={() => setActive(t.key)}
              onKeyDown={(e) => onKeyDown(e, t.key)}
            >
              {t.label}
              <span className="agent-activity-tab-count" aria-label={`${counts[t.key]} entries`}>
                {counts[t.key]}
              </span>
            </button>
          );
        })}
      </div>
      <div
        id={`activity-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`activity-tab-${active}`}
        className="agent-activity-panel"
      >
        {active === 'agents' ? <AgentLanes run={run} /> : <ArtifactsView run={run} />}
      </div>
    </div>
  );
}
