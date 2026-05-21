/**
 * "Working files (N)" disclosure, surfaced in the Session info panel.
 *
 * Aggregates confirmed mutations across every agent whose file path did NOT
 * pass the artifact promotion globs — i.e. scratch working files (source
 * edits, configs, ephemera). Promoted files go to the Artifacts surface;
 * provisional rows (no `confirmedAt`) are hidden everywhere until the
 * matching `tool_result` lands. Each row carries an `<AgentTag>` so cross-
 * agent attribution survives the aggregation.
 */
import { useState } from 'react';
import type { MultiAgentMutationView } from '@cebab/shared/protocol';
import type { MultiAgentRun } from '../store';
import { AgentTag } from './AgentTag';

type ScratchFile = {
  filePath: string;
  latest: MultiAgentMutationView;
  editCount: number;
};

function scratchFiles(run: MultiAgentRun): ScratchFile[] {
  const byFile = new Map<string, ScratchFile>();
  for (const m of run.mutations) {
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

export function WorkingFiles(props: { run: MultiAgentRun }) {
  const [open, setOpen] = useState(false);
  const files = scratchFiles(props.run);
  if (files.length === 0) {
    return <span className="settings-grid-muted">—</span>;
  }
  return (
    <details
      className="working-files"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="working-files-summary">
        <span className="working-files-label">
          {open ? '▾' : '▸'} {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </summary>
      <ul className="working-files-list">
        {files.map((f) => (
          <li key={f.filePath} className="working-files-item">
            <AgentTag slug={f.latest.agentName} />
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
