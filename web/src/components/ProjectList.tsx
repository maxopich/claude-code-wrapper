import { useEffect, useRef, useState } from 'react';
import type { Project, SessionSummary } from '@cebab/shared/protocol';
import { ClaudeMark } from './ClaudeMark';
import { MockBadge } from './MockBadge';
import { AuthorityPreflightModal } from './authority/AuthorityPreflightModal';

export function ProjectList(props: {
  projects: Project[];
  activeProjectId: number | null;
  activeSessionByProject: Record<number, string | undefined>;
  knownSessions: Record<number, SessionSummary[]>;
  liveSessions: Record<string, true>;
  onSelectProject: (id: number) => void;
  onSelectSession: (projectId: number, sessionId: string) => void;
  onNewSession: (projectId: number) => void;
  onToggleTrust: (id: number, trusted: boolean) => void;
  onRenameSession: (sessionId: string, title: string | null) => void;
  /**
   * Cluster I C2 UI: trigger a per-session JSONL download. Returns a
   * promise so a future surface (e.g. SessionSettingsPanel Data entry)
   * can await + show a spinner. The promise NEVER throws — toasting on
   * success/error is App.tsx's responsibility.
   */
  onDownloadSession: (sessionId: string) => Promise<void>;
  /**
   * Cluster I C5 UI: archive or soft-delete a batch of sessions. Fire-and-
   * forget — the server replies with `bulk_session_op_result`, the reducer
   * drops the succeeded rows, and App.tsx toasts the outcome. We exit
   * select mode optimistically the moment this is invoked (the rows
   * vanish a beat later when the result lands).
   */
  onBulkSessionOp: (op: 'archive' | 'delete', sessionIds: string[]) => void;
  /**
   * Cluster I C5 UI: export a batch of sessions as individual JSONL
   * downloads (loops the C2 `GET /session-log/:sid` endpoint per session).
   * Returns a promise so a future surface can await; here we fire it and
   * exit select mode immediately. NEVER throws — toasting is App.tsx's job.
   */
  onBulkExportSessions: (sessionIds: string[]) => Promise<void>;
}) {
  // Cluster B Phase 6e: tracks which project's preflight modal is open. One
  // at a time — the operator clicks an ⓘ button, modal opens for THAT
  // project, closing returns to null. Local state avoids prop-drilling
  // through every row.
  const [preflightForProject, setPreflightForProject] = useState<number | null>(null);

  // Cluster I C5 UI: bulk-select state. Only the currently-EXPANDED project
  // can be in select mode (you select sessions you can see), so a single
  // boolean + a Set of session ids is enough — no per-project keying. When
  // the operator switches/collapses projects we reset both (the effect
  // below), so a stale selection from project A can't leak into project B.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // Expanded project changed (or collapsed) — drop any in-progress
    // selection so it can't apply to the wrong project.
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [props.activeProjectId]);

  function toggleSelected(sessionId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  return (
    <>
      <ul className="project-list">
        {props.projects.map((p) => {
          const expanded = p.id === props.activeProjectId;
          const sessions = props.knownSessions[p.id] ?? [];
          const activeSessionId = props.activeSessionByProject[p.id];
          const projectIsLive = sessions.some((s) => props.liveSessions[s.id]);
          // Select mode is scoped to the expanded project; never render the
          // checkbox/action-bar chrome for a collapsed project even if the
          // toggle state lingers a render before the reset effect fires.
          const inSelectMode = expanded && selectMode;
          return (
            <li key={p.id} className={`project-row ${expanded ? 'expanded' : ''}`}>
              <div
                className={`project-header ${expanded ? 'active' : ''}`}
                title={
                  p.hasClaudeMd
                    ? p.name
                    : `${p.name}\n\nNo CLAUDE.md found in ${p.path} — this folder doesn't look like an agent project. You can still run Claude here, but project-level instructions, skills, and MCP servers won't auto-load.`
                }
                aria-label={p.name}
                draggable
                onDragStart={(e) => {
                  // JSON payload with a kind tag so the Multi-Agent drop zone
                  // can validate that it came from us rather than another app.
                  e.dataTransfer.setData(
                    'application/json',
                    JSON.stringify({ kind: 'cebab-project', id: p.id }),
                  );
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => props.onSelectProject(p.id)}
              >
                <span
                  className={`project-live-dot ${projectIsLive ? 'on' : ''}`}
                  title={projectIsLive ? 'session running' : ''}
                />
                {p.hasClaudeMd ? (
                  <ClaudeMark className="claude-mark" title="Agent project (CLAUDE.md present)" />
                ) : (
                  <span className="claude-mark-spacer" aria-hidden="true" />
                )}
                <span className="project-name">{p.name}</span>
                {/* Cluster I C5 UI: Select-mode toggle. Only meaningful when the
                 *  project is expanded (its session list is visible), so it's
                 *  gated on `expanded`. Hidden when the project has no sessions
                 *  to act on. stopPropagation so the click doesn't re-fire
                 *  onSelectProject. */}
                {expanded && sessions.length > 0 && (
                  <button
                    type="button"
                    className={`session-select-toggle ${selectMode ? 'on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectMode) exitSelectMode();
                      else setSelectMode(true);
                    }}
                    aria-pressed={selectMode}
                    title={
                      selectMode
                        ? 'Exit selection mode'
                        : 'Select multiple sessions to archive, export, or delete'
                    }
                  >
                    {selectMode ? 'Done' : 'Select…'}
                  </button>
                )}
                <button
                  className={`trust ${p.trusted ? 'on' : 'off'}`}
                  title={p.trusted ? 'Trusted (auto-approve tools)' : 'Asks before tool use'}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleTrust(p.id, !p.trusted);
                  }}
                >
                  {p.trusted ? 'trusted' : 'asks'}
                </button>
              </div>
              {expanded && (
                <ul className="session-list">
                  {/* Cluster I C5 UI: the bulk action bar replaces the
                   *  "new chat" row while selecting — you can't bulk-op a
                   *  not-yet-created session, and the operator's focus is on
                   *  the selection, not starting a new one. */}
                  {inSelectMode ? (
                    <BulkActionBar
                      count={selectedIds.size}
                      onArchive={() => {
                        props.onBulkSessionOp('archive', [...selectedIds]);
                        exitSelectMode();
                      }}
                      onDelete={() => {
                        props.onBulkSessionOp('delete', [...selectedIds]);
                        exitSelectMode();
                      }}
                      onExport={() => {
                        void props.onBulkExportSessions([...selectedIds]);
                        exitSelectMode();
                      }}
                      onCancel={exitSelectMode}
                    />
                  ) : (
                    <li
                      className={`session-row new ${!activeSessionId ? 'active' : ''}`}
                      onClick={() => props.onNewSession(p.id)}
                    >
                      <span className="session-marker">+</span>
                      <span className="session-name">new chat</span>
                      {/* Cluster B Phase 6e (UI-B5): trailing ⓘ button opens the
                       *  AuthorityPreflightModal scoped to this project. stopPropagation
                       *  so the click doesn't also fire onNewSession. */}
                      <button
                        type="button"
                        className="session-row-authority-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreflightForProject(p.id);
                        }}
                        aria-label={`Inspect authority for ${p.name} before starting`}
                        title="Inspect resolved authority (tools, MCP servers, env, hooks) before starting a session"
                      >
                        ⓘ
                      </button>
                    </li>
                  )}
                  {sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      live={props.liveSessions[s.id] === true}
                      active={s.id === activeSessionId}
                      selectMode={inSelectMode}
                      selected={selectedIds.has(s.id)}
                      onSelect={() => props.onSelectSession(p.id, s.id)}
                      onToggleSelect={() => toggleSelected(s.id)}
                      onRename={(title) => props.onRenameSession(s.id, title)}
                      onDownload={() => props.onDownloadSession(s.id)}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {preflightForProject !== null && (
        <AuthorityPreflightModal
          projectIds={[preflightForProject]}
          onClose={() => setPreflightForProject(null)}
        />
      )}
    </>
  );
}

/**
 * Cluster I C5 UI: bottom-anchored bulk-action bar shown while the
 * expanded project is in select mode. Renders the live selection count
 * (announced via `aria-live="polite"` per C5-4) and the three ops.
 *
 * Delete is gated behind a typed-confirmation substate (C5-2): the
 * operator must type the selection count to arm the destructive button,
 * and Cancel is the default/safe action. Archive + Export are single-step
 * (C5-3). Escape exits — backing out of the confirm substate first, then
 * out of select mode entirely — so a reflexive Esc never nukes a
 * selection mid-confirm.
 */
function BulkActionBar(props: {
  count: number;
  onArchive: () => void;
  onDelete: () => void;
  onExport: () => void;
  onCancel: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const hasSelection = props.count > 0;
  // The operator types the selection count to arm Delete (C5-2). Using the
  // count (vs a project name) keeps the gate self-contained in this bar.
  const confirmTarget = String(props.count);
  const deleteArmed = confirmingDelete && confirmText.trim() === confirmTarget;

  useEffect(() => {
    if (confirmingDelete) confirmInputRef.current?.focus();
  }, [confirmingDelete]);

  // Document-level Escape handler: back out of the confirm substate first,
  // otherwise exit select mode. Active only while the bar is mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (confirmingDelete) {
        setConfirmingDelete(false);
        setConfirmText('');
      } else {
        props.onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmingDelete, props]);

  if (confirmingDelete) {
    return (
      <li className="bulk-action-bar confirming" aria-label="Confirm bulk delete">
        <span className="bulk-action-confirm-prompt">
          Type <strong>{confirmTarget}</strong> to delete {props.count}
        </span>
        <input
          ref={confirmInputRef}
          className="bulk-action-confirm-input"
          value={confirmText}
          inputMode="numeric"
          aria-label={`Type ${confirmTarget} to confirm deleting ${props.count} sessions`}
          placeholder={confirmTarget}
          onChange={(e) => setConfirmText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && deleteArmed) {
              e.preventDefault();
              props.onDelete();
            }
          }}
        />
        <button
          type="button"
          className="bulk-action-btn danger"
          disabled={!deleteArmed}
          onClick={() => props.onDelete()}
        >
          Delete {props.count}
        </button>
        <button
          type="button"
          className="bulk-action-btn"
          onClick={() => {
            setConfirmingDelete(false);
            setConfirmText('');
          }}
        >
          Cancel
        </button>
      </li>
    );
  }

  return (
    <li className={`bulk-action-bar ${hasSelection ? 'has-selection' : ''}`}>
      <span className="bulk-action-count" aria-live="polite">
        {props.count} selected
      </span>
      <button
        type="button"
        className="bulk-action-btn"
        disabled={!hasSelection}
        onClick={() => props.onArchive()}
        title="Hide selected sessions from the list (recoverable)"
      >
        Archive
      </button>
      <button
        type="button"
        className="bulk-action-btn"
        disabled={!hasSelection}
        onClick={() => props.onExport()}
        title="Download a .jsonl log for each selected session"
      >
        Export
      </button>
      <button
        type="button"
        className="bulk-action-btn danger"
        disabled={!hasSelection}
        onClick={() => setConfirmingDelete(true)}
        title="Soft-delete selected sessions (recoverable for 7 days)"
      >
        Delete
      </button>
    </li>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  live: boolean;
  active: boolean;
  /** Cluster I C5 UI: when true, the row renders a selection checkbox and
   *  a click toggles selection instead of navigating. */
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onRename: (title: string | null) => void;
  /**
   * Cluster I C2 UI: per-row JSONL download trigger. Returns a promise
   * so we can swap the icon for a transient spinner state — the
   * download path may take a beat for larger sessions.
   */
  onDownload: () => Promise<void>;
}) {
  const { session: s } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select-all when entering edit mode so the user can immediately
  // type a new name or overwrite the existing one.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(s.title ?? '');
    setEditing(true);
  }
  function commit() {
    if (!editing) return;
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    // Don't dispatch if the value hasn't actually changed — avoids a useless
    // server round-trip on the common "open edit, hit Esc by reflex" path.
    if (next !== (s.title ?? null)) props.onRename(next);
  }
  function cancel() {
    setEditing(false);
  }

  const label = s.title || s.id.slice(0, 8);

  return (
    <li
      className={`session-row ${props.active ? 'active' : ''} ${editing ? 'editing' : ''} ${
        props.selectMode ? 'selecting' : ''
      } ${props.selectMode && props.selected ? 'selected' : ''}`}
      aria-selected={props.selectMode ? props.selected : undefined}
      title={
        editing || props.selectMode
          ? undefined
          : `${s.id}\n${formatRelative(s.lastEventAt)} • $${s.totalCostUsd.toFixed(4)}\nDouble-click name to rename`
      }
      onClick={() => {
        if (props.selectMode) props.onToggleSelect();
        else if (!editing) props.onSelect();
      }}
    >
      {/* Cluster I C5 UI: in select mode the leading marker becomes a
       *  checkbox. The row's onClick already toggles selection, so the
       *  checkbox is `readOnly` + `tabIndex={-1}` — it's a visual mirror of
       *  the row's selected state, not a separate focus/click target (which
       *  would double-toggle). The accessible control IS the row
       *  (aria-selected above). */}
      {props.selectMode ? (
        <input
          type="checkbox"
          className="session-select-checkbox"
          checked={props.selected}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : (
        <span
          className={`session-marker ${props.live ? 'live' : ''}`}
          title={props.live ? 'running on this connection' : ''}
        />
      )}
      {editing ? (
        <input
          ref={inputRef}
          className="session-name-input"
          value={draft}
          maxLength={80}
          placeholder={s.id.slice(0, 8)}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span
          className="session-name"
          onDoubleClick={(e) => {
            // Rename is disabled in select mode — the double-click would
            // otherwise fight the selection toggle.
            if (props.selectMode) return;
            e.stopPropagation();
            startEdit();
          }}
        >
          {label}
        </span>
      )}
      {/* Per-row action buttons (rename + download) are hidden in select
       *  mode: the row is a selection target there, not an action surface. */}
      {!editing && !props.selectMode && (
        <button
          className="session-rename-btn"
          title="Rename session"
          aria-label="Rename session"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          ✎
        </button>
      )}
      {/* Cluster I C2 UI: per-session JSONL download. Sits right of the
       *  Rename btn so the action cluster stays at the right edge of the
       *  row. Disabled while a download is in-flight to prevent the
       *  operator from double-firing the same fetch + audit row. */}
      {!editing && !props.selectMode && (
        <button
          className="session-download-btn"
          title="Download session log (.jsonl)"
          aria-label="Download session log"
          aria-busy={downloading || undefined}
          disabled={downloading}
          onClick={(e) => {
            e.stopPropagation();
            if (downloading) return;
            setDownloading(true);
            props.onDownload().finally(() => setDownloading(false));
          }}
        >
          ⤓
        </button>
      )}
      {!editing && <span className="session-meta">{formatRelative(s.lastEventAt)}</span>}
      {/* Cluster G Phase 2b (UI-A3): per-row MOCK chip when this
       *  session was created under MOCK runtime mode. Stays visible
       *  AFTER the operator restarts Cebab in live mode — the row is
       *  historical, the badge is its record. Strict equality on
       *  === true: undefined (pre-G2 server) and false both render
       *  nothing. Mounted last in the row so it sits at the rightmost
       *  edge; the `history` variant carries lower opacity since the
       *  row is a list item, not a live announcement. */}
      {!editing && s.mock === true && <MockBadge variant="history" />}
    </li>
  );
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
