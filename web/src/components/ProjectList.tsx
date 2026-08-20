import { useEffect, useRef, useState } from 'react';
import type {
  ModelCatalogueEntry,
  Project,
  ProjectScan,
  SessionPermissionMode,
  SessionSummary,
} from '@cebab/shared/protocol';
import { timeAgoCompact } from '../format';
import { ClaudeMark } from './ClaudeMark';
import { MockBadge } from './MockBadge';
import { AuthorityPreflightModal } from './authority/AuthorityPreflightModal';
import { ProjectScanLine } from './ProjectScanLine';

export function ProjectList(props: {
  projects: Project[];
  /**
   * Cebab-ws0.6: what each project declares on disk, keyed by project id. A
   * project with no entry renders no strip — absent is not the same as
   * "declares nothing", which is itself a rendered answer.
   */
  projectScans: Record<number, ProjectScan>;
  activeProjectId: number | null;
  activeSessionByProject: Record<number, string | undefined>;
  knownSessions: Record<number, SessionSummary[]>;
  liveSessions: Record<string, true>;
  onSelectProject: (id: number) => void;
  onSelectSession: (projectId: number, sessionId: string) => void;
  onNewSession: (projectId: number) => void;
  onToggleTrust: (id: number, trusted: boolean) => void;
  /**
   * Cebab-ws0.3: the model catalogue and the per-project choice, threaded to
   * the preflight modal opened from this list's ⓘ. Same shape as
   * `onToggleTrust` — the list owns no state; App dispatches and the server's
   * `projects` re-emit is what moves the UI.
   *
   * `modelCatalogue` is null until the server has answered at all, which the
   * picker renders differently from an answer that was empty.
   */
  modelCatalogue: { entries: ModelCatalogueEntry[]; capturedAt: number | null } | null;
  modelRefreshingFor: number | null;
  onSetProjectModel: (projectId: number, model: string | null) => void;
  onRefreshModelCatalogue: (projectId: number) => void;
  /** Cebab-ws0.4: the per-project starting permission mode, same threading. */
  onSetProjectStartPermissionMode: (projectId: number, mode: SessionPermissionMode | null) => void;
  /** Cebab-ws0.9: open the managed-copy modal for this project. */
  onCopyToManaged: (projectId: number) => void;
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
                // Register U01: the row's own click is a MOUSE CONVENIENCE for
                // its dead space (padding, the live dot, the Claude mark). The
                // accessible control is `.project-name` below — a real button,
                // so it is in tab order and activates on Enter/Space for free.
                // The header itself cannot be the button: `<button>` and
                // `role="button"` both forbid interactive descendants, and this
                // row already contains two of them (Select…, trust).
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
                <button
                  type="button"
                  className="project-name"
                  aria-expanded={expanded}
                  onClick={(e) => {
                    // Without this the click bubbles to the header and selects
                    // twice — harmless in the reducer, but it ships a second
                    // `open_project` over the wire for no reason.
                    e.stopPropagation();
                    props.onSelectProject(p.id);
                  }}
                >
                  {p.name}
                </button>
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
                {/* Cebab-ws0.6: what this agent declares on disk, read without
                 *  running anything. Inside the header rather than beside it so
                 *  the hover and active backgrounds cover both lines; the header
                 *  wraps, and this is a full-width flex item. Non-interactive,
                 *  so it adds nothing to tab order and leaves the register U01
                 *  constraint on this element untouched. */}
                <ProjectScanLine scan={props.projectScans[p.id]} managed={p.managed} />
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
                      projectName={p.name}
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
                      // U01: mouse convenience for the row's dead space; the
                      // button below is the control. See the project header.
                      onClick={() => props.onNewSession(p.id)}
                    >
                      <span className="session-marker" aria-hidden="true">
                        +
                      </span>
                      <button
                        type="button"
                        className="session-name"
                        aria-label={`Start a new chat in ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onNewSession(p.id);
                        }}
                      >
                        new chat
                      </button>
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
                  {/* Cebab-ws0.9: copy this agent into Cebab-managed space. Its
                   *  own row rather than a fourth control in the header, which
                   *  is already carrying the live dot, the Claude mark, the
                   *  name, Select… and the trust pill. A managed agent does not
                   *  offer it — copying a copy is legal but is not a thing to
                   *  put in front of anybody. */}
                  {!p.managed && !inSelectMode && (
                    <li className="session-row session-row-managed-copy">
                      <span className="session-marker" aria-hidden="true">
                        ⧉
                      </span>
                      <button
                        type="button"
                        className="session-name"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onCopyToManaged(p.id);
                        }}
                        title={`Make an independent copy of ${p.name} inside Cebab and run it from there. The original is not touched.`}
                      >
                        copy into Cebab
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
          model={{
            entries: props.modelCatalogue?.entries ?? [],
            capturedAt: props.modelCatalogue?.capturedAt ?? null,
            value: props.projects.find((p) => p.id === preflightForProject)?.model ?? null,
            refreshing: props.modelRefreshingFor === preflightForProject,
            onChange: (m) => props.onSetProjectModel(preflightForProject, m),
            onRefresh: () => props.onRefreshModelCatalogue(preflightForProject),
          }}
          startMode={{
            value:
              props.projects.find((p) => p.id === preflightForProject)?.startPermissionMode ?? null,
            trusted: props.projects.find((p) => p.id === preflightForProject)?.trusted ?? false,
            onChange: (m) => props.onSetProjectStartPermissionMode(preflightForProject, m),
          }}
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
 * Delete is gated behind a typed-confirmation substate (C5-2), and Cancel is
 * the default/safe action. Archive + Export are single-step (C5-3). Escape
 * exits — backing out of the confirm substate first, then out of select mode
 * entirely — so a reflexive Esc never nukes a selection mid-confirm.
 *
 * U29: the required token used to be the SELECTION COUNT, and the gate printed
 * it three times — in the prompt (`Type **3** to delete 3`), in the input's
 * `aria-label`, and as the input's `placeholder`. So the friction the gate
 * exists to create was gone twice over: the answer was a single character, and
 * it was already sitting in the field, greyed out, under the cursor. The
 * register asks for the placeholder to be dropped; that alone would change
 * nothing, because "to delete 3" still spells out the answer in the same
 * sentence. The token had to change.
 *
 * It is now the fixed verb `delete` — the rule this codebase already uses
 * twice (`inject` in EnvInjectionGateModal, `reopen` in ReopenSessionModal),
 * and one that cannot be read off the surrounding prose. The target moved into
 * the sentence instead: "Delete 7 sessions from Cebab?" confirms *what* as
 * well as *that*.
 *
 * Naming the token in a label is not the defect the placeholder was. The
 * friction a typed gate creates is deliberate typing, not secrecy — GitHub
 * prints the repository name directly above the field. Greyed text INSIDE the
 * input is different: the eye and the caret are already there.
 */
export const BULK_DELETE_TOKEN = 'delete';

function BulkActionBar(props: {
  count: number;
  /** The project the selected sessions belong to. Named in the confirm prompt
   *  so the operator confirms a target, not just a number. */
  projectName: string;
  onArchive: () => void;
  onDelete: () => void;
  onExport: () => void;
  onCancel: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const hasSelection = props.count > 0;
  const deleteArmed = confirmingDelete && confirmText.trim() === BULK_DELETE_TOKEN;

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
          Delete {props.count} session{props.count === 1 ? '' : 's'} from{' '}
          <strong>{props.projectName}</strong>? Type <code>{BULK_DELETE_TOKEN}</code> to confirm.
        </span>
        <input
          ref={confirmInputRef}
          className="bulk-action-confirm-input"
          value={confirmText}
          autoComplete="off"
          spellCheck={false}
          aria-label={`Type ${BULK_DELETE_TOKEN} to confirm deleting ${props.count} sessions from ${props.projectName}`}
          /* No `placeholder` — that was the U29 defect, and
           * `confirmationStyle.test.ts` fails if one comes back. */
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
      // `.session-row` is a row SHAPE, worn by things that are not sessions —
      // the new-chat row and, since Cebab-ws0.9, the copy-into-Cebab row. This
      // marks the ones that really are, so callers can select them positively
      // instead of by listing everything they are not; the latter is a list
      // that silently goes wrong every time a row is added.
      data-session-id={s.id}
      title={
        editing || props.selectMode
          ? undefined
          : `${s.id}\n${timeAgoCompact(s.lastEventAt)} • $${s.totalCostUsd.toFixed(4)}\nDouble-click name to rename`
      }
      // Register U01: mouse convenience only — `.session-name` below is the
      // real control. The row previously carried `aria-selected` here, which
      // assistive tech ignores on a bare <li> (that attribute needs an
      // option/row/tab role, and this list has none); the state now rides on
      // the button as `aria-pressed`, which is what a toggle actually maps to.
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
        <button
          type="button"
          className="session-name"
          aria-pressed={props.selectMode ? props.selected : undefined}
          aria-current={!props.selectMode && props.active ? 'true' : undefined}
          aria-label={props.selectMode ? `Select session ${label}` : `Open session ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            if (props.selectMode) props.onToggleSelect();
            else props.onSelect();
          }}
          onDoubleClick={(e) => {
            // Rename is disabled in select mode — the double-click would
            // otherwise fight the selection toggle. The keyboard path to
            // rename is the ✎ button below, not this.
            if (props.selectMode) return;
            e.stopPropagation();
            startEdit();
          }}
        >
          {label}
        </button>
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
      {!editing && <span className="session-meta">{timeAgoCompact(s.lastEventAt)}</span>}
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
