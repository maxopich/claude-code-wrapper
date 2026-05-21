/**
 * "Working files (N)" disclosure pinned at the bottom of each lane.
 *
 * Lists confirmed mutations by this lane's agent whose file path did NOT
 * pass the artifact promotion globs — i.e. scratch working files (source
 * edits, configs, ephemera). Promoted files go to the Artifacts tab;
 * provisional rows (no `confirmedAt`) are hidden everywhere until the
 * matching `tool_result` lands.
 *
 * Lane-level placement (not per-row): the plan called for "inside an
 * agent's expanded row" but that's ambiguous in the v1 data model
 * (activity rows are bus hops, not per-tool entries). Surfacing once at
 * the lane bottom keeps the per-event detail clean and still gives the
 * operator a single place to glance at "what's this agent touching."
 */
import { useState } from 'react';
import type { MultiAgentMutationView } from '@cebab/shared/protocol';
import type { MultiAgentRun } from '../../store';

function scratchFor(
  run: MultiAgentRun,
  agentName: string,
): { filePath: string; latest: MultiAgentMutationView; editCount: number }[] {
  const byFile = new Map<
    string,
    { filePath: string; latest: MultiAgentMutationView; editCount: number }
  >();
  for (const m of run.mutations) {
    if (m.agentName !== agentName) continue;
    if (m.filePath === null || m.confirmedAt === null) continue;
    if (m.promoted) continue;
    const existing = byFile.get(m.filePath);
    if (!existing) {
      byFile.set(m.filePath, { filePath: m.filePath, latest: m, editCount: 1 });
    } else {
      existing.editCount += 1;
      if (m.ts > existing.latest.ts) existing.latest = m;
    }
  }
  return [...byFile.values()].sort((a, b) => b.latest.ts - a.latest.ts);
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export function WorkingFiles(props: { run: MultiAgentRun; agentName: string }) {
  const [open, setOpen] = useState(false);
  const files = scratchFor(props.run, props.agentName);
  if (files.length === 0) return null;
  return (
    <details
      className="working-files"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="working-files-summary">
        <span className="working-files-label">Working files</span>
        <span className="working-files-count">{files.length}</span>
      </summary>
      <ul className="working-files-list">
        {files.map((f) => (
          <li key={f.filePath} className="working-files-item">
            <span className="working-files-name" title={f.filePath}>
              {basename(f.filePath)}
            </span>
            {f.editCount > 1 && <span className="working-files-edits">{f.editCount} edits</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
