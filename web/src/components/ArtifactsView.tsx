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
 * Preview pane stays metadata-first: the file body is NEVER auto-loaded on
 * row select. Cluster I H3 adds an opt-in "▸ View latest content" disclosure
 * (preserving that lazy posture, H3-2 / R-I6) that fetches the current on-disk
 * content only on explicit open, via `get_artifact_content` — server-redacted
 * (H3-3) and capped at 1 MB (H3-4). A real diff against a pre-mutation snapshot
 * is v2 (Cebab captures no pre-image today, spec §2 / OQ-I5); the "Diff against
 * previous edit" affordance is scaffolded but disabled behind `ARTIFACT_DIFF_V2`.
 */
import { useMemo, useState } from 'react';
import { logsHashFor } from './sessionLog/logsHash';
import { AgentTag } from './AgentTag';
import { ARTIFACT_DIFF_V2 } from '../featureFlags';
import { useArtifactContent } from '../useArtifactContent';
import type { MultiAgentRun } from '../store';
import type {
  ArtifactContentError,
  ClientMsg,
  MultiAgentMutationView,
  ServerMsg,
} from '@cebab/shared/protocol';

type ArtifactGroup = {
  filePath: string;
  authoringAgent: string;
  /** Most recent confirmed mutation against this path (header data). */
  latest: MultiAgentMutationView;
  editCount: number;
};

export function groupArtifacts(mutations: readonly MultiAgentMutationView[]): ArtifactGroup[] {
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

export function ArtifactsView(props: {
  run: MultiAgentRun;
  /** WS send — used by the lazy content disclosure (`get_artifact_content`). */
  send: (msg: ClientMsg) => void;
  /** Side-channel subscribe — the `artifact_content` reply lands here. */
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}) {
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
            <ArtifactContentDisclosure
              key={selectedGroup.latest.id}
              mutationId={selectedGroup.latest.id}
              send={props.send}
              subscribeServerMsg={props.subscribeServerMsg}
            />
          </div>
        </aside>
      )}
    </div>
  );
}

/**
 * Cluster I Phase H3 UI: the per-artifact "▸ View latest content" disclosure
 * inside the preview aside. Lazy + opt-in (H3-2): nothing is fetched until the
 * operator expands it. The parent keys this by `mutationId`, so selecting a
 * different artifact remounts it collapsed + idle — no auto-fetch on select.
 */
function ArtifactContentDisclosure(props: {
  mutationId: number;
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  const [open, setOpen] = useState(false);
  const { status, content, size, truncated, redactedFields, error, load } = useArtifactContent({
    mutationId: props.mutationId,
    send: props.send,
    subscribeServerMsg: props.subscribeServerMsg,
  });

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      // Lazy: fetch on the FIRST open only (status leaves 'idle' once we ask).
      if (next && status === 'idle') load();
      return next;
    });
  }

  return (
    <div className="artifact-content">
      <button
        type="button"
        className="ghost-btn artifact-content-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? '▾' : '▸'} View latest content
      </button>

      {open && (
        <div className="artifact-content-body">
          {status === 'loading' && <p className="artifact-content-hint">Loading…</p>}

          {status === 'error' && (
            <div className="artifact-content-error" role="alert">
              <p>{describeArtifactError(error)}</p>
              <button type="button" className="ghost-btn" onClick={load}>
                Retry
              </button>
            </div>
          )}

          {status === 'loaded' && (
            <>
              <div className="artifact-content-meta">
                <span className="artifact-content-size">{formatBytes(size)}</span>
                {redactedFields.length > 0 && (
                  <span
                    className="artifact-content-redacted"
                    title="Sensitive content was masked before display"
                  >
                    redacted
                  </span>
                )}
                {truncated && (
                  <span className="artifact-content-truncated">first 1 MB — file is larger</span>
                )}
              </div>
              <pre className="artifact-content-pre">{content}</pre>
            </>
          )}

          {/* v2 scaffold (H3-5): a real diff needs a pre-mutation snapshot Cebab
              doesn't capture yet (spec §2 / OQ-I5). Disabled behind the flag;
              when enabled it would render a <pre className="permission-diff">
              with <del>/<ins>, reusing PermissionCards' diff styling. */}
          <button
            type="button"
            className="ghost-btn artifact-content-diff-btn"
            disabled={!ARTIFACT_DIFF_V2}
            title={
              ARTIFACT_DIFF_V2
                ? 'Diff this artifact against its previous edit'
                : 'Diff requires a pre-mutation snapshot; coming in v2.'
            }
          >
            ⇄ Diff against previous edit
          </button>
        </div>
      )}
    </div>
  );
}

/** Human label for a failed content read (`artifact_content.error`). */
function describeArtifactError(error: ArtifactContentError | undefined): string {
  switch (error) {
    case 'mutation_not_found':
      return "Couldn't find this artifact's record — the session may have been purged.";
    case 'no_file_path':
      return 'This mutation has no single file to preview.';
    case 'not_a_file':
      return 'That path is no longer a regular file.';
    case 'read_failed':
      return "Couldn't read the file — it may have been moved or deleted since.";
    default:
      return "Couldn't load the file content.";
  }
}

/** Compact byte size for the content meta line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
