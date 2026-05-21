/**
 * The Artifacts surface for an active multi-agent run. Lists every PROMOTED
 * file mutation, grouped by file (one row per unique file path — subsequent
 * edits collapse into a single "edits: N" row).
 *
 * Three gates a mutation must pass to appear here:
 *   1. `filePath` is non-null (Bash and friends don't surface).
 *   2. `confirmedAt` is non-null (provisional rows hide — the tool
 *      may have failed / been paused mid-flight).
 *   3. `promoted === true` — server-side `classifyArtifact` matched
 *      the locked promotion globs (plans/, PLAN*.md, etc.).
 *
 * Confirmed-but-not-promoted writes (scratch) surface in the Session info
 * panel via `WorkingFiles`. The split is privacy-by-default: an `.env`
 * write or a node_modules touch shouldn't bubble up as a deliverable.
 *
 * Preview pane is intentionally metadata-only for v1: we DO NOT load
 * file contents into the browser without an explicit click. Screenshots
 * leak.
 */
import { useMemo, useState } from 'react';
import { logsHashFor } from './sessionLog/logsHash';
import { AgentTag } from './AgentTag';
import type { MultiAgentRun } from '../store';
import type { MultiAgentMutationView } from '@cebab/shared/protocol';

type ArtifactGroup = {
  filePath: string;
  authoringAgent: string;
  /** Most recent confirmed mutation against this path (header data). */
  latest: MultiAgentMutationView;
  editCount: number;
};

function groupArtifacts(mutations: readonly MultiAgentMutationView[]): ArtifactGroup[] {
  const byFile = new Map<string, ArtifactGroup>();
  for (const m of mutations) {
    if (m.filePath === null || m.confirmedAt === null || !m.promoted) continue;
    const existing = byFile.get(m.filePath);
    if (!existing) {
      byFile.set(m.filePath, {
        filePath: m.filePath,
        authoringAgent: m.agentName,
        latest: m,
        editCount: 1,
      });
    } else {
      existing.editCount += 1;
      if (m.ts > existing.latest.ts) {
        existing.latest = m;
        existing.authoringAgent = m.agentName;
      }
    }
  }
  return [...byFile.values()].sort((a, b) => b.latest.ts - a.latest.ts);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function fileType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'FILE';
  return path
    .slice(dot + 1)
    .toUpperCase()
    .slice(0, 6);
}

export function ArtifactsView(props: { run: MultiAgentRun }) {
  const groups = useMemo(() => groupArtifacts(props.run.mutations), [props.run.mutations]);
  const [selected, setSelected] = useState<string | null>(null);

  if (groups.length === 0) {
    return (
      <div className="artifacts-empty">
        <p>No artifacts yet.</p>
        <p className="artifacts-empty-hint">
          Files written by agents will appear here once the producing tool call confirms.
        </p>
      </div>
    );
  }

  const selectedGroup = groups.find((g) => g.filePath === selected) ?? groups[0];

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Clipboard API can fail silently — operator can still select + copy.
    }
  }

  return (
    <div className="artifacts">
      <div className="artifacts-table-wrap" role="region" aria-label="artifact list">
        <table className="artifacts-table">
          <thead>
            <tr>
              <th className="artifacts-col-name">Name</th>
              <th className="artifacts-col-type">Type</th>
              <th className="artifacts-col-author">Author</th>
              <th className="artifacts-col-updated">Updated</th>
              <th className="artifacts-col-edits">Edits</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isSelected = g.filePath === selectedGroup?.filePath;
              return (
                <tr
                  key={g.filePath}
                  className={`artifacts-row${isSelected ? ' is-selected' : ''}`}
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => setSelected(g.filePath)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(g.filePath);
                    }
                  }}
                >
                  <td className="artifacts-col-name">
                    <span className="artifacts-file-icon" aria-hidden="true">
                      ◫
                    </span>
                    <span className="artifacts-file-name">{basename(g.filePath)}</span>
                    <span className="artifacts-file-path" title={g.filePath}>
                      {g.filePath}
                    </span>
                  </td>
                  <td className="artifacts-col-type">{fileType(g.filePath)}</td>
                  <td className="artifacts-col-author">
                    <AgentTag slug={g.authoringAgent} />
                  </td>
                  <td className="artifacts-col-updated" title={formatTs(g.latest.ts)}>
                    {formatTs(g.latest.ts)}
                  </td>
                  <td className="artifacts-col-edits">{g.editCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selectedGroup && (
        <aside className="artifacts-preview" role="region" aria-label="artifact preview">
          <header className="artifacts-preview-header">
            <div>
              <h4 className="artifacts-preview-name">{basename(selectedGroup.filePath)}</h4>
              <p className="artifacts-preview-path" title={selectedGroup.filePath}>
                {selectedGroup.filePath}
              </p>
            </div>
            <div className="artifacts-preview-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => copyPath(selectedGroup.filePath)}
                title="Copy the file path to the clipboard"
              >
                Copy path
              </button>
              <a
                className="ghost-btn"
                href={logsHashFor(props.run.sessionId, `mutation:${selectedGroup.latest.id}`)}
                title="Open this artifact's production event in the Logs surface"
              >
                ↗ open in logs
              </a>
            </div>
          </header>
          <div className="artifacts-preview-body">
            <p className="artifacts-preview-meta">
              {selectedGroup.editCount} {selectedGroup.editCount === 1 ? 'edit' : 'edits'} by{' '}
              <code>{selectedGroup.authoringAgent}</code> · last touch{' '}
              {formatTs(selectedGroup.latest.ts)}
            </p>
            <p className="artifacts-preview-note">
              File contents are not auto-loaded — open the file from disk to inspect.
            </p>
          </div>
        </aside>
      )}
    </div>
  );
}
