import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  IterationSummary,
  MultiAgentLifecycle,
  MultiAgentTemplate,
  Project,
} from '@cebab/shared/protocol';
import type { MultiAgentEventView, MultiAgentRun, MultiAgentState } from '../store';
import { GrowTextarea } from './GrowTextarea';
import { Markdown } from './Markdown';
import { useModalKeys } from '../useModalKeys';

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
  /** The active tab IS the mode: orchestrator (Multi-Agent) or chain (Chained Chat). */
  mode: 'chain' | 'orchestrator';
  projects: Project[];
  multiAgent: MultiAgentState;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  onRemoveParticipant: (projectId: number) => void;
  onReorderParticipant: (projectId: number, direction: 'up' | 'down') => void;
  onInstallBus: (projectId: number) => void;
  onUninstallBus: (projectId: number) => void;
  onSetDraftPrompt: (text: string) => void;
  onStart: () => void;
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
  onSaveTemplate: (name: string, mode: 'chain' | 'orchestrator') => void;
  onUpdateTemplateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (t: MultiAgentTemplate) => void;
}) {
  const { multiAgent, projects } = props;
  if (multiAgent.active) {
    return (
      <ActiveRunView
        run={multiAgent.active}
        tabMode={props.mode}
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
  mode: 'chain' | 'orchestrator';
  projects: Project[];
  multiAgent: MultiAgentState;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  onRemoveParticipant: (projectId: number) => void;
  onReorderParticipant: (projectId: number, direction: 'up' | 'down') => void;
  onInstallBus: (projectId: number) => void;
  onUninstallBus: (projectId: number) => void;
  onSetDraftPrompt: (text: string) => void;
  onStart: () => void;
  onResumeSession: (sessionId: string) => void;
  wrapperErrorSeq: number;
  onRefreshIterations: () => void;
  onClearIterations: () => void;
  onSaveTemplate: (name: string, mode: 'chain' | 'orchestrator') => void;
  onUpdateTemplateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
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

  const [iterOpen, setIterOpen] = useState(false);
  const validation = validateDraft(participants, props.mode);
  const startReady = validation === null && multiAgent.draftPrompt.trim().length > 0;
  const isOrch = props.mode === 'orchestrator';
  const tabTemplates =
    multiAgent.templates === null
      ? null
      : multiAgent.templates.filter((t) => t.mode === props.mode);
  const tabIterations =
    multiAgent.iterations === null
      ? null
      : multiAgent.iterations.filter((it) => it.mode === props.mode);
  const clearableCount = (tabIterations ?? []).filter((it) => it.status !== 'running').length;

  return (
    <div className="multi-agent multi-agent-draft">
      <div className="multi-agent-draft-body">
        <header className="multi-agent-header">
          <h2>{isOrch ? 'Multi-Agent' : 'Chained Chat'}</h2>
          <p className="multi-agent-subtitle">
            {isOrch
              ? 'A coordinator agent routes each prompt to whichever participant fits, then replies when the request is done. Drag projects from the sidebar to add workers.'
              : 'Each turn flows through the participants in order, top to bottom. The last writes the final reply Cebab archives. Drag projects from the sidebar to build the chain.'}
          </p>
        </header>

        <section className="multi-agent-section">
          <div className="iterations-header">
            <h3>Templates</h3>
          </div>
          {multiAgent.lastAppliedDropped > 0 && (
            <p className="multi-agent-warning">
              {multiAgent.lastAppliedDropped} participant
              {multiAgent.lastAppliedDropped === 1 ? '' : 's'} from this template
              {multiAgent.lastAppliedDropped === 1 ? ' is' : ' are'} no longer in the workspace and{' '}
              {multiAgent.lastAppliedDropped === 1 ? 'was' : 'were'} skipped.
            </p>
          )}
          <TemplatesPanel
            items={tabTemplates}
            mode={props.mode}
            projects={projects}
            onApply={props.onApplyTemplate}
            onDelete={props.onDeleteTemplate}
            onUpdateRoles={props.onUpdateTemplateRoles}
          />
        </section>

        <section className="multi-agent-section">
          <div className="iterations-header">
            <h3>Participants</h3>
            <div className="iterations-actions">
              <button
                className="ghost-btn"
                disabled={participants.length === 0}
                title={
                  participants.length === 0
                    ? 'Add at least one participant before saving a template.'
                    : 'Save the current participant list + lifecycle as a reusable preset for this tab.'
                }
                onClick={() => setNamingOpen(true)}
              >
                Save current as template
              </button>
            </div>
          </div>
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
                      {props.mode === 'chain' && (
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
          <div className="ma-lifecycle-inline">
            <span className="ma-lifecycle-label">Lifecycle</span>
            <div className="lifecycle-toggle" role="group" aria-label="Lifecycle">
              <button
                className={`lifecycle-btn ${multiAgent.draftLifecycle === 'persistent' ? 'active' : ''}`}
                onClick={() => props.onSetLifecycle('persistent')}
                title="Persistent: session folder survives End so the conversation can be resumed later; bus install on participants stays in place. Pick this for ongoing work."
              >
                persistent
              </button>
              <button
                className={`lifecycle-btn ${multiAgent.draftLifecycle === 'temp' ? 'active' : ''}`}
                onClick={() => props.onSetLifecycle('temp')}
                title="Temp: on End, Cebab deletes the session folder AND removes bus integration from each participant. Pick this for a one-off task you don’t want to leave residue from."
              >
                temp
              </button>
            </div>
          </div>
        </section>

        <section className="multi-agent-section">
          <div className="iterations-header iterations-collapsible">
            <button
              className="iterations-toggle"
              onClick={() => setIterOpen((o) => !o)}
              aria-expanded={iterOpen}
              title="Past runs on this tab. Resume re-attaches to a still-live session; Copy path opens transcripts."
            >
              <span className="iterations-chevron">{iterOpen ? '▾' : '▸'}</span>
              <h3>Iterations</h3>
              <span className="iterations-count">
                {tabIterations === null
                  ? ''
                  : tabIterations.length === 0
                    ? 'none'
                    : tabIterations.length}
              </span>
            </button>
            {iterOpen && (
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
                  disabled={clearPending || tabIterations === null || clearableCount === 0}
                  onClick={() => {
                    // Browser-native confirm keeps this lightweight; disk
                    // artifacts survive, so this is destructive-but-recoverable.
                    if (
                      window.confirm(
                        `Clear ${clearableCount} iteration${clearableCount === 1 ? '' : 's'} from the list?\n\n` +
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
            )}
          </div>
          {iterOpen && (
            <IterationsList
              items={tabIterations}
              pendingResumeId={pendingResumeId}
              onResume={(sessionId) => {
                setPendingResumeId(sessionId);
                props.onResumeSession(sessionId);
              }}
            />
          )}
        </section>
      </div>

      {validation !== null && (
        <p className="multi-agent-warning multi-agent-warning-composer">{validation}</p>
      )}
      <MultiAgentComposer
        mode={props.mode}
        value={multiAgent.draftPrompt}
        onChange={props.onSetDraftPrompt}
        pending={startPending !== null}
        disabled={!startReady}
        onStart={() => {
          setStartPending(props.mode);
          props.onStart();
        }}
      />

      {namingOpen && (
        <TemplateNameModal
          existingNames={(multiAgent.templates ?? []).map((t) => t.name)}
          onClose={() => setNamingOpen(false)}
          onSave={(name) => {
            props.onSaveTemplate(name, props.mode);
            setNamingOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MultiAgentComposer(props: {
  mode: 'chain' | 'orchestrator';
  value: string;
  onChange: (t: string) => void;
  onStart: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  const blocked = props.disabled || props.pending;
  const isChain = props.mode === 'chain';
  return (
    <div className="input-box multi-agent-composer">
      <GrowTextarea
        value={props.value}
        onChange={props.onChange}
        onSubmit={() => {
          if (!blocked) props.onStart();
        }}
        placeholder={
          isChain
            ? 'The task for the chain — sent to the first participant. Enter to start, Shift+Enter for newline.'
            : 'The first prompt the orchestrator hears. Enter to start, Shift+Enter for newline.'
        }
        ariaLabel="Initial prompt"
      />
      <button
        className="primary-btn"
        disabled={blocked}
        onClick={props.onStart}
        title={
          props.disabled
            ? isChain
              ? 'Add at least two bus-installed participants and type an initial prompt.'
              : 'Add at least one bus-installed participant and type an initial prompt.'
            : isChain
              ? 'Start one in-process SDK agent per participant; the initial prompt rides the first agent’s opening turn and each reply forwards down the chain.'
              : 'Start the orchestrator plus one worker per participant. The orchestrator routes each prompt to whichever worker fits, then replies when done.'
        }
      >
        {props.pending ? (
          <>
            <span className="btn-spinner" />
            Starting…
          </>
        ) : isChain ? (
          'Start chain'
        ) : (
          'Start'
        )}
      </button>
    </div>
  );
}

/**
 * Templates browser — a master-detail pane. Left: a narrow list of saved
 * templates (name + agent count only). Right: the selected template's
 * architecture preview (SVG diagram + flowing dot + per-agent role
 * editors). Selection is derived, not asserted, so deleting the selected
 * template self-heals to the first remaining one with no dangling id.
 */
function TemplatesPanel(props: {
  items: MultiAgentTemplate[] | null;
  mode: 'chain' | 'orchestrator';
  projects: Project[];
  onApply: (t: MultiAgentTemplate) => void;
  onDelete: (id: string) => void;
  onUpdateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (props.items === null) {
    return <p className="iterations-empty">Loading…</p>;
  }
  if (props.items.length === 0) {
    return (
      <p className="iterations-empty">
        No {props.mode === 'chain' ? 'chained-chat' : 'multi-agent'} templates yet. Save a setup to
        reuse it without re-dragging.
      </p>
    );
  }
  const items = props.items;
  // Derive, don't assert: an explicit click sticks via selectedId, but a
  // deleted/filtered-out selection falls back to the first template.
  const selected = items.find((t) => t.id === selectedId) ?? items[0];
  if (!selected) return null; // unreachable: items is non-empty here

  return (
    <div className="tpl-panel">
      <TemplateMasterList
        items={items}
        projects={props.projects}
        selectedId={selected.id}
        onSelect={setSelectedId}
        onDelete={props.onDelete}
      />
      <TemplatePreview
        key={selected.id}
        template={selected}
        projects={props.projects}
        onApply={props.onApply}
        onUpdateRoles={props.onUpdateRoles}
      />
    </div>
  );
}

function TemplateMasterList(props: {
  items: MultiAgentTemplate[];
  projects: Project[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <ul className="tpl-master">
      {props.items.map((t) => (
        <TemplateListItem
          key={t.id}
          template={t}
          projects={props.projects}
          selected={t.id === props.selectedId}
          onSelect={props.onSelect}
          onDelete={props.onDelete}
        />
      ))}
    </ul>
  );
}

function TemplateListItem(props: {
  template: MultiAgentTemplate;
  projects: Project[];
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { template, projects } = props;
  const resolvedCount = template.participants.filter((id) =>
    projects.some((p) => p.id === id),
  ).length;
  const unavailable = template.participants.length - resolvedCount;
  const countLabel = `${resolvedCount} agent${resolvedCount === 1 ? '' : 's'}${
    unavailable > 0 ? `, ${unavailable} unavailable` : ''
  }`;
  return (
    <li className={`tpl-item ${props.selected ? 'is-selected' : ''}`}>
      <button
        className="tpl-item-main"
        onClick={() => props.onSelect(template.id)}
        aria-current={props.selected ? 'true' : undefined}
        title={`${template.name} — ${countLabel}`}
      >
        <span className="tpl-item-name">{template.name}</span>
        <span className="tpl-item-count" aria-label={countLabel}>
          {resolvedCount}
        </span>
      </button>
      <button
        className="tpl-item-del"
        title="Delete template"
        aria-label="Delete template"
        onClick={() => props.onDelete(template.id)}
      >
        ×
      </button>
    </li>
  );
}

/** Clip an SVG text label (SVG text has no auto-ellipsis); full name
 * still shows in the role list and the node's <title> tooltip. */
function truncLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Wrap `text` into ≤2 lines of ~`perLine` chars for an SVG role label
 * (SVG <text> has no wrapping). Roles can be one long space-less token, so
 * this is char-based; if a space sits within the last BREAK_SLACK chars
 * before the cut we break there for a nicer wrap. Line 2 is ellipsised
 * (truncLabel) only when text still remains past the 2-line budget. Full
 * text always stays in the node <title> + the click-to-edit overlay. */
function wrap2(text: string, perLine: number): [string] | [string, string] {
  const per = Math.max(1, perLine);
  if (text.length <= per) return [text];
  const BREAK_SLACK = 8;
  let cut = per;
  const sp = text.lastIndexOf(' ', per);
  if (sp >= per - BREAK_SLACK && sp > 0) cut = sp;
  const rest = text.slice(cut === sp ? cut + 1 : cut);
  return [text.slice(0, cut), truncLabel(rest, per)];
}

/** The trimmed role text for an agent (whitespace-only ⇒ empty). */
function roleOf(roles: Record<string, string>, id: number): string {
  return (roles[String(id)] ?? '').trim();
}

// Estimate-only text sizing (no DOM measurement / reflow / font-load
// wait): chars × fontSize × a per-font factor. Mild imprecision is fine —
// tiles are clamped and each line is ellipsised to the final width.
const FACTOR_SANS = 0.58;
const FACTOR_BOLD = 0.62;
const TILE_PAD_X = 10;
const ROLE_PLACEHOLDER = 'Role / goal…';

// Stage square side as a function of agent count: small (the diagram
// meet-scales up to fill it, so tiles read big) for a few agents, growing
// per agent up to a hard cap — past the cap more agents meet-scale the
// text down rather than growing the square unbounded.
const SQ_BASE = 320;
const SQ_STEP = 26;
const SQ_CAP = 460;

function estTextW(text: string, fontSize: number, factor: number): number {
  return text.length * fontSize * factor;
}

/** Inverse of estTextW: max chars that fit in `maxPx`. Floors and guards
 * ≥1 so truncLabel (which slices max-1) always gets a sane positive max. */
function fitChars(maxPx: number, fontSize: number, factor: number): number {
  return Math.max(1, Math.floor(maxPx / (fontSize * factor)));
}

/** Tile width sized so the name fits one line and the role fits in ≤2
 * lines (≈half the single-line role estimate, since it wraps), clamped to
 * [minW, maxW]. Empty role uses the placeholder so empty tiles aren't
 * hairline-thin. */
function tileWidth(
  name: string,
  role: string,
  fsizes: { name: number; role: number },
  minW: number,
  maxW: number,
): number {
  const roleForSize = role || ROLE_PLACEHOLDER;
  const roleHalfW = estTextW(roleForSize, fsizes.role, FACTOR_SANS) / 2;
  const content = Math.max(estTextW(name, fsizes.name, FACTOR_BOLD), roleHalfW);
  return Math.round(Math.min(Math.max(minW, content + 2 * TILE_PAD_X), maxW));
}

/**
 * SVG architecture diagram for a template preview: orchestrator
 * hub-and-spoke or a left→right chain, with one calm "message" dot
 * flowing a representative connector path. Geometry is computed for
 * arbitrary N (the mockup hardcoded 3); a fixed-height viewBox + computed
 * width keeps labels legible (the .tpl-stage scrolls when wide). The dot
 * is a CSS Motion Path animation (not SMIL) so it lives in the same
 * prefers-reduced-motion blocks as every other animation; a JS
 * reduced-motion guard also drops the dot element belt-and-braces.
 * No diagram library — crisp, scalable, dependency-free.
 */
function AgentDiagram(props: {
  mode: 'chain' | 'orchestrator';
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  /** Called only when a cell is committed via the Enter key, so the parent
   *  can return focus to the pane (next Enter → Save roles / Apply). Not
   *  called on blur/scroll close — grabbing focus back then is intrusive. */
  onAfterCommit?: () => void;
}) {
  const { participants, mode, roles, onRoleChange } = props;
  const n = participants.length;

  // Click-to-edit overlay. Hooks must precede the n===0 early return
  // (Rules of Hooks). The editor is one absolutely-positioned <textarea>
  // in the (position:relative) .tpl-stage, placed from the clicked node's
  // getBoundingClientRect — scale-proof, so the SVG stays responsive.
  // Live values are mirrored into refs so the scroll/resize listener
  // commits the latest text without re-subscribing per keystroke.
  const stageRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const editingIdRef = useRef<number | null>(null);
  const draftRef = useRef('');
  const onRoleChangeRef = useRef(onRoleChange);
  editingIdRef.current = editingId;
  draftRef.current = draft;
  onRoleChangeRef.current = onRoleChange;
  useLayoutEffect(() => {
    if (editingId != null && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editingId]);
  useEffect(() => {
    if (editingId == null) return;
    const stage = stageRef.current;
    // Commit-and-close on scroll/resize: the responsive SVG re-lays-out
    // and .tpl-stage scrolls, so the cached box would drift. Text is
    // never lost (committed); the user re-clicks to keep editing.
    const close = () => {
      const id = editingIdRef.current;
      if (id != null) {
        onRoleChangeRef.current(id, draftRef.current);
        setEditingId(null);
        setBox(null);
      }
    };
    stage?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      stage?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [editingId]);

  if (n === 0) {
    return <div className="tpl-diagram-empty">(no resolvable participants)</div>;
  }
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const squarePx = Math.min(SQ_CAP, SQ_BASE + (n - 1) * SQ_STEP);

  function commitIfEditing() {
    if (editingId != null) {
      onRoleChange(editingId, draft);
      setEditingId(null);
      setBox(null);
    }
  }
  function cancelEditing() {
    setEditingId(null);
    setBox(null);
  }
  function openEditor(pid: number, gEl: SVGGElement) {
    // Switching nodes mid-edit commits the current one first.
    commitIfEditing();
    const stage = stageRef.current;
    if (!stage) return;
    const g = gEl.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    setBox({
      left: g.left - s.left + stage.scrollLeft,
      top: g.top - s.top + stage.scrollTop,
      width: g.width,
      height: g.height,
    });
    setDraft(roles[String(pid)] ?? '');
    setEditingId(pid);
  }
  const editor =
    editingId != null && box ? (
      <textarea
        ref={taRef}
        className="tpl-role-edit"
        style={{
          left: box.left,
          top: box.top,
          width: Math.max(box.width, 140),
          minHeight: box.height,
        }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitIfEditing}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelEditing();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commitIfEditing();
            props.onAfterCommit?.();
          }
          // Shift+Enter falls through → newline (multi-line role)
        }}
        placeholder="Role / goal…"
        aria-label="Edit role"
        spellCheck={false}
      />
    ) : null;

  if (mode === 'orchestrator') {
    const GAP = 10;
    const SIDE_PAD = 14;
    const HUB_H = 30;
    const HUB_Y = 20;
    const HY = 52;
    const midY = 70;
    const WORKER_Y = 88;
    const WORKER_H = 56;
    const HEIGHT = 150;
    const FS_NAME = 11;
    const FS_ROLE = 10;
    const MIN_W = 96;
    const MAX_W = 168;
    const ROLE_Y1 = WORKER_Y + 30;
    const ROLE_Y2 = WORKER_Y + 42;
    const fsizes = { name: FS_NAME, role: FS_ROLE };
    let acc = SIDE_PAD;
    const laid = participants.map((p) => {
      const role = roleOf(roles, p.id);
      const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
      const t = { p, role, x: acc, w: tw };
      acc += tw + GAP;
      return t;
    });
    const rowW = acc - GAP - SIDE_PAD;
    const width = rowW + 2 * SIDE_PAD;
    const HX = SIDE_PAD + rowW / 2;
    const HUB_W = Math.round(Math.max(96, estTextW('orchestrator', 11, FACTOR_BOLD) + 24));
    const edgePath = (cx: number) =>
      Math.abs(cx - HX) < 0.5
        ? `M${HX} ${HY} V${WORKER_Y}`
        : `M${HX} ${HY} V${midY} H${cx} V${WORKER_Y}`;
    const first = laid[0];
    const firstEdge = first ? edgePath(first.x + first.w / 2) : null;
    return (
      <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
        <svg
          className="tpl-svg"
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Orchestrator routing to ${n} worker${n === 1 ? '' : 's'}`}
        >
          {laid.map(({ p, x, w }) => (
            <path key={`e${p.id}`} className="tpl-edge" d={edgePath(x + w / 2)} />
          ))}
          <rect
            className="tpl-hub-rect"
            x={HX - HUB_W / 2}
            y={HUB_Y}
            width={HUB_W}
            height={HUB_H}
            rx={8}
          />
          <text
            className="tpl-hub-text"
            x={HX}
            y={HUB_Y + 14}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
          >
            orchestrator
          </text>
          <text className="tpl-node-slug" x={HX} y={HUB_Y + 24} textAnchor="middle" fontSize={8.5}>
            cebab
          </text>
          {laid.map(({ p, role, x, w }) => {
            const cx = x + w / 2;
            const innerW = w - 2 * TILE_PAD_X;
            const roleText = role || ROLE_PLACEHOLDER;
            return (
              <g
                key={`w${p.id}`}
                data-pid={p.id}
                role="button"
                tabIndex={0}
                aria-label={`Edit role for ${p.name}`}
                onClick={(e) => openEditor(p.id, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEditor(p.id, e.currentTarget);
                  }
                }}
              >
                <title>{role ? `${p.name} — ${role}` : p.name}</title>
                <rect
                  className="tpl-node-rect"
                  x={x}
                  y={WORKER_Y}
                  width={w}
                  height={WORKER_H}
                  rx={8}
                />
                <text
                  className="tpl-node-name"
                  x={cx}
                  y={WORKER_Y + 16}
                  textAnchor="middle"
                  fontSize={FS_NAME}
                  fontWeight={600}
                >
                  {truncLabel(p.name, fitChars(innerW, FS_NAME, FACTOR_BOLD))}
                </text>
                {(() => {
                  const lines = wrap2(roleText, fitChars(innerW, FS_ROLE, FACTOR_SANS));
                  const cls = role ? 'tpl-node-role' : 'tpl-node-role empty';
                  return lines.length === 2 ? (
                    <>
                      <text
                        className={cls}
                        x={cx}
                        y={ROLE_Y1}
                        textAnchor="middle"
                        fontSize={FS_ROLE}
                      >
                        {lines[0]}
                      </text>
                      <text
                        className={cls}
                        x={cx}
                        y={ROLE_Y2}
                        textAnchor="middle"
                        fontSize={FS_ROLE}
                      >
                        {lines[1]}
                      </text>
                    </>
                  ) : (
                    <text className={cls} x={cx} y={ROLE_Y1} textAnchor="middle" fontSize={FS_ROLE}>
                      {lines[0]}
                    </text>
                  );
                })()}
              </g>
            );
          })}
          {!reduce && firstEdge && (
            <circle
              className="tpl-flow-dot"
              r={3.5}
              style={{ offsetPath: `path('${firstEdge}')` }}
            />
          )}
        </svg>
        {editor}
      </div>
    );
  }

  // Chain — a left→right sequence with arrowed links.
  const GAP = 32;
  const SIDE_PAD = 14;
  const NODE_H = 56;
  const NODE_Y = 14;
  const HEIGHT = 84;
  const FS_NAME = 11.5;
  const FS_ROLE = 10;
  const MIN_W = 132;
  const MAX_W = 248;
  const cy = NODE_Y + NODE_H / 2;
  const ROLE_Y1 = NODE_Y + 33;
  const ROLE_Y2 = NODE_Y + 46;
  const fsizes = { name: FS_NAME, role: FS_ROLE };
  let acc = SIDE_PAD;
  const laid = participants.map((p) => {
    const role = roleOf(roles, p.id);
    const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
    const t = { p, role, x: acc, w: tw };
    acc += tw + GAP;
    return t;
  });
  const width = acc - GAP - SIDE_PAD + 2 * SIDE_PAD;
  const first = laid[0];
  const last = laid[n - 1];
  const dotPath =
    first && last ? `M${first.x + first.w / 2} ${cy} L ${last.x + last.w / 2} ${cy}` : null;
  return (
    <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
      <svg
        className="tpl-svg"
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Chain of ${n} agent${n === 1 ? '' : 's'}`}
      >
        <defs>
          <marker
            id="tpl-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path className="tpl-arrowhead" d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        {laid.slice(1).map((t, idx) => {
          const prev = laid[idx];
          if (!prev) return null;
          return (
            <line
              key={`l${t.p.id}`}
              className="tpl-edge"
              x1={prev.x + prev.w}
              y1={cy}
              x2={t.x}
              y2={cy}
              markerEnd="url(#tpl-arrow)"
            />
          );
        })}
        {laid.map(({ p, role, x, w }) => {
          const cx = x + w / 2;
          const innerW = w - 2 * TILE_PAD_X;
          const roleText = role || ROLE_PLACEHOLDER;
          return (
            <g
              key={`n${p.id}`}
              data-pid={p.id}
              role="button"
              tabIndex={0}
              aria-label={`Edit role for ${p.name}`}
              onClick={(e) => openEditor(p.id, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openEditor(p.id, e.currentTarget);
                }
              }}
            >
              <title>{role ? `${p.name} — ${role}` : p.name}</title>
              <rect className="tpl-node-rect" x={x} y={NODE_Y} width={w} height={NODE_H} rx={8} />
              <text
                className="tpl-node-name"
                x={cx}
                y={NODE_Y + 18}
                textAnchor="middle"
                fontSize={FS_NAME}
                fontWeight={600}
              >
                {truncLabel(p.name, fitChars(innerW, FS_NAME, FACTOR_BOLD))}
              </text>
              {(() => {
                const lines = wrap2(roleText, fitChars(innerW, FS_ROLE, FACTOR_SANS));
                const cls = role ? 'tpl-node-role' : 'tpl-node-role empty';
                return lines.length === 2 ? (
                  <>
                    <text className={cls} x={cx} y={ROLE_Y1} textAnchor="middle" fontSize={FS_ROLE}>
                      {lines[0]}
                    </text>
                    <text className={cls} x={cx} y={ROLE_Y2} textAnchor="middle" fontSize={FS_ROLE}>
                      {lines[1]}
                    </text>
                  </>
                ) : (
                  <text className={cls} x={cx} y={ROLE_Y1} textAnchor="middle" fontSize={FS_ROLE}>
                    {lines[0]}
                  </text>
                );
              })()}
            </g>
          );
        })}
        {!reduce && n >= 2 && dotPath && (
          <circle className="tpl-flow-dot" r={3.5} style={{ offsetPath: `path('${dotPath}')` }} />
        )}
      </svg>
      {editor}
    </div>
  );
}

/** Drop empty entries so a roles map of all-blanks compares equal to none. */
function normalizeRoles(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v.trim().length > 0) out[k] = v;
  }
  return out;
}

/**
 * Right pane of the templates browser: the selected template's
 * architecture preview + editable per-agent role/description list +
 * Save-roles / Apply. The parent remounts this via `key={template.id}`
 * on selection change, so the `roles` useState initializer re-seeds
 * correctly per template (don't feed it changing props long-lived —
 * that would leak stale roles across selections). Switching templates
 * discards unsaved role edits, by design.
 */
function TemplatePreview(props: {
  template: MultiAgentTemplate;
  projects: Project[];
  onApply: (t: MultiAgentTemplate) => void;
  onUpdateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
}) {
  const { template, projects } = props;
  const resolved = template.participants
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => p !== undefined);
  const unavailable = template.participants.length - resolved.length;
  const [roles, setRoles] = useState<Record<string, string>>(template.roles ?? {});
  // Re-seed when the saved value changes (our own save round-trips back
  // through the templates list, or another window edits it).
  useEffect(() => {
    setRoles(template.roles ?? {});
  }, [template.roles]);
  const rolesDirty =
    JSON.stringify(normalizeRoles(roles)) !== JSON.stringify(normalizeRoles(template.roles ?? {}));

  // The pane is the keyboard target for Save roles / Apply. tabIndex={-1}:
  // focusable via .focus() / click, but not an awkward Tab stop on a huge
  // panel. Parent remounts us via key={template.id}, so this focuses the
  // pane each time a template is selected → Enter applies straight away.
  const paneRef = useRef<HTMLDivElement>(null);
  const focusPane = () => paneRef.current?.focus({ preventScroll: true });
  useEffect(() => {
    focusPane();
  }, []);

  return (
    <div
      className="tpl-preview"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        // A child control (button / role textarea / SVG node) owns its own
        // keys; only act when the pane container itself is focused.
        if (e.target !== paneRef.current) return;
        e.preventDefault();
        if (resolved.length > 0 && rolesDirty) props.onUpdateRoles(template, normalizeRoles(roles));
        else props.onApply(template);
      }}
    >
      <div className="tpl-preview-head">
        <div className="tpl-preview-name" title={template.name}>
          {template.name}
        </div>
        <div className="tpl-preview-meta">
          {template.mode} · {template.lifecycle} · {resolved.length} participant
          {resolved.length === 1 ? '' : 's'}
          {unavailable > 0 ? ` · ${unavailable} unavailable` : ''}
        </div>
      </div>

      <AgentDiagram
        mode={template.mode}
        participants={resolved}
        roles={roles}
        onRoleChange={(id, text) => setRoles((r) => ({ ...r, [String(id)]: text }))}
        onAfterCommit={() => requestAnimationFrame(focusPane)}
      />

      <div className="tpl-actions">
        {resolved.length > 0 && (
          <button
            className="ghost-btn"
            disabled={!rolesDirty}
            onClick={() => props.onUpdateRoles(template, normalizeRoles(roles))}
            title="Save the per-agent roles back to this template. Participants, mode and lifecycle are unchanged."
          >
            {rolesDirty ? 'Save roles' : 'Saved'}
          </button>
        )}
        <button
          className="tpl-apply"
          onClick={() => props.onApply(template)}
          title="Fill the participant list + lifecycle from this template. Type a fresh prompt and Start."
        >
          Apply
        </button>
      </div>
    </div>
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
  useModalKeys({
    onClose: props.onClose,
    onConfirm: () => props.onSave(trimmed),
    canConfirm: canSave,
  });
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
              placeholder="e.g. security review"
              spellCheck={false}
              autoFocus
            />
          </label>
          <p className="hint">
            Saves the current participant list + lifecycle. Per-agent roles are authored after, in
            the expanded card. The first prompt is never stored — you type it fresh each time.
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
  /** The tab this view is mounted under; used only for a cross-tab notice. */
  tabMode: 'chain' | 'orchestrator';
  projects: Project[];
  onStop: (sessionId: string) => void;
  onSendUserPrompt: (sessionId: string, text: string) => void;
  onSetLifecycle: (sessionId: string, lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (sessionId: string, projectId: number) => void;
  onDismiss: () => void;
}) {
  const { run } = props;
  const crossTab = run.mode !== props.tabMode;
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
            {run.mode === 'chain' ? 'Chained Chat' : 'Multi-Agent'}:{' '}
            <code>{run.sessionId.slice(0, 8)}</code>{' '}
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

      {crossTab && (
        <p className="multi-agent-warning">
          This {run.mode === 'chain' ? 'Chained Chat' : 'Multi-Agent'} run was started from the
          other tab. It’s shown here because a run is global; switch tabs to match.
        </p>
      )}

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
        <GrowTextarea
          value={text}
          onChange={setText}
          onSubmit={submit}
          placeholder="Type a message for the orchestrator. It'll route to whichever worker fits."
          ariaLabel="Message the orchestrator"
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
function validateDraft(participants: Project[], mode: 'chain' | 'orchestrator'): string | null {
  if (participants.length === 0) return 'Add at least one participant.';
  if (mode === 'chain' && participants.length < 2) {
    return 'A chained chat needs at least two participants.';
  }
  const missing = participants.filter((p) => !p.busInstalled).map((p) => p.name);
  if (missing.length > 0) {
    return `Install bus integration for: ${missing.join(', ')}.`;
  }
  return null;
}
