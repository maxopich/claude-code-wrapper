import { useEffect, useState } from 'react';
import type {
  IterationSummary,
  MultiAgentLifecycle,
  MultiAgentTemplate,
  Project,
} from '@cebab/shared/protocol';
import type { MultiAgentEventView, MultiAgentRun, MultiAgentState } from '../store';
import { Markdown } from './Markdown';

/**
 * Multi-Agent tab.
 *
 * One of two views shows depending on whether a multi-agent session is
 * active:
 *
 *   - **Draft** (no active session): mode selector, drop zone, participant
 *     list, initial-prompt textarea, Start buttons. The operator assembles
 *     a fixed chain or an orchestrator-routed session.
 *
 *   - **Running / Ended** (active session): a scrollback of inter-agent
 *     events with sender/recipient tags, plus a Stop button while live and
 *     an iteration link after completion.
 *
 * The view-switch is reducer-driven (`state.multiAgent.active`), not
 * imperative — the server's `multi_agent_started`/`multi_agent_ended` events
 * are the source of truth.
 */
export function MultiAgentTab(props: {
  projects: Project[];
  multiAgent: MultiAgentState;
  onSetMode: (mode: 'chain' | 'orchestrator') => void;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  onRemoveParticipant: (projectId: number) => void;
  onReorderParticipant: (projectId: number, direction: 'up' | 'down') => void;
  onInstallBus: (projectId: number) => void;
  onUninstallBus: (projectId: number) => void;
  onSetDraftPrompt: (text: string) => void;
  onStartChain: () => void;
  onStartOrchestrator: () => void;
  onStopMultiAgent: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  /** Monotonic; bumps on every wrapper_error so pending spinners clear on failure. */
  wrapperErrorSeq: number;
  onSendUserPrompt: (sessionId: string, text: string) => void;
  onSetActiveLifecycle: (sessionId: string, lifecycle: MultiAgentLifecycle) => void;
  onAddActiveParticipant: (sessionId: string, projectId: number) => void;
  onDismissActive: () => void;
  onRefreshIterations: () => void;
  onClearIterations: () => void;
  onRefreshTemplates: () => void;
  onSaveTemplate: (name: string) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (t: MultiAgentTemplate) => void;
}) {
  const { multiAgent, projects } = props;
  if (multiAgent.active) {
    return (
      <ActiveRunView
        run={multiAgent.active}
        projects={projects}
        onStop={props.onStopMultiAgent}
        onSendUserPrompt={props.onSendUserPrompt}
        onSetLifecycle={props.onSetActiveLifecycle}
        onAddParticipant={props.onAddActiveParticipant}
        onDismiss={props.onDismissActive}
      />
    );
  }
  return <DraftView {...props} />;
}

function DraftView(props: {
  projects: Project[];
  multiAgent: MultiAgentState;
  onSetMode: (mode: 'chain' | 'orchestrator') => void;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  onRemoveParticipant: (projectId: number) => void;
  onReorderParticipant: (projectId: number, direction: 'up' | 'down') => void;
  onInstallBus: (projectId: number) => void;
  onUninstallBus: (projectId: number) => void;
  onSetDraftPrompt: (text: string) => void;
  onStartChain: () => void;
  onStartOrchestrator: () => void;
  onResumeSession: (sessionId: string) => void;
  wrapperErrorSeq: number;
  onRefreshIterations: () => void;
  onClearIterations: () => void;
  onSaveTemplate: (name: string) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (t: MultiAgentTemplate) => void;
}) {
  const { multiAgent, projects } = props;
  const participants = multiAgent.draftParticipants
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined);
  const [namingOpen, setNamingOpen] = useState(false);
  // In-flight signals for async WS round-trips. Cleared on success (this
  // view unmounts when a session becomes active) or on wrapperErrorSeq
  // bumping (the attempt failed and we stayed on the draft view).
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null);
  const [startPending, setStartPending] = useState<'chain' | 'orchestrator' | null>(null);
  const [clearPending, setClearPending] = useState(false);
  useEffect(() => {
    setPendingResumeId(null);
    setStartPending(null);
  }, [props.wrapperErrorSeq]);
  useEffect(() => {
    // Iterations list replaced (refresh / clear reply) — drop stale spinners.
    setPendingResumeId(null);
    setClearPending(false);
  }, [multiAgent.iterations]);

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    // The browser only fires `drop` if we preventDefault here — otherwise
    // it falls back to the default action (navigate to the URL of the data,
    // which is nonsense for our internal payload).
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    // Defensive kind check: a drop from another app/extension could also
    // ship JSON. Only accept our own dragstart payload.
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as { kind?: unknown }).kind !== 'cebab-project'
    ) {
      return;
    }
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== 'number') return;
    props.onAddParticipant(id);
  }

  const validation = validateDraft(participants, multiAgent);
  const chainReady = validation === null && multiAgent.mode === 'chain';
  const orchestratorReady = validation === null && multiAgent.mode === 'orchestrator';
  const promptReady = multiAgent.draftPrompt.trim().length > 0;

  return (
    <div className="multi-agent">
      <header className="multi-agent-header">
        <h2>Multi-agent</h2>
        <p className="multi-agent-subtitle">
          Drag projects from the sidebar to build a participant list, then pick a mode.
        </p>
      </header>

      <section className="multi-agent-section">
        <div className="iterations-header">
          <h3>Templates</h3>
          <div className="iterations-actions">
            <button
              className="ghost-btn"
              disabled={participants.length === 0}
              title={
                participants.length === 0
                  ? 'Add at least one participant before saving a template.'
                  : 'Save the current mode, lifecycle, and participant list as a reusable preset.'
              }
              onClick={() => setNamingOpen(true)}
            >
              Save current as template
            </button>
          </div>
        </div>
        {multiAgent.lastAppliedDropped > 0 && (
          <p className="multi-agent-warning">
            {multiAgent.lastAppliedDropped} participant
            {multiAgent.lastAppliedDropped === 1 ? '' : 's'} from this template
            {multiAgent.lastAppliedDropped === 1 ? ' is' : ' are'} no longer in the workspace and{' '}
            {multiAgent.lastAppliedDropped === 1 ? 'was' : 'were'} skipped.
          </p>
        )}
        <TemplatesList
          items={multiAgent.templates}
          projects={projects}
          onApply={props.onApplyTemplate}
          onDelete={props.onDeleteTemplate}
        />
      </section>

      <section className="multi-agent-section">
        <h3>Mode</h3>
        <div className="mode-pills" role="tablist">
          <button
            role="tab"
            aria-selected={multiAgent.mode === 'orchestrator'}
            className={`mode-pill ${multiAgent.mode === 'orchestrator' ? 'active' : ''}`}
            onClick={() => props.onSetMode('orchestrator')}
          >
            Orchestrator-routed
          </button>
          <button
            role="tab"
            aria-selected={multiAgent.mode === 'chain'}
            className={`mode-pill ${multiAgent.mode === 'chain' ? 'active' : ''}`}
            onClick={() => props.onSetMode('chain')}
          >
            Fixed chain
          </button>
        </div>
        <p className="mode-hint">
          {multiAgent.mode === 'orchestrator'
            ? 'A coordinator agent decides which participant handles each user prompt and replies when the request is fulfilled.'
            : 'Each iteration flows through participants in the order shown, top to bottom. The last hop writes a final reply that Cebab archives.'}
        </p>
      </section>

      <section className="multi-agent-section">
        <h3>Lifecycle</h3>
        <div className="mode-pills" role="tablist">
          <button
            role="tab"
            aria-selected={multiAgent.draftLifecycle === 'persistent'}
            className={`mode-pill ${multiAgent.draftLifecycle === 'persistent' ? 'active' : ''}`}
            onClick={() => props.onSetLifecycle('persistent')}
          >
            Persistent
          </button>
          <button
            role="tab"
            aria-selected={multiAgent.draftLifecycle === 'temp'}
            className={`mode-pill ${multiAgent.draftLifecycle === 'temp' ? 'active' : ''}`}
            onClick={() => props.onSetLifecycle('temp')}
          >
            Temp
          </button>
        </div>
        <p className="mode-hint">
          {multiAgent.draftLifecycle === 'persistent'
            ? 'Session folder survives End so the conversation can be resumed later. Bus install on participants stays in place. Pick this for ongoing work.'
            : 'On End, Cebab deletes the session folder AND removes bus integration from each participant. Pick this for a one-off task you don’t want to leave residue from.'}
        </p>
      </section>

      <section className="multi-agent-section">
        <h3>Participants</h3>
        <div
          className={`drop-zone ${participants.length === 0 ? 'empty' : ''}`}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {participants.length === 0 ? (
            <div className="drop-zone-placeholder">
              Drag a project here to add it as a participant.
            </div>
          ) : (
            <ol className="participant-list">
              {participants.map((p, i) => (
                <li key={p.id} className="participant-row">
                  <span className="participant-order">{i + 1}</span>
                  <div className="participant-meta">
                    <span className="participant-name">{p.name}</span>
                    {p.busInstalled ? (
                      <span
                        className="participant-bus-tag installed"
                        title={`Bus agent: ${p.busAgentName ?? '?'}`}
                      >
                        bus: {p.busAgentName}
                      </span>
                    ) : (
                      <span
                        className="participant-bus-tag missing"
                        title="This project has no bus integration installed yet."
                      >
                        no bus integration
                      </span>
                    )}
                  </div>
                  <div className="participant-actions">
                    {multiAgent.mode === 'chain' && (
                      <>
                        <button
                          className="icon-btn"
                          title="Move up"
                          disabled={i === 0}
                          onClick={() => props.onReorderParticipant(p.id, 'up')}
                        >
                          ↑
                        </button>
                        <button
                          className="icon-btn"
                          title="Move down"
                          disabled={i === participants.length - 1}
                          onClick={() => props.onReorderParticipant(p.id, 'down')}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    {p.busInstalled ? (
                      <button
                        className="ghost-btn"
                        title="Uninstall bus integration. This is pure DB metadata — Cebab wrote nothing into the project, so nothing in it is touched; the project just stops being eligible for multi-agent sessions."
                        onClick={() => props.onUninstallBus(p.id)}
                      >
                        Uninstall
                      </button>
                    ) : (
                      <button
                        className="primary-btn"
                        title="Install bus integration: pure DB metadata — Cebab assigns a stable agent slug and marks this project bus-eligible. Nothing is written into the project (no CLAUDE.md, no .claude/settings.json, no scripts). During multi-agent sessions this project's agent runs headless with bypassPermissions (tool calls auto-approved — no human-in-the-loop)."
                        onClick={() => {
                          const ok = window.confirm(
                            `Install bus integration for "${p.name}"?\n\n` +
                              'This is pure DB metadata: Cebab assigns a stable\n' +
                              'agent slug and marks the project bus-eligible.\n' +
                              'Nothing is written into the project itself.\n\n' +
                              "During multi-agent sessions this project's agent\n" +
                              'runs headless with `bypassPermissions` — tool calls\n' +
                              'are auto-approved (no human-in-the-loop).',
                          );
                          if (ok) props.onInstallBus(p.id);
                        }}
                      >
                        Install bus
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title="Remove from this draft"
                      onClick={() => props.onRemoveParticipant(p.id)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="multi-agent-section">
        <h3>Initial prompt</h3>
        <textarea
          className="multi-agent-prompt"
          placeholder={
            multiAgent.mode === 'chain'
              ? 'The task you want the chain to work on. Sent to the first participant as their initial input.'
              : 'The first prompt the orchestrator hears.'
          }
          value={multiAgent.draftPrompt}
          onChange={(e) => props.onSetDraftPrompt(e.target.value)}
        />
      </section>

      <section className="multi-agent-section">
        <h3>Start</h3>
        <div className="multi-agent-actions">
          <button
            className="primary-btn"
            disabled={!orchestratorReady || !promptReady || startPending !== null}
            title={
              orchestratorReady && promptReady
                ? "Starts the orchestrator plus one worker per participant, each its own in-process SDK agent. The orchestrator routes each user prompt to whichever worker fits, then replies to the user when it's done."
                : 'Pick orchestrator mode, add at least one bus-installed participant, and type an initial prompt.'
            }
            onClick={() => {
              setStartPending('orchestrator');
              props.onStartOrchestrator();
            }}
          >
            {startPending === 'orchestrator' ? (
              <>
                <span className="btn-spinner" />
                Starting…
              </>
            ) : (
              'Start orchestrator-routed'
            )}
          </button>
          <button
            className="primary-btn"
            disabled={!chainReady || !promptReady || startPending !== null}
            title={
              chainReady && promptReady
                ? 'Starts one in-process SDK agent per participant, rides the initial prompt on the first agent’s opening turn, and forwards each reply through the chain.'
                : 'Pick chain mode, add at least two bus-installed participants, and type an initial prompt.'
            }
            onClick={() => {
              setStartPending('chain');
              props.onStartChain();
            }}
          >
            {startPending === 'chain' ? (
              <>
                <span className="btn-spinner" />
                Starting…
              </>
            ) : (
              'Start fixed chain'
            )}
          </button>
        </div>
        {validation !== null && <p className="multi-agent-warning">{validation}</p>}
      </section>

      <section className="multi-agent-section">
        <div className="iterations-header">
          <h3>Iterations</h3>
          <div className="iterations-actions">
            <button
              className="ghost-btn iterations-refresh"
              onClick={props.onRefreshIterations}
              title="Re-query the server for past iterations. The list also auto-refreshes when a run ends."
            >
              Refresh
            </button>
            <button
              className="ghost-btn iterations-clear"
              // Disable when there's nothing to clear (loading or empty);
              // also disable if a session is currently running — the
              // server preserves the running row, so a click would be a
              // no-op, but the affordance reads as misleading.
              disabled={
                clearPending ||
                multiAgent.iterations === null ||
                multiAgent.iterations.length === 0 ||
                multiAgent.iterations.every((it) => it.status === 'running')
              }
              onClick={() => {
                const finished =
                  multiAgent.iterations?.filter((it) => it.status !== 'running').length ?? 0;
                // Browser-native confirm keeps this lightweight; no
                // custom modal needed for a destructive-but-recoverable
                // action (disk artifacts survive, so the operator can
                // still `cd` into transcripts on iterations they care
                // about). Confirm explicitly enumerates what runs:
                // DB row delete + disk preservation.
                if (
                  window.confirm(
                    `Clear ${finished} iteration${finished === 1 ? '' : 's'} from the list?\n\n` +
                      `Removes finished session rows (events + participants + the session itself) from the Cebab database. The active session, if any, is preserved.\n\n` +
                      `On-disk transcripts and iteration files inside each session folder stay where they are; you can still inspect them by path.`,
                  )
                ) {
                  setClearPending(true);
                  props.onClearIterations();
                }
              }}
              title="Remove finished iterations from the list (DB rows only). On-disk artifacts are preserved; the active session, if any, is kept."
            >
              {clearPending ? (
                <>
                  <span className="btn-spinner" />
                  Clearing…
                </>
              ) : (
                'Clear'
              )}
            </button>
          </div>
        </div>
        <IterationsList
          items={multiAgent.iterations}
          pendingResumeId={pendingResumeId}
          onResume={(sessionId) => {
            setPendingResumeId(sessionId);
            props.onResumeSession(sessionId);
          }}
        />
      </section>
      {namingOpen && (
        <TemplateNameModal
          existingNames={(multiAgent.templates ?? []).map((t) => t.name)}
          onClose={() => setNamingOpen(false)}
          onSave={(name) => {
            props.onSaveTemplate(name);
            setNamingOpen(false);
          }}
        />
      )}
    </div>
  );
}

function TemplatesList(props: {
  items: MultiAgentTemplate[] | null;
  projects: Project[];
  onApply: (t: MultiAgentTemplate) => void;
  onDelete: (id: string) => void;
}) {
  if (props.items === null) {
    return <p className="iterations-empty">Loading…</p>;
  }
  if (props.items.length === 0) {
    return (
      <p className="iterations-empty">
        No templates yet. Save a draft setup to reuse it without re-dragging.
      </p>
    );
  }
  return (
    <ol className="iterations-list">
      {props.items.map((t) => (
        <TemplateRow
          key={t.id}
          template={t}
          projects={props.projects}
          onApply={props.onApply}
          onDelete={props.onDelete}
        />
      ))}
    </ol>
  );
}

function TemplateRow(props: {
  template: MultiAgentTemplate;
  projects: Project[];
  onApply: (t: MultiAgentTemplate) => void;
  onDelete: (id: string) => void;
}) {
  const { template, projects } = props;
  const resolved = template.participants
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined);
  const unavailable = template.participants.length - resolved.length;
  const names = resolved.map((p) => p.name).join(' → ');
  return (
    <li className="iteration-row">
      <div className="iteration-head">
        <span className="iteration-id">{template.name}</span>
        <span className="iteration-mode">{template.mode}</span>
        <span className="run-status">{template.lifecycle}</span>
        <span className="iteration-when">
          {resolved.length} participant{resolved.length === 1 ? '' : 's'}
          {unavailable > 0 ? ` · ${unavailable} unavailable` : ''}
        </span>
      </div>
      <div className="iteration-participants">
        {names.length > 0 ? names : '(no resolvable participants)'}
      </div>
      <div className="iteration-path">
        <button className="ghost-btn" onClick={() => props.onApply(template)}>
          Apply
        </button>
        <button
          className="icon-btn"
          title="Delete template"
          onClick={() => props.onDelete(template.id)}
        >
          ×
        </button>
      </div>
    </li>
  );
}

function TemplateNameModal(props: {
  existingNames: string[];
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const canSave = trimmed.length > 0;
  const isDup = props.existingNames.includes(trimmed);
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Save as template</h2>
          <button className="icon-btn" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>
        <section>
          <label>
            <div className="label">Template name</div>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. security review chain"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) props.onSave(trimmed);
              }}
            />
          </label>
          <p className="hint">
            Saves the current mode, lifecycle, and participant list. The first prompt is never
            stored — you type it fresh each time.
          </p>
          {isDup && (
            <p className="hint warn">
              A template named <code>{trimmed}</code> already exists — saving overwrites it.
            </p>
          )}
        </section>
        <footer>
          <button className="ghost-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary-btn" disabled={!canSave} onClick={() => props.onSave(trimmed)}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

const STATUS_TITLE: Record<IterationSummary['status'], string> = {
  running:
    'Live — agents are running in-process. If this shows under past runs, Cebab lost its attachment; Resume reconnects (same server process only).',
  completed: 'Finished on its own — the run reached its final reply. Not resumable.',
  stopped: 'Ended by you via Stop — every agent was aborted. Not resumable.',
  crashed:
    "Lost — Cebab couldn't re-attach (the server restarted, a newer run superseded it, or a participant lost bus integration). Resumable only while the session is still live in the running server process.",
};

function IterationsList(props: {
  items: IterationSummary[] | null;
  pendingResumeId: string | null;
  onResume: (sessionId: string) => void;
}) {
  if (props.items === null) {
    return <p className="iterations-empty">Loading…</p>;
  }
  if (props.items.length === 0) {
    return <p className="iterations-empty">No iterations yet. Past runs will appear here.</p>;
  }
  return (
    <ol className="iterations-list">
      {props.items.map((it) => (
        <IterationRow
          key={it.sessionId}
          item={it}
          resuming={props.pendingResumeId === it.sessionId}
          onResume={props.onResume}
        />
      ))}
    </ol>
  );
}

function IterationRow(props: {
  item: IterationSummary;
  resuming: boolean;
  onResume: (sessionId: string) => void;
}) {
  const { item } = props;
  const [copied, setCopied] = useState(false);
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(item.artifactsDir);
      setCopied(true);
      // Reset the "copied" affordance after a short window so a second
      // copy feels distinct from the first.
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can fail under non-secure-context or denied
      // permissions. Leave the affordance idle; operator can read the
      // path text and copy manually.
    }
  }
  return (
    <li className={`iteration-row iteration-status-${item.status}`}>
      <div className="iteration-head">
        <span className="iteration-id">#{item.iterationId}</span>
        <span className="iteration-mode">{item.mode}</span>
        <span className={`run-status run-status-${item.status}`} title={STATUS_TITLE[item.status]}>
          {item.status}
        </span>
        <span className="iteration-when">
          {formatRelativeTime(item.startedAt)}
          {item.endedAt !== null && ` · ${formatDuration(item.endedAt - item.startedAt)}`}
        </span>
      </div>
      <div className="iteration-participants">
        {item.participantAgentNames.length === 0
          ? '(no participants recorded)'
          : item.mode === 'orchestrator'
            ? `${item.participantAgentNames[0]} ⟷ {${item.participantAgentNames.slice(1).join(', ')}}`
            : item.participantAgentNames.join(' → ')}
      </div>
      <div className="iteration-path">
        <code>{item.artifactsDir}</code>
        {item.resumable && (
          <button
            className="ghost-btn iteration-resume"
            disabled={props.resuming}
            title="Re-attach to this session while it's still live in the running server process. No agents are respawned — Cebab swaps the WS sink back onto the live in-process router and resumes streaming. Unavailable after a server restart."
            onClick={() => props.onResume(item.sessionId)}
          >
            {props.resuming ? (
              <>
                <span className="btn-spinner" />
                Resuming…
              </>
            ) : (
              'Resume'
            )}
          </button>
        )}
        <button
          className="ghost-btn iteration-copy"
          onClick={copyPath}
          title="Copy the iteration directory path to the clipboard. cd to it in a terminal to inspect transcripts and per-agent prompt/reply files."
        >
          {copied ? 'Copied' : 'Copy path'}
        </button>
      </div>
    </li>
  );
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

function ActiveRunView(props: {
  run: MultiAgentRun;
  projects: Project[];
  onStop: (sessionId: string) => void;
  onSendUserPrompt: (sessionId: string, text: string) => void;
  onSetLifecycle: (sessionId: string, lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (sessionId: string, projectId: number) => void;
  onDismiss: () => void;
}) {
  const { run } = props;
  const isRunning = run.status === 'running';
  const isOrchestrator = run.mode === 'orchestrator';
  const isTemp = run.lifecycle === 'temp';
  // Stop is in-flight until the run leaves 'running' (server's
  // multi_agent_ended — or the synthetic 'crashed' if stop threw), at which
  // point this whole button is replaced by Dismiss, so no clearing needed.
  const [stopPending, setStopPending] = useState(false);

  function handleStop() {
    if (!isTemp) {
      // Persistent: stop is non-destructive (folder + installs survive).
      // No confirm needed.
      setStopPending(true);
      props.onStop(run.sessionId);
      return;
    }
    // Temp: warn before nuking. Workers count = participants minus
    // orchestrator entry for orchestrator mode.
    const workerCount = isOrchestrator
      ? Math.max(0, run.participantAgentNames.length - 1)
      : run.participantAgentNames.length;
    const ok = window.confirm(
      `End this temp session?\n\nCebab will:\n  • Clear bus integration from ${workerCount} participant${
        workerCount === 1 ? '' : 's'
      } (DB flag only)\n  • Delete the session folder at ${run.sessionFolder}\n\nPersisted events in the database stay; on-disk artifacts (transcripts, iteration files) are wiped.`,
    );
    if (ok) {
      setStopPending(true);
      props.onStop(run.sessionId);
    }
  }

  return (
    <div className="multi-agent">
      <header className="multi-agent-header multi-agent-active-header">
        <div>
          <h2>
            Multi-agent: <code>{run.sessionId.slice(0, 8)}</code>{' '}
            <span
              className={`run-status run-status-${run.status}`}
              title={STATUS_TITLE[run.status]}
            >
              {run.status}
            </span>
          </h2>
        </div>
        <div className="multi-agent-active-actions">
          {isRunning ? (
            <button
              className="primary-btn"
              disabled={stopPending}
              onClick={handleStop}
              title={
                isTemp
                  ? "End & cleanup: abort every agent's in-process query, clear bus integration from each participant (DB flag), then rm-rf the session folder. You'll be asked to confirm."
                  : 'Abort every agent’s in-process query and tear the session down. Folder + bus installs stay so you can resume later (same server process only).'
              }
            >
              {stopPending ? (
                <>
                  <span className="btn-spinner" />
                  Stopping…
                </>
              ) : isTemp ? (
                'End & cleanup'
              ) : (
                'Stop'
              )}
            </button>
          ) : (
            <button
              className="ghost-btn"
              onClick={props.onDismiss}
              title="Clear the scrollback and return to the draft view. Iteration artifacts on disk are unaffected."
            >
              Close
            </button>
          )}
        </div>
      </header>

      <SessionSettingsPanel
        run={run}
        projects={props.projects}
        canEdit={isRunning && isOrchestrator}
        onSetLifecycle={(lifecycle) => props.onSetLifecycle(run.sessionId, lifecycle)}
        onAddParticipant={(projectId) => props.onAddParticipant(run.sessionId, projectId)}
      />

      <section className="multi-agent-section">
        <h3>Scrollback</h3>
        {run.events.length === 0 ? (
          <p className="iterations-empty">
            Waiting for the first event.{' '}
            {isOrchestrator
              ? "The orchestrator agent is starting up; it'll receive the roster + first prompt momentarily."
              : 'The first participant agent is starting up.'}
          </p>
        ) : (
          <ol className="event-list">
            {run.events.map((ev) => (
              <EventRow key={ev.eventId} event={ev} />
            ))}
          </ol>
        )}
      </section>

      {isOrchestrator && isRunning && (
        <UserPromptInput onSend={(text) => props.onSendUserPrompt(run.sessionId, text)} />
      )}
    </div>
  );
}

/**
 * Active-session info + the one editable runtime knob (lifecycle).
 *
 * The lifecycle toggle is only editable while the session is running AND
 * in orchestrator mode — chain handles don't expose `setLifecycle` in
 * v1, and once the session has ended, toggling the value has no effect
 * (teardown has already decided whether to run the cleanup). The pair
 * is rendered as a button-pair so the operator can see both states at
 * once with the active one highlighted.
 *
 * Everything else (mode, participants, sessionFolder, iterationId) is
 * read-only — exposes what was set at start so the operator can
 * copy/inspect.
 */
function SessionSettingsPanel(props: {
  run: MultiAgentRun;
  projects: Project[];
  canEdit: boolean;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
}) {
  const { run } = props;
  const isOrchestrator = run.mode === 'orchestrator';
  const orchestratorSlug = isOrchestrator ? (run.participantAgentNames[0] ?? 'orchestrator') : null;
  const workerSlugs = isOrchestrator
    ? run.participantAgentNames.slice(1)
    : run.participantAgentNames;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Project id currently in flight for addWorker, cleared once the
  // server's `multi_agent_participant_added` echo lands (signaled by
  // the agent name appearing in participantAgentNames). Used to gate
  // the Add buttons + show a small spinner.
  const [pendingAddId, setPendingAddId] = useState<number | null>(null);
  const currentAgentNames = new Set(run.participantAgentNames);
  // A project is eligible to add IFF its current agent slug (if it has
  // bus installed) is NOT already a participant. Not-installed projects
  // are eligible — the server auto-installs during add.
  const eligibleProjects = props.projects.filter((p) => {
    if (p.busInstalled && p.busAgentName && currentAgentNames.has(p.busAgentName)) {
      return false;
    }
    return true;
  });
  // When the server's `multi_agent_participant_added` echo lands, the
  // reducer appends the new agent name to participantAgentNames. We
  // notice by checking whether the pending project's agent slug is in
  // the current set; on a match, clear the pending state and close
  // the picker.
  useEffect(() => {
    if (pendingAddId === null) return;
    const pending = props.projects.find((p) => p.id === pendingAddId);
    if (pending?.busAgentName && run.participantAgentNames.includes(pending.busAgentName)) {
      setPendingAddId(null);
      setPickerOpen(false);
    }
  }, [pendingAddId, props.projects, run.participantAgentNames]);
  function handleAddClick(projectId: number) {
    setPendingAddId(projectId);
    props.onAddParticipant(projectId);
  }
  return (
    <section className="multi-agent-section multi-agent-settings">
      <h3>Session info</h3>
      <dl className="settings-grid">
        <dt>Mode</dt>
        <dd>{run.mode}</dd>

        <dt>Lifecycle</dt>
        <dd>
          <div className="lifecycle-toggle" role="group" aria-label="Lifecycle">
            <button
              type="button"
              className={`lifecycle-btn ${run.lifecycle === 'persistent' ? 'active' : ''}`}
              disabled={!props.canEdit || run.lifecycle === 'persistent'}
              onClick={() => props.onSetLifecycle('persistent')}
              title="Session folder and bus installs survive End. The run can be resumed later."
            >
              persistent
            </button>
            <button
              type="button"
              className={`lifecycle-btn ${run.lifecycle === 'temp' ? 'active' : ''}`}
              disabled={!props.canEdit || run.lifecycle === 'temp'}
              onClick={() => props.onSetLifecycle('temp')}
              title="On End: rm-rf the session folder AND uninstall bus from each participant. One-off runs without residue."
            >
              temp
            </button>
          </div>
          {!props.canEdit && run.mode === 'chain' && (
            <p className="settings-hint">Chain-mode sessions can't change lifecycle mid-run.</p>
          )}
        </dd>

        <dt>Participants</dt>
        <dd>
          <ul className="settings-participants">
            {isOrchestrator && orchestratorSlug && (
              <li className="settings-participant settings-participant-hub">
                <code>{orchestratorSlug}</code> <span className="hint">(hub)</span>
              </li>
            )}
            {workerSlugs.map((slug, i) => (
              <li key={slug} className="settings-participant">
                <code>{slug}</code>
                {!isOrchestrator && i < workerSlugs.length - 1 && (
                  <span className="settings-arrow">→</span>
                )}
              </li>
            ))}
          </ul>
          {props.canEdit && (
            <div className="add-participant">
              <button
                type="button"
                className="ghost-btn add-participant-btn"
                onClick={() => setPickerOpen((open) => !open)}
                aria-expanded={pickerOpen}
                title="Add another worker to this orchestrator session. Bus integration is auto-installed if missing."
              >
                {pickerOpen ? 'Cancel' : '+ Add agent'}
              </button>
              {pickerOpen && (
                <AddParticipantPicker
                  eligibleProjects={eligibleProjects}
                  pendingId={pendingAddId}
                  onPick={handleAddClick}
                />
              )}
            </div>
          )}
        </dd>

        <dt>Session folder</dt>
        <dd>
          <code>{run.sessionFolder}</code>
        </dd>

        {run.iterationId && (
          <>
            <dt>Iteration</dt>
            <dd>
              <code>{run.iterationId}</code>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

/**
 * Inline picker for adding a worker to a running orchestrator session.
 *
 * Renders the eligible projects (those not already participating) as a
 * list. Each row shows the project name + agent slug (or "(will be
 * installed)" if bus isn't set up yet) and an Add button. Clicking Add
 * fires `onPick(projectId)`, which the parent forwards via WS; while
 * the request is in flight that row's button switches to a spinner
 * label and disables the rest of the list.
 *
 * The picker is intentionally non-modal — it slides open under the
 * Add button and disappears when the operator clicks Cancel or when
 * the participants list grows past the pending project (handled by the
 * parent's pending-tracking).
 */
function AddParticipantPicker(props: {
  eligibleProjects: Project[];
  pendingId: number | null;
  onPick: (projectId: number) => void;
}) {
  if (props.eligibleProjects.length === 0) {
    return (
      <p className="settings-hint add-participant-empty">
        No eligible projects. Every project in the workspace is already a participant in this
        session.
      </p>
    );
  }
  const isPending = props.pendingId !== null;
  return (
    <ul className="add-participant-list">
      {props.eligibleProjects.map((p) => {
        const isThis = props.pendingId === p.id;
        const installed = p.busInstalled && p.busAgentName !== null;
        return (
          <li key={p.id} className="add-participant-row">
            <div className="add-participant-meta">
              <span className="add-participant-name">{p.name}</span>
              <span className="add-participant-agent">
                {installed ? (
                  <code>{p.busAgentName}</code>
                ) : (
                  <span className="hint">bus will be installed on add</span>
                )}
              </span>
            </div>
            <button
              type="button"
              className="ghost-btn add-participant-pick-btn"
              disabled={isPending}
              onClick={() => props.onPick(p.id)}
              title={
                installed
                  ? `Register ${p.busAgentName} as a new in-process agent and notify the orchestrator.`
                  : `Install bus integration for ${p.name} (DB metadata), then register its agent and notify the orchestrator.`
              }
            >
              {isThis ? 'Adding…' : 'Add'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Text input for sending a user prompt to the active orchestrator session.
 * Local state holds the in-progress text; on submit we forward it up and
 * clear. Enter sends, Shift+Enter inserts a newline — same convention as
 * the regular chat InputBox.
 */
function UserPromptInput(props: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    props.onSend(trimmed);
    setText('');
  }
  return (
    <section className="multi-agent-section multi-agent-input-section">
      <h3>Send a prompt</h3>
      <div className="multi-agent-input">
        <textarea
          className="multi-agent-input-textarea"
          placeholder="Type a message for the orchestrator. It'll route to whichever worker fits."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="primary-btn"
          onClick={submit}
          disabled={text.trim().length === 0}
          title="Delivered as a `prompt` from `cebab` on the orchestrator's next turn. The orchestrator then routes it to a participant."
        >
          Send
        </button>
      </div>
    </section>
  );
}

function EventRow(props: { event: MultiAgentEventView }) {
  const { event } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={`event-row event-kind-${event.kind}`}>
      <div className="event-head">
        <button
          className="icon-btn event-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Show message' : 'Hide message (metadata only)'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="event-source">{event.source}</span>
        <span className="event-arrow">→</span>
        <span className="event-destination">{event.destination}</span>
        <span className="event-kind">{event.kind}</span>
        <span className="event-ts">{formatTs(event.ts)}</span>
        <button
          className="icon-btn event-expand"
          onClick={() => setExpanded(true)}
          title="Open in larger window"
        >
          ⤢
        </button>
      </div>
      {!collapsed && (
        <div className="event-text">
          <Markdown text={event.text} />
        </div>
      )}
      {expanded && <EventModal event={event} onClose={() => setExpanded(false)} />}
    </li>
  );
}

function EventModal(props: { event: MultiAgentEventView; onClose: () => void }) {
  const { event } = props;
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal event-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            {event.source} → {event.destination} · {event.kind} · {formatTs(event.ts)}
          </h2>
          <button className="icon-btn" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>
        <section>
          <Markdown text={event.text} />
        </section>
      </div>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Returns a human-friendly validation message, or null when the draft is
 * ready to start (the relevant Start button can be enabled).
 *
 * Mode-specific minimums:
 *   - chain: ≥2 participants (a 1-step "chain" doesn't pipeline anything).
 *   - orchestrator: ≥1 worker (the orchestrator itself is implicit; one
 *     worker is degenerate but functional for smoke testing).
 */
function validateDraft(participants: Project[], multiAgent: MultiAgentState): string | null {
  if (participants.length === 0) return 'Add at least one participant.';
  if (multiAgent.mode === 'chain' && participants.length < 2) {
    return 'Fixed chain needs at least two participants.';
  }
  const missing = participants.filter((p) => !p.busInstalled).map((p) => p.name);
  if (missing.length > 0) {
    return `Install bus integration for: ${missing.join(', ')}.`;
  }
  return null;
}
