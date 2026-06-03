import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  ControlReasonCode,
  IterationSummary,
  KickMode,
  MultiAgentEventKind,
  MultiAgentLifecycle,
  MultiAgentMutationView,
  MultiAgentTemplate,
  PauseExpiryAction,
  Project,
  ServerMsg,
  TemplateLastRun,
} from '@cebab/shared/protocol';
import type { MultiAgentEventView, MultiAgentRun, MultiAgentState } from '../store';
import { activeAgent, eventDefaultCollapsed } from '../store';
import { agentIdentity } from '../agentIdentity';
import { formatElapsed } from '../format';
import { ThinkingIndicator, useElapsed } from './ThinkingIndicator';
import { GrowTextarea } from './GrowTextarea';
import { Markdown } from './Markdown';
import { RecoveryDisclosure } from './RecoveryDisclosure';
import { useModalSurface } from '../useModalSurface';
import { AgentTag } from './AgentTag';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ArtifactsView, groupArtifacts } from './ArtifactsView';
import { useArtifactContentBridge } from './ArtifactContentContext';
import { WorkingFiles } from './WorkingFiles';
import { LogsButton } from './sessionLog';
import { HopBudgetInput } from './HopBudgetInput';
import { ModelChip, summarizeBusModel } from './ModelChip';
import { RouterDropsCounter } from './authority/RouterDropsCounter';
import { ParticipantControlsCounter } from './agentControl/ParticipantControlsCounter';
import { ParticipantStatePills } from './agentControl/ParticipantStatePills';
import { ParticipantControlMenu } from './agentControl/ParticipantControlMenu';
import { AuthorityPreflightModal } from './authority/AuthorityPreflightModal';
import { BusInstalledBadge } from './BusInstalledBadge';
import { AgentDiagram } from './templatePreview/AgentDiagram';
import { TemplatePreviewModal } from './templatePreview/TemplatePreviewModal';
import type { ModalOrigin } from './templatePreview/TemplatePreviewModal';
import {
  BypassPermissionsBanner,
  ConsultantModeBanner,
  CustomModeBanner,
  CustomModeNotice,
} from './templatePreview/TemplatePreviewBanners';
import { ConsultantModeChip } from './ConsultantModeChip';
import { MockBadge } from './MockBadge';
import { MultiAgentScrollbackFilter, countByKind } from './MultiAgentScrollbackFilter';
// Cluster D Phase 3: the 3 inline multi-agent warnings below (awaiting-
// continue, pending-retry, pending-mutation) now render through the
// unified SessionBanner with `classStem="multi-agent-warning"` so the
// legacy `.multi-agent-warning*` styles still apply byte-equivalently
// and the operator gets the tier→a11y mapping + focus-steal contract
// for free.
import { SessionBanner } from './banners/SessionBanner';
import { buildBusAutoRetryBannerItem, buildSweptSessionBannerItem } from './banners';
// Cluster D Phase 5e (UI-D17): in-session SweptSessionBanner reads the
// ReopenContext directly (Reopen action) — same context the toast
// notification uses, so the modal flow stays unified.
import { useReopenActions, useReopenState } from './reopen';

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
  /**
   * Cluster G Phase 4 (D6/D11): per-project install timestamps from the
   * store. Threaded into the DraftView participant list so each row can
   * mount a `<BusInstalledBadge>` next to the existing
   * `.participant-bus-tag.installed` chip for the 30-second post-install
   * highlight. See AppState['lastBusInstallAt'] JSDoc for the
   * anti-pattern guard.
   */
  lastBusInstallAt: Record<number, number>;
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
  onContinueMultiAgent: (sessionId: string) => void;
  onRetryWorker: (sessionId: string) => void;
  onAbandonSession: (sessionId: string) => void;
  /** Cluster D Phase 5e (UI-D17): SweptSessionBanner Archive button.
   *  Ships `archive_session` ClientMsg — same as the toast
   *  notification's Archive action. The reducer's `iteration_archived`
   *  handler drops the row from the iterations list. */
  onArchiveSession: (sessionId: string) => void;
  /** Item #5: operator clicked Continue on the pause-on-first-mutation banner. */
  onContinueThroughMutation: (sessionId: string) => void;
  /** Interactive AskUserQuestion: the operator answered a parked question. */
  onAnswerQuestion: (
    sessionId: string,
    agent: string,
    toolUseId: string,
    answers: Record<string, string>,
  ) => void;
  /** Cluster D Phase 4d: CountdownChip onElapsed sink — clears the bus
   *  auto-retry slice so the banner unmounts. If attempt N+1 also fails,
   *  the next `auto_retry` ServerMsg repopulates the slice. */
  onClearAutoRetry: () => void;
  /** Item #5: setup-screen toggle for pause-on-first-mutation. */
  onSetDraftPauseOnMutation: (value: boolean) => void;
  /**
   * Cluster F Phase D9 (UI-D9): setup-screen hop-budget override input.
   * Forwarded to the matching `ma_set_draft_hop_budget` action; null
   * clears the override so the server resolver falls through.
   */
  onSetDraftHopBudget: (value: number | null) => void;
  /**
   * Cluster F Phase D9: server-resolved default for the placeholder /
   * empty-state hint. Null when settings haven't loaded yet — the
   * input degrades to a generic placeholder until settings arrive.
   */
  defaultHopBudget: number | null;
  onSetActiveLifecycle: (sessionId: string, lifecycle: MultiAgentLifecycle) => void;
  onAddActiveParticipant: (sessionId: string, projectId: number) => void;
  /**
   * Cluster C Phase 4g2 → 4g5: per-participant control verb dispatch. Each
   * forwards to a typed ClientMsg via wsRef in App.tsx. C4g5 added the
   * `reasonText` field so the modal-collected free-text notes reach the
   * safety_audit payload.
   */
  onMuteParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onUnmuteParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onPauseParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => void;
  onResumeParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  /**
   * Cluster C Phase 4g3: kick dispatch — bound to the KickModal's
   * onSubmit callback via the ⋮ menu. Mode is currently always 'drain'
   * (server rejects 'hard' with `hard_kill_unsupported_v1`).
   */
  onKickParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) => void;
  onDismissActive: () => void;
  onRefreshIterations: () => void;
  onClearIterations: () => void;
  onRefreshTemplates: () => void;
  onSaveTemplate: (name: string, mode: 'chain' | 'orchestrator') => void;
  onUpdateTemplateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (t: MultiAgentTemplate) => void;
  /**
   * Phase H: open the Logs surface for the active run. Pure WS round-trip;
   * the matching `session_log_chunk` arrives via `subscribeServerMsg`.
   */
  onLoadSessionLog: (
    sessionId: string,
    offset: number,
    limit: number,
    revealSensitive: boolean,
  ) => void;
  /**
   * Phase H side-channel subscription for surfaces (Logs modal) whose state
   * doesn't belong in Redux. Returns the unsubscribe fn.
   */
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  /**
   * PR-6: request a project's static facts (path + CLAUDE.md head) for the
   * per-participant disclosure inside the template-preview modal. The matching
   * `project_facts` reply arrives via `subscribeServerMsg` (not Redux —
   * each modal-open owns its own cache).
   */
  onReadProjectFacts: (projectId: number) => void;
  /**
   * PR-7: request the most-recent run for a saved template's rail. The
   * matching `last_run_for_template` reply arrives via `subscribeServerMsg`;
   * the templates panel owns a per-template cache keyed on templateId.
   */
  onReadLastRunForTemplate: (templateId: string) => void;
}) {
  const { multiAgent, projects } = props;
  if (multiAgent.active) {
    return (
      <ActiveRunView
        run={multiAgent.active}
        tabMode={props.mode}
        projects={projects}
        onSendUserPrompt={props.onSendUserPrompt}
        onContinue={props.onContinueMultiAgent}
        onRetryWorker={props.onRetryWorker}
        onAbandonSession={props.onAbandonSession}
        onArchiveSession={props.onArchiveSession}
        onContinueThroughMutation={props.onContinueThroughMutation}
        onAnswerQuestion={props.onAnswerQuestion}
        onSetLifecycle={props.onSetActiveLifecycle}
        onAddParticipant={props.onAddActiveParticipant}
        onMuteParticipant={props.onMuteParticipant}
        onUnmuteParticipant={props.onUnmuteParticipant}
        onPauseParticipant={props.onPauseParticipant}
        onResumeParticipant={props.onResumeParticipant}
        onKickParticipant={props.onKickParticipant}
        onClearAutoRetry={props.onClearAutoRetry}
      />
    );
  }
  return <DraftView {...props} />;
}

function DraftView(props: {
  mode: 'chain' | 'orchestrator';
  projects: Project[];
  /**
   * Cluster G Phase 4 (D6/D11): per-project install timestamps from the
   * store, threaded down from MultiAgentTab. Each `participant-row` reads
   * `props.lastBusInstallAt[p.id]` to drive the 30-second post-install
   * `<BusInstalledBadge>` highlight next to the `.participant-bus-tag.installed`
   * chip. See AppState['lastBusInstallAt'] JSDoc in store.ts for the
   * structural anti-pattern guard.
   */
  lastBusInstallAt: Record<number, number>;
  multiAgent: MultiAgentState;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  onRemoveParticipant: (projectId: number) => void;
  onReorderParticipant: (projectId: number, direction: 'up' | 'down') => void;
  onInstallBus: (projectId: number) => void;
  onUninstallBus: (projectId: number) => void;
  onSetDraftPrompt: (text: string) => void;
  /** Item #5: setup-screen toggle for pause-on-first-mutation. */
  onSetDraftPauseOnMutation: (value: boolean) => void;
  /** Cluster F Phase D9 (UI-D9): setup-screen hop-budget override input. */
  onSetDraftHopBudget: (value: number | null) => void;
  /** Cluster F Phase D9: server-resolved default for input placeholder. */
  defaultHopBudget: number | null;
  onStart: () => void;
  onResumeSession: (sessionId: string) => void;
  wrapperErrorSeq: number;
  onRefreshIterations: () => void;
  onClearIterations: () => void;
  onSaveTemplate: (name: string, mode: 'chain' | 'orchestrator') => void;
  onUpdateTemplateRoles: (t: MultiAgentTemplate, roles: Record<string, string>) => void;
  onDeleteTemplate: (id: string) => void;
  onApplyTemplate: (t: MultiAgentTemplate) => void;
  /** PR-6: request a project's static facts for the modal's per-participant
   *  disclosure (path + CLAUDE.md head). Reply via `subscribeServerMsg`. */
  onReadProjectFacts: (projectId: number) => void;
  /** PR-6: same subscription seam Logs uses — the modal's cache lives here,
   *  not in Redux, so it can invalidate per modal-open. */
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  /** PR-7: request the most-recent run for a saved template's health rail.
   *  Reply via `subscribeServerMsg`; cache lives in `TemplatesPanel`. */
  onReadLastRunForTemplate: (templateId: string) => void;
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
        {/* PR-1: load-bearing safety banner. Surfaces the bypassPermissions
            posture that's baked into server/src/bus/runner.ts but is
            otherwise invisible in the UI. Non-dismissible. */}
        <BypassPermissionsBanner />
        {/* Cluster F Phase D5 (UI-D5): pair with the bypass banner for
            orchestrator drafts. The consultant-mode guardrail is baked
            into runtime.ts's renderRosterPrompt + renderWorkerBriefing
            and applies for every orchestrator-mode bus session. Chain
            mode's renderChainBriefing has no equivalent constraint, so
            we don't render the banner there — surfacing it would mislead
            operators about a guardrail that doesn't exist. */}
        {isOrch && <ConsultantModeBanner />}
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
            onReadProjectFacts={props.onReadProjectFacts}
            subscribeServerMsg={props.subscribeServerMsg}
            onReadLastRunForTemplate={props.onReadLastRunForTemplate}
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
                        <>
                          <span
                            className="participant-bus-tag installed"
                            title={`Bus agent: ${p.busAgentName ?? '?'}`}
                          >
                            bus: {p.busAgentName}
                          </span>
                          {/* Cluster G Phase 4 (D6/D11): 30-second post-install
                           * highlight. Reads the timestamp from the store's
                           * `lastBusInstallAt` map; the badge auto-hides
                           * 30s after the install. A `bus: <name>` chip
                           * with no entry in the map (pre-existing install
                           * from before page load) gets no badge — the
                           * anti-pattern guard is structural. */}
                          <BusInstalledBadge installedAt={props.lastBusInstallAt[p.id]} />
                        </>
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
                      {/* Cluster B Phase 6e (UI-B8): per-participant
                       *  authority inspect button. Opens the preflight modal
                       *  scoped to JUST this project. Cebab-injected MCPs +
                       *  TOFU + env injections all surface here. */}
                      <DraftParticipantAuthorityButton projectId={p.id} />
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
          {/* PR-1: lifecycle=temp inline note. Not a banner — the warning
              is contextual to the choice the operator just made, and it
              appears/disappears with the toggle (no sticky state). The
              title attribute on the button alone is too easy to miss. */}
          {multiAgent.draftLifecycle === 'temp' && (
            <p className="ma-lifecycle-note">
              On End, Cebab deletes this session's folder AND removes bus integration from each
              participant. Project files are untouched.
            </p>
          )}
          {/* Item #5: pause-on-first-mutation opt-in. Off by default; the
              operator opts in explicitly per session. Survives R-B once set. */}
          <label
            className="ma-pause-mutation-checkbox"
            title="When enabled, the session pauses before the first non-read tool call from any worker and asks for your approval. Subsequent mutations auto-allow once you click Continue. Survives a Cebab server restart."
          >
            <input
              type="checkbox"
              checked={multiAgent.draftPauseOnMutation}
              onChange={(e) => props.onSetDraftPauseOnMutation(e.target.checked)}
            />
            Pause before any worker mutates the filesystem
          </label>
          {/* Cluster F Phase D9 (UI-D9): per-run hop-budget override. The
              wire was complete (start_multi_agent.hopBudget + template
              field + resolver precedence) but no UI input existed. This
              fills the gap. Placeholder shows the server default; null
              value falls through the precedence chain. */}
          {props.defaultHopBudget !== null && (
            <HopBudgetInput
              value={multiAgent.draftHopBudget}
              source={multiAgent.draftHopBudgetSource}
              defaultValue={props.defaultHopBudget}
              onChange={props.onSetDraftHopBudget}
            />
          )}
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
      {/* Cluster B Phase 6e (UI-B8): composer-adjacent [Inspect authority]
       *  ghost-btn opens the AuthorityPreflightModal in aggregate mode
       *  (one panel per participant project). Only renders when there's at
       *  least one participant — empty draft has nothing to inspect. */}
      {participants.length > 0 && (
        <div className="multi-agent-inspect-row">
          <DraftInspectAuthorityButton projectIds={participants.map((p) => p.id)} />
        </div>
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
  /** PR-6: forwarded to the per-template preview's expanded modal. */
  onReadProjectFacts: (projectId: number) => void;
  /** PR-6: forwarded subscription seam for the modal's facts cache. */
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  /** PR-7: forwarded to the per-template preview's "Last run" rail. */
  onReadLastRunForTemplate: (templateId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // PR-7: per-template "Last run" cache shared across this panel mount.
  // Keyed by templateId; value is either undefined (never asked), null
  // (asked, server replied lastRun=null), or a TemplateLastRun row.
  // Refreshed: (a) on first card mount via TemplatePreview's useEffect,
  // (b) on each `multi_agent_ended` whose session was started from any
  // visible templateId (via the subscription below).
  const [lastRuns, setLastRuns] = useState<Map<string, TemplateLastRun | null>>(() => new Map());
  // Listen for `last_run_for_template` replies and ENDED events that
  // should invalidate the rail. Subscribe once per panel mount.
  useEffect(() => {
    return props.subscribeServerMsg((msg) => {
      if (msg.type === 'last_run_for_template') {
        setLastRuns((prev) => {
          const next = new Map(prev);
          next.set(msg.templateId, msg.lastRun);
          return next;
        });
        return;
      }
      if (msg.type === 'multi_agent_ended') {
        // We don't know which template this run was attributed to from
        // the ended event alone (sessionId isn't a template id). Cheapest
        // correct option: refresh every cached template — the rail's
        // SELECT is a single-row lookup so this is bounded. Without this,
        // a just-finished run would show stale rail until the next mount.
        setLastRuns((prev) => {
          if (prev.size === 0) return prev;
          // Defer per-key requests so React doesn't churn — we trigger
          // refetches in the side-effect; the state map itself is
          // untouched (the replies arrive via the same subscription).
          for (const templateId of prev.keys()) {
            props.onReadLastRunForTemplate(templateId);
          }
          return prev;
        });
      }
    });
  }, [props]);

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
        onSelect={(id) => {
          // Clicking a template both opens its preview (for role edits)
          // and applies it — fills participants/lifecycle so the operator
          // can just type a prompt and press Enter to start.
          setSelectedId(id);
          const t = items.find((x) => x.id === id);
          if (t) props.onApply(t);
        }}
        onDelete={props.onDelete}
      />
      <TemplatePreview
        key={selected.id}
        template={selected}
        projects={props.projects}
        onApply={props.onApply}
        onUpdateRoles={props.onUpdateRoles}
        onReadProjectFacts={props.onReadProjectFacts}
        subscribeServerMsg={props.subscribeServerMsg}
        onReadLastRunForTemplate={props.onReadLastRunForTemplate}
        lastRun={lastRuns.get(selected.id)}
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
  /** PR-6: forwarded to the fullscreen modal (per-participant disclosure). */
  onReadProjectFacts: (projectId: number) => void;
  /** PR-6: forwarded subscription seam for the modal's facts cache. */
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  /** PR-7: trigger the rail's RPC on mount. */
  onReadLastRunForTemplate: (templateId: string) => void;
  /** PR-7: the last-run row for this template (`null` = no row, `undefined`
   *  = parent hasn't received a reply yet — the rail simply doesn't render
   *  in that case). */
  lastRun: TemplateLastRun | null | undefined;
}) {
  const { template, projects, onReadLastRunForTemplate } = props;
  // PR-7: fire the rail RPC once per template mount. The parent caches
  // replies in its `lastRuns` Map keyed by templateId; the parent's
  // `multi_agent_ended` listener separately refreshes all cached
  // templates so live updates flow without a remount. Depending only on
  // `template.id` + the callback (stable across renders from App.tsx)
  // avoids re-firing on every parent re-render.
  useEffect(() => {
    onReadLastRunForTemplate(template.id);
  }, [onReadLastRunForTemplate, template.id]);
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

  // PR-5: fullscreen modal state. `modalOpen` toggles the dialog;
  // `modalOrigin` is the viewport-px center of the originating expand
  // button so the dialog can scale-from-button (transform-origin). Auto-
  // closes when the template changes (parent already remounts us via
  // key={template.id}, so the state resets naturally).
  const [modalOpen, setModalOpen] = useState(false);
  const [modalOrigin, setModalOrigin] = useState<ModalOrigin | null>(null);

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
        {/* PR-7: "Last run" health rail. Renders when the parent has a
         *  cached reply for this template; otherwise the area is empty.
         *  Click jumps to the iteration (LogsModal route in v1: defer
         *  until the click site exists — for now the rail is read-only). */}
        <TemplateLastRunRail template={template} lastRun={props.lastRun} />
      </div>
      {/* PR-1 + PR-2: custom-mode honesty surface. Fires only when the
          stored template carries mode='custom'. The notice is the factual
          statement ("rendered as orchestrator"); the banner is the
          approximation warning. Pair, not duplication — see the comment
          on `<CustomModeNotice />` for the audience split. */}
      {template.mode === 'custom' && (
        <>
          <CustomModeNotice />
          <CustomModeBanner />
        </>
      )}

      <AgentDiagram
        mode={template.mode}
        participants={resolved}
        roles={roles}
        onRoleChange={(id, text) => setRoles((r) => ({ ...r, [String(id)]: text }))}
        onCommitRole={(id, text) => {
          // Enter in a cell persists straight away — no "Save roles" click.
          // Build the next map from the committed cell (local `roles` may
          // not have it yet) so the saved value is never a step behind.
          const next = { ...roles, [String(id)]: text };
          props.onUpdateRoles(template, normalizeRoles(next));
          requestAnimationFrame(focusPane);
        }}
        paused={modalOpen}
        onExpand={(origin) => {
          setModalOrigin(origin);
          setModalOpen(true);
        }}
        expandNudge={resolved.length >= 9}
      />

      {modalOpen && (
        <TemplatePreviewModal
          template={template}
          participants={resolved}
          roles={roles}
          onRoleChange={(id, text) => setRoles((r) => ({ ...r, [String(id)]: text }))}
          onCommitRole={(id, text) => {
            const next = { ...roles, [String(id)]: text };
            props.onUpdateRoles(template, normalizeRoles(next));
          }}
          origin={modalOrigin ?? undefined}
          onReadProjectFacts={props.onReadProjectFacts}
          subscribeServerMsg={props.subscribeServerMsg}
          onClose={() => {
            setModalOpen(false);
            // Focus restore — the expand button lives inside the compact
            // AgentDiagram and is unique in this preview pane. Defer one
            // frame so the modal has actually unmounted (inert removed).
            requestAnimationFrame(() => {
              const btn = paneRef.current?.querySelector<HTMLButtonElement>('.tpl-expand-btn');
              btn?.focus();
            });
          }}
        />
      )}

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

/**
 * PR-7: "Last run" health rail rendered under a template's preview header.
 *
 * Three states:
 *   - `lastRun === undefined`: parent hasn't fetched yet → render nothing
 *     (avoids a layout-shift "Loading…" flash; the rail isn't load-bearing).
 *   - `lastRun === null`: server confirmed no recorded run for this
 *     template → render an "Hop budget: X (per template)" affordance when
 *     `template.hopBudget` is set, otherwise nothing.
 *   - `lastRun: TemplateLastRun`: render "Last run: 3h ago · 7/12 hops ·
 *     <chip>" with a color-coded chip derived from
 *     (status, hopsUsed === hopBudget) per the decision-log table U2.
 */
function TemplateLastRunRail(props: {
  template: MultiAgentTemplate;
  lastRun: TemplateLastRun | null | undefined;
}) {
  const { template, lastRun } = props;
  // Show a hop-budget badge whenever the template has its own override —
  // it's a permanent fact about the template, distinct from the variable
  // "what happened on the last run" rail beneath. Both can co-exist.
  const budgetBadge =
    typeof template.hopBudget === 'number' ? (
      <span
        className="tpl-preview-budget"
        title="This template overrides the global hop budget. Runs started from this template enforce the value below."
      >
        Hop budget: {template.hopBudget} (per template)
      </span>
    ) : null;

  if (lastRun === undefined) return budgetBadge;
  if (lastRun === null) return budgetBadge;

  const label = deriveLastRunLabel(lastRun);
  // "X / Y" only renders when both are present (post-013 rows). For
  // pre-013 rows hopBudget is null — show "?" so the row is still legible.
  const hopsText =
    lastRun.hopsUsed === null
      ? `?/${lastRun.hopBudget ?? '?'}`
      : `${lastRun.hopsUsed}/${lastRun.hopBudget ?? '?'}`;
  const agoText = formatAgo(lastRun.startedAt);
  return (
    <>
      {budgetBadge}
      <div className={`tpl-preview-rail tpl-preview-rail--${label.kind}`}>
        <span className="tpl-preview-rail-label">Last run</span>
        <span
          className="tpl-preview-rail-time"
          title={new Date(lastRun.startedAt).toLocaleString()}
        >
          {agoText}
        </span>
        <span className="tpl-preview-rail-hops">· {hopsText} hops ·</span>
        <span className={`tpl-preview-rail-chip tpl-preview-rail-chip--${label.kind}`}>
          {label.text}
        </span>
        {label.kind === 'failed' && lastRun.firstError && (
          <span className="tpl-preview-rail-error" title={lastRun.firstError}>
            · {truncateOneLine(lastRun.firstError, 60)}
          </span>
        )}
      </div>
    </>
  );
}

/** Derive a rendering label from the persisted status + hops_used. Mirrors
 *  decision-log table U2 — the protocol enum stays as-is, the label is a
 *  render-time projection. Exported for unit testing in isolation. */
export function deriveLastRunLabel(run: TemplateLastRun): {
  kind: 'ok' | 'at-cap' | 'interrupted' | 'failed' | 'running';
  text: string;
} {
  if (run.status === 'running') return { kind: 'running', text: 'running' };
  if (run.status === 'crashed') return { kind: 'failed', text: 'failed' };
  if (run.status === 'stopped') {
    // Stop is "operator pulled the cord". Distinguish at-cap (budget
    // tripped → router auto-stopped) from a hand-Stop.
    if (
      typeof run.hopsUsed === 'number' &&
      typeof run.hopBudget === 'number' &&
      run.hopsUsed >= run.hopBudget
    ) {
      return { kind: 'at-cap', text: 'at cap' };
    }
    return { kind: 'interrupted', text: 'interrupted' };
  }
  // status === 'completed'
  if (
    typeof run.hopsUsed === 'number' &&
    typeof run.hopBudget === 'number' &&
    run.hopsUsed >= run.hopBudget
  ) {
    return { kind: 'at-cap', text: 'at cap' };
  }
  return { kind: 'ok', text: 'ok' };
}

/** Coarse "time ago" string (m / h / d). Mirrors the existing iteration
 *  browser's approach — no library, ASCII units, never lies about precision. */
function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Single-line truncate for the inline error excerpt: kill internal
 *  newlines first, then cap to `n` chars with an ellipsis. */
function truncateOneLine(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…';
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
  const { overlayRef, onBackdropMouseDown } = useModalSurface({
    onClose: props.onClose,
    onConfirm: () => props.onSave(trimmed),
    canConfirm: canSave,
  });
  return (
    <div ref={overlayRef} className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
      <div className="modal modal-surface">
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
  onSendUserPrompt: (sessionId: string, text: string) => void;
  onContinue: (sessionId: string) => void;
  onSetLifecycle: (sessionId: string, lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (sessionId: string, projectId: number) => void;
  /**
   * Cluster C Phase 4g2 → 4g5: per-participant control verbs from the ⋮
   * menu in SessionSettingsPanel. SessionId is bound here so the menu
   * only needs (projectId, reasonCode, reasonText, …) at the leaf.
   * C4g5 added reasonText for every action — collected by MuteReason/
   * PauseReasonModal.
   */
  onMuteParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onUnmuteParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onPauseParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => void;
  onResumeParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  /** Cluster C Phase 4g3: kick dispatch — bound to KickModal's onSubmit. */
  onKickParticipant: (
    sessionId: string,
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) => void;
  /** Item #4: Retry the worker named in this session's pending-retry slot.
   *  The slot is server-authoritative — no agentName/prompt args. */
  onRetryWorker: (sessionId: string) => void;
  /** Item #4: Give up on the pending-retry slot and end the session as
   *  `'stopped'`. Same teardown as Stop, distinct verb so analytics can
   *  differentiate "stopped a healthy run" from "abandoned after failure". */
  onAbandonSession: (sessionId: string) => void;
  /** Cluster D Phase 5e (UI-D17): SweptSessionBanner Archive button.
   *  Sends `archive_session` ClientMsg — identical to the toast
   *  notification's Archive action. Server idempotency means double-
   *  clicks are benign. */
  onArchiveSession: (sessionId: string) => void;
  /** Item #5: operator clicked Continue on the pause-on-first-mutation
   *  banner. Stateless from the client's POV — server reads the slot. */
  onContinueThroughMutation: (sessionId: string) => void;
  /** Interactive AskUserQuestion: the operator answered a parked question. */
  onAnswerQuestion: (
    sessionId: string,
    agent: string,
    toolUseId: string,
    answers: Record<string, string>,
  ) => void;
  /** Cluster D Phase 4d: clear the bus auto-retry slice on chip elapse. */
  onClearAutoRetry: () => void;
}) {
  const { run } = props;
  const crossTab = run.mode !== props.tabMode;
  const isRunning = run.status === 'running';
  const isOrchestrator = run.mode === 'orchestrator';

  // Cluster D Phase 5e (UI-D17): swept session = a multi_agent_sessions
  // row whose status was flipped to 'crashed' by Phase 4's auto-sweep
  // (when a newer iteration took the active slot) or Phase 5c's
  // operator-initiated reopen swap. Both surface the same `session_
  // superseded` ServerMsg server-side; here the operator is viewing
  // the displaced iteration after the fact (clicking it in the
  // Iterations list, or landing here from a notification action).
  //
  // We don't try to distinguish "crashed because swept" from "crashed
  // because the runner segfaulted" — Reopen + Archive are valid
  // operator actions for any crashed iteration. Reopen will fail with
  // a tailored failure reason if reactivation can't proceed (chain
  // mode → `chain_reconstruction_unsupported`); Archive is always
  // valid. The banner's body copy generalizes safely.
  const isSwept = run.status === 'crashed';
  const reopenState = useReopenState();
  const { requestReopen } = useReopenActions();
  const reopenInFlight = reopenState.kind !== 'idle';
  // Transient highlight target for spine→scrollback jumps. Cleared after a
  // short pulse so it reads as "this is the row I just jumped to".
  const [highlightedEventId, setHighlightedEventId] = useState<number | null>(null);

  // Cluster H D8: client-only kind filter for the scrollback. State holds the
  // currently *hidden* kinds (empty = everything visible) — matches the
  // useLogFilters convention so the same mental model applies to both the
  // scrollback chips and the Logs modal's Kinds dropdown.
  //
  // Resets when the active run flips (sessionId change). ActiveRunView does
  // not re-mount across run swaps within the same tab — the parent only
  // updates props — so an explicit effect is needed to keep stale filters
  // from carrying into a fresh run's scrollback.
  const [hiddenKinds, setHiddenKinds] = useState<Set<MultiAgentEventKind>>(() => new Set());
  useEffect(() => {
    setHiddenKinds(new Set());
  }, [run.sessionId]);
  const kindCounts = useMemo(() => countByKind(run.events), [run.events]);
  const visibleEvents = useMemo(
    () =>
      hiddenKinds.size === 0 ? run.events : run.events.filter((ev) => !hiddenKinds.has(ev.kind)),
    [run.events, hiddenKinds],
  );
  function toggleHiddenKind(kind: MultiAgentEventKind) {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }
  function resetHiddenKinds() {
    setHiddenKinds(new Set());
  }

  function jumpToEvent(eventId: number) {
    setHighlightedEventId(eventId);
    // The row's metadata header is always rendered (collapsed only hides the
    // body), so the anchor exists; defer one frame so a just-mounted row is
    // laid out before we scroll.
    requestAnimationFrame(() => {
      const el = document.getElementById(`ev-${eventId}`);
      if (!el) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    });
    window.setTimeout(() => setHighlightedEventId((cur) => (cur === eventId ? null : cur)), 1800);
  }

  return (
    <div className="multi-agent">
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
        // A paused run (R-B awaiting Continue, a worker-failure pending
        // retry, or a pause-on-first-mutation gate) isn't actually executing —
        // show no fake activity until the operator resolves the banner.
        activeAgent={
          run.awaitingContinue || run.pendingRetry || run.pendingMutation ? null : activeAgent(run)
        }
        onSetLifecycle={(lifecycle) => props.onSetLifecycle(run.sessionId, lifecycle)}
        onAddParticipant={(projectId) => props.onAddParticipant(run.sessionId, projectId)}
        onMuteParticipant={(projectId, reasonCode, reasonText) =>
          props.onMuteParticipant(run.sessionId, projectId, reasonCode, reasonText)
        }
        onUnmuteParticipant={(projectId, reasonCode, reasonText) =>
          props.onUnmuteParticipant(run.sessionId, projectId, reasonCode, reasonText)
        }
        onPauseParticipant={(projectId, reasonCode, reasonText, timeoutMs, expiryAction) =>
          props.onPauseParticipant(
            run.sessionId,
            projectId,
            reasonCode,
            reasonText,
            timeoutMs,
            expiryAction,
          )
        }
        onResumeParticipant={(projectId, reasonCode, reasonText) =>
          props.onResumeParticipant(run.sessionId, projectId, reasonCode, reasonText)
        }
        onKickParticipant={(projectId, reasonCode, reasonText, mode) =>
          props.onKickParticipant(run.sessionId, projectId, reasonCode, reasonText, mode)
        }
        highlightedEventId={highlightedEventId}
        onJump={jumpToEvent}
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
          <>
            {/* Cluster H D8: scrollback kind-filter chips. Client-only —
             *  every `multi_agent_event` already carries `kind`, no backend
             *  involvement needed. Hides chip kinds from the scrollback below
             *  while leaving the underlying events untouched (so the spine,
             *  exports, and Logs modal still see them all). */}
            <MultiAgentScrollbackFilter
              hiddenKinds={hiddenKinds}
              counts={kindCounts}
              onToggle={toggleHiddenKind}
              onReset={resetHiddenKinds}
            />
            {visibleEvents.length === 0 ? (
              <p className="iterations-empty">
                All event kinds are hidden. Click a chip above or Clear to show events.
              </p>
            ) : (
              <ol className="event-list">
                {visibleEvents.map((ev) => (
                  <EventRow
                    key={ev.eventId}
                    event={ev}
                    defaultCollapsed={eventDefaultCollapsed(run, ev)}
                    highlighted={highlightedEventId === ev.eventId}
                  />
                ))}
              </ol>
            )}
          </>
        )}
      </section>

      {/* Cluster D Phase 5e (UI-D17): swept-session danger-tier banner.
       * Mounted only when the iteration row is `status === 'crashed'`
       * — i.e. the operator landed here after a sweep (Phase 4 auto-
       * sweep or Phase 5c operator-reopen swap) and the iteration is
       * no longer the project's active session.
       *
       * Sits above the running-state banners in JSX order so a future
       * BannerStack migration keeps it visually first (danger > warn
       * in priority). At runtime the running banners are gated on
       * `isRunning` and this on `isSwept` — mutually exclusive — so
       * ordering is purely declarative posture.
       *
       * Direct <SessionBanner /> mount (not via BannerStack) matches
       * the autoRetry / multi-agent-warning pattern below. The factory
       * returns BannerStackItem props which are a superset of
       * SessionBannerProps; spreading is safe. */}
      {isSwept && (
        <SessionBanner
          {...buildSweptSessionBannerItem({
            sessionId: run.sessionId,
            reopenInFlight,
            callbacks: {
              onReopen: () => requestReopen(run.sessionId),
              onArchive: () => props.onArchiveSession(run.sessionId),
            },
          })}
        />
      )}
      {/* Cluster D Phase 4d: bus auto-retry banner. Observe-only — the
       * bus runner owns the retry loop server-side, so the operator
       * sees countdown + agent + reason but no Retry/Pause buttons (a
       * UI-only pause would lie; a manual fire would race the bus).
       *
       * Mounted as a direct <SessionBanner> (not via BannerStack) for
       * symmetry with the three inline `.multi-agent-warning` banners
       * below — keeping the multi-agent surface's banner-mount pattern
       * uniform. Visually it sits above the recovery banners because
       * rate-limit is a transient runtime condition; awaiting-continue/
       * pending-retry/pending-mutation are operator decisions and stay
       * primary. */}
      {isRunning && run.autoRetry && (
        <SessionBanner
          {...buildBusAutoRetryBannerItem({
            sessionId: run.sessionId,
            state: run.autoRetry,
            callbacks: { onClear: props.onClearAutoRetry },
          })}
        />
      )}
      {/* Cluster D Phase 3 migration: three inline recovery banners now
       * render through <SessionBanner classStem="multi-agent-warning"
       * layout="flat">. The legacy `.multi-agent-warning` /
       * `.multi-agent-warning-actions` classes are preserved so existing
       * CSS keeps the colour + action-row layout byte-equivalent. Tier
       * = "warn" for all three; a11y role is pinned to "status" to
       * match the pre-migration markup (the banner-stack focus-steal
       * contract isn't in play here — these are mounted directly, not
       * inside a <BannerStack>). */}
      {isOrchestrator && isRunning && run.awaitingContinue && (
        <SessionBanner
          id={`multi-agent-warning-awaiting-${run.sessionId}`}
          tier="warn"
          classStem="multi-agent-warning"
          layout="flat"
          role="status"
          ariaLive="polite"
          stealsFocus={false}
          body={
            <>
              <p>
                <strong>Recovered after a Cebab restart.</strong> This run is re-attached read-only
                — nothing is running. The agent that was mid-turn will pick up from its last
                completed step; file writes or commands from that interrupted step are <em>not</em>{' '}
                rolled back. Review the scrollback above (see the recovery note), then continue when
                ready.
              </p>
              {/* RecoveryDisclosure already has its own internal toggle
               * ("▾ Recovery details"), so we render it inline rather
               * than nesting it in SessionBanner's `<details>` slot —
               * that would be a double-disclosure with two summaries. */}
              {run.recoveryContext && <RecoveryDisclosure recovery={run.recoveryContext} />}
            </>
          }
          actions={[
            {
              label: 'Continue session',
              variant: 'primary',
              onClick: () => props.onContinue(run.sessionId),
              title:
                "Deliver a 'continue where you left off' nudge to the orchestrator (it resumes its real CLI session). This is the only action that re-runs agents after a restart.",
            },
          ]}
        />
      )}

      {isRunning && run.pendingRetry && (
        <SessionBanner
          id={`multi-agent-warning-retry-${run.sessionId}`}
          tier="warn"
          classStem="multi-agent-warning"
          layout="flat"
          role="status"
          ariaLive="polite"
          stealsFocus={false}
          body={
            <>
              <p>
                <strong>
                  <code>{run.pendingRetry.agentName}</code>'s last turn failed.
                </strong>{' '}
                {run.pendingRetry.reason}
              </p>
              <p>
                Retry replays the same prompt; the worker resumes its CLI session, so full prior
                context is intact. Any partial file writes from the failed turn are <em>not</em>{' '}
                rolled back.
              </p>
            </>
          }
          actions={[
            {
              label: `Retry ${run.pendingRetry.agentName}`,
              variant: 'primary',
              onClick: () => props.onRetryWorker(run.sessionId),
              title:
                "Re-deliver the captured prompt to this worker. The agent's --resume brings back full prior context.",
            },
            {
              label: 'Abandon session',
              onClick: () => props.onAbandonSession(run.sessionId),
              title:
                'End the session as Stopped. The session folder and trail are preserved for post-mortem.',
            },
            {
              label: 'Jump to error',
              variant: 'ghost',
              onClick: () => jumpToEvent(run.pendingRetry!.errorEventId),
              title: 'Scroll to the error event in the scrollback',
            },
          ]}
        />
      )}

      {isRunning && run.pendingMutation && (
        <SessionBanner
          id={`multi-agent-warning-mutation-${run.sessionId}`}
          tier="warn"
          classStem="multi-agent-warning"
          layout="flat"
          role="status"
          ariaLive="polite"
          stealsFocus={false}
          body={
            <>
              <p>
                <strong>
                  <code>{run.pendingMutation.agentName}</code> is about to{' '}
                  <span className={`mutation-summary mutation-${run.pendingMutation.category}`}>
                    {run.pendingMutation.summary}
                  </span>
                  .
                </strong>
              </p>
              <p>
                You enabled "Pause before any worker mutates the filesystem" for this session. This
                is the first mutation. Continue to allow this call and let subsequent mutations
                auto-allow.
              </p>
            </>
          }
          actions={[
            {
              label: 'Continue with this mutation',
              variant: 'primary',
              onClick: () => props.onContinueThroughMutation(run.sessionId),
              title: 'Allow this tool call and any subsequent mutations in this session.',
            },
            {
              label: 'Stop session',
              onClick: () => props.onAbandonSession(run.sessionId),
              title: 'End the session as Stopped. The session folder and trail are preserved.',
            },
          ]}
        />
      )}

      {isRunning && (
        <AskUserQuestionCard
          pending={run.pendingQuestion}
          onSubmit={(agent, toolUseId, answers) =>
            props.onAnswerQuestion(run.sessionId, agent, toolUseId, answers)
          }
        />
      )}

      {isOrchestrator &&
        isRunning &&
        !run.awaitingContinue &&
        !run.pendingRetry &&
        !run.pendingMutation &&
        !run.pendingQuestion && (
          <UserPromptInput onSend={(text) => props.onSendUserPrompt(run.sessionId, text)} />
        )}
    </div>
  );
}

/**
 * Item #6: trust signal per bus participant, joined render-time from the
 * project's `trusted` flag. Bus workers always run with bypassPermissions, so
 * trust is not a runtime gate here — the chip exposes which projects the
 * operator has vouched for, which is otherwise invisible from this surface.
 *
 * Returns null when no project matches the slug (degenerate case: the project
 * was uninstalled/deleted mid-run). Caller renders nothing in that case.
 */
function ParticipantTrustChip(props: { slug: string; projects: Project[] }) {
  const project = props.projects.find((p) => p.busAgentName === props.slug);
  if (!project) return null;
  const trusted = project.trusted;
  const title = trusted
    ? `${project.name}: trusted. In a single-agent chat this project auto-allows every tool. Bus workers always run with bypassPermissions, so this trust signal is informational here — the worker's tool calls bypass the gate regardless.`
    : `${project.name}: untrusted. In a single-agent chat this project would prompt for non-edit tools. Bus workers always run with bypassPermissions, so this trust signal is informational here — the worker's tool calls bypass the gate regardless.`;
  return (
    <span
      className={`trust-tag ${trusted ? 'trusted' : 'untrusted'}`}
      title={title}
      aria-label={`${project.name} ${trusted ? 'trusted' : 'untrusted'}`}
    >
      {trusted ? 'trusted' : 'untrusted'}
    </span>
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
  /** Slug of the participant currently computing, or null if none. */
  activeAgent: string | null;
  onSetLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  onAddParticipant: (projectId: number) => void;
  /**
   * Cluster C Phase 4g2 → 4g5: per-participant control verbs from the ⋮
   * menu in each participant row. SessionId is already bound by the caller;
   * the menu provides (projectId, reasonCode, reasonText, …pauseExtras)
   * at the leaf. C4g5: reasonText collected by MuteReason/PauseReasonModal.
   */
  onMuteParticipant: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onUnmuteParticipant: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  onPauseParticipant: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => void;
  onResumeParticipant: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
  /**
   * Cluster C Phase 4g3: kick dispatch. The ⋮ menu opens KickModal; the
   * modal collects reasonCode + reasonText and calls back here with
   * mode pinned to 'drain'.
   */
  onKickParticipant: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) => void;
  /** Drives the (collapsed-by-default) routing-trail disclosure: the
   *  spine→scrollback jump highlight lives in ActiveRunView and is passed
   *  through so the trail can stay tucked inside this panel. */
  highlightedEventId: number | null;
  onJump: (eventId: number) => void;
}) {
  const { run } = props;
  const isOrchestrator = run.mode === 'orchestrator';
  // The active agent was delivered its turn at the last event's timestamp —
  // the closest proxy for "how long has it been working" (sub-second slack).
  const turnStartedAt = run.events.length ? run.events[run.events.length - 1].ts : null;
  const orchestratorSlug = isOrchestrator ? (run.participantAgentNames[0] ?? 'orchestrator') : null;
  const workerSlugs = isOrchestrator
    ? run.participantAgentNames.slice(1)
    : run.participantAgentNames;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Routing trail is tucked away here, collapsed by default — it's a
  // deep-inspect affordance, not something the operator needs every run.
  const [routingOpen, setRoutingOpen] = useState(false);
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
                {props.activeAgent === orchestratorSlug && (
                  <ThinkingIndicator
                    variant="inline"
                    phase="thinking"
                    startedAt={turnStartedAt}
                    label={orchestratorSlug}
                  />
                )}
              </li>
            )}
            {workerSlugs.map((slug, i) => {
              // Cluster C Phase 4g2: resolve slug→projectId so the ⋮ menu
              // can dispatch control verbs (envelopes are keyed by
              // projectId). When the slug doesn't match any project (e.g.
              // an off-roster participant, the orchestrator's `cebab`
              // sink, or a transient state), the menu is omitted.
              const proj = props.projects.find((p) => p.busAgentName === slug);
              const control = proj ? run.participantControls[proj.id] : undefined;
              return (
                <li key={slug} className="settings-participant">
                  <code>{slug}</code>
                  <ParticipantTrustChip slug={slug} projects={props.projects} />
                  {props.activeAgent === slug && (
                    <ThinkingIndicator
                      variant="inline"
                      phase="thinking"
                      startedAt={turnStartedAt}
                      label={slug}
                    />
                  )}
                  {/* Cluster C Phase 4g2: ⋮ menu — only mounted when the
                   *  run is in-flight (canEdit=true), the participant has
                   *  a project mapping, and we're in orchestrator mode (the
                   *  only mode that supports the full mute/pause/resume
                   *  vocabulary today; chain-mode pause+resume is
                   *  technically valid but holding off until 4g3 when the
                   *  topology guards have UI feedback). */}
                  {props.canEdit && isOrchestrator && proj && (
                    <ParticipantControlMenu
                      projectId={proj.id}
                      sessionId={run.sessionId}
                      agentLabel={slug}
                      sessionMode={run.mode}
                      control={control}
                      onMute={props.onMuteParticipant}
                      onUnmute={props.onUnmuteParticipant}
                      onPause={props.onPauseParticipant}
                      onResume={props.onResumeParticipant}
                      onKick={props.onKickParticipant}
                    />
                  )}
                  {!isOrchestrator && i < workerSlugs.length - 1 && (
                    <span className="settings-arrow">→</span>
                  )}
                </li>
              );
            })}
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

        <dt>Hop budget</dt>
        <dd>
          {run.events.length} / {run.hopBudget} hops
          {run.hopBudget > 0 && run.events.length / run.hopBudget >= 0.8 && (
            <span className="settings-grid-warn"> · ≥80% of cap</span>
          )}
        </dd>

        {/* Cluster B Phase 6e (UI-B9): authority inspector entry-point.
         *  Lives between Hop budget (the capacity row) and Mutations (the
         *  consequence row) per spec — authority is the *predicate* for
         *  what each participant can do. The button opens the
         *  AuthorityPreflightModal in aggregate mode (one panel per
         *  participant project); the dl row stays compact. */}
        {(() => {
          const participantProjectIds = workerSlugs
            .map((slug) => props.projects.find((p) => p.busAgentName === slug)?.id)
            .filter((id): id is number => typeof id === 'number');
          if (participantProjectIds.length === 0) return null;
          return (
            <>
              <dt>Authority</dt>
              <dd>
                <SessionSettingsAuthorityButton projectIds={participantProjectIds} />
              </dd>
            </>
          );
        })()}

        {run.mutations.length > 0 && (
          <>
            <dt>Mutations</dt>
            <dd>
              <MutationsDisclosure run={run} />
            </dd>
          </>
        )}

        {groupArtifacts(run.mutations).length > 0 && (
          <>
            <dt>Artifacts</dt>
            <dd>
              <ArtifactsDisclosure run={run} />
            </dd>
          </>
        )}

        <dt>Working files</dt>
        <dd>
          <WorkingFiles run={run} />
        </dd>

        {run.pauseOnMutation && (
          <>
            <dt>Pause on mutation</dt>
            <dd>
              {run.mutationsAcknowledged
                ? 'On · acknowledged (subsequent mutations auto-allow)'
                : 'On · pending first mutation'}
            </dd>
          </>
        )}

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

        {run.events.length > 0 && (
          <>
            <dt>Routing trail</dt>
            <dd>
              <button
                type="button"
                className="ghost-btn"
                aria-expanded={routingOpen}
                onClick={() => setRoutingOpen((open) => !open)}
                title="The full ordered hop trail (who routed to whom, verified-by-construction). Collapsed by default — expand to inspect or jump to a hop in the scrollback."
              >
                {routingOpen ? '▾' : '▸'} Routing trail · {run.events.length}{' '}
                {run.events.length === 1 ? 'hop' : 'hops'}
              </button>
              {routingOpen && (
                <RoutingSpine
                  run={run}
                  highlightedEventId={props.highlightedEventId}
                  onJump={props.onJump}
                />
              )}
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

/**
 * Top-bar attachment that lives next to the main tabs. Renders the active
 * run's identity (mode + short session id + status pill) and its actions
 * (Logs + Stop / End & cleanup / Close). Gating is done by the caller —
 * App.tsx only mounts this when `state.multiAgent.active && view !== 'chat'`.
 *
 * Owns the `stopPending` flag and the temp-lifecycle `confirm()` gate that
 * used to live in `ActiveRunView`. Mirrors the prior button JSX verbatim so
 * the visible affordances are unchanged — only the position moves.
 */
export function TopRunBar(props: {
  run: MultiAgentRun;
  onStop: (sessionId: string) => void;
  onDismiss: () => void;
  onLoadSessionLog: (
    sessionId: string,
    offset: number,
    limit: number,
    revealSensitive: boolean,
  ) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  const { run } = props;
  const isRunning = run.status === 'running';
  const isOrchestrator = run.mode === 'orchestrator';
  const isTemp = run.lifecycle === 'temp';
  const [stopPending, setStopPending] = useState(false);

  function handleStop() {
    if (!isTemp) {
      setStopPending(true);
      props.onStop(run.sessionId);
      return;
    }
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

  // Cluster E Phase 2.x (B4-1): summarize per-participant models for the
  // ModelChip. The reducer aggregates each session_started.model into
  // run.modelsByProject keyed by participant projectId; the helper
  // returns the common model if all entries match, 'various' if mixed,
  // or undefined if no participants have inited yet (chip falls back
  // to "default").
  const busModel = summarizeBusModel(run.modelsByProject);
  return (
    <div className="main-top-bar-right">
      <span className="main-top-bar-title">
        {run.mode === 'chain' ? 'Chained Chat' : 'Multi-Agent'}:{' '}
        <code>{run.sessionId.slice(0, 8)}</code>{' '}
        <span className={`run-status run-status-${run.status}`} title={STATUS_TITLE[run.status]}>
          {run.status}
        </span>
      </span>
      <ModelChip
        model={busModel}
        tooltipExtra={
          busModel === 'various'
            ? 'Participants reported different models — open Authority to inspect per-agent.'
            : undefined
        }
      />
      {/* Cluster G Phase 2c (UI-A3): per-run MOCK chip — sits beside the
       *  ModelChip because both qualify "what's running" (which model, and
       *  whether responses are real). Strict `=== true` so pre-G2c servers
       *  and live sessions both render nothing. Stays visible across R-A
       *  re-attach and R-B reconstruct: the row's `mock` column is locked
       *  at session creation, so a bus session created in mock keeps the
       *  badge even after the operator restarts Cebab in live mode. */}
      {run.mock === true && <MockBadge variant="inline" />}
      <LogsButton
        sessionId={run.sessionId}
        dangerousCount={
          run.mutations.filter((m) => m.category === 'dangerous' && m.confirmedAt !== null).length
        }
        onLoadSessionLog={props.onLoadSessionLog}
        subscribeServerMsg={props.subscribeServerMsg}
      />
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
  );
}

/**
 * Slim "what's running right now" strip, anchored under the main tab nav so
 * the operator can see the active agent without scrolling the scrollback.
 * Renders nothing unless a run is genuinely computing — hidden for the draft
 * view, finished runs, and R-B read-only recovered runs (awaitingContinue).
 */
export function MultiAgentActivityBar(props: {
  run: MultiAgentRun | null;
  /**
   * Cluster C Phase 4g1: projects list, used to map the active agent's
   * bus slug back to its `projectId` so we can render its
   * ParticipantStatePills (control envelopes are keyed by projectId).
   * Optional — when omitted (e.g. legacy call sites or tests), the pills
   * are simply not rendered; the chip + rest of the bar still work.
   */
  projects?: readonly Project[];
}) {
  const run = props.run;
  // Prefer the ephemeral heartbeat; fall back to the inferred active agent
  // (e.g. a live re-attach where `agent_activity` didn't reach this socket —
  // see the protocol JSDoc). One of the two is set by the time we render.
  const act = run?.activity ?? null;
  const fallbackAgent = run ? activeAgent(run) : null;
  const startedAt =
    act?.turnStartedAt ??
    (run && fallbackAgent && run.events.length ? run.events[run.events.length - 1].ts : null);
  // Hook called unconditionally (before any early return) to keep hook order
  // stable across renders.
  const elapsedMs = useElapsed(startedAt);

  if (!run || run.status !== 'running' || run.awaitingContinue || run.pendingRetry) return null;
  if (!act && !fallbackAgent) return null;

  const agentName = act?.agentName ?? fallbackAgent ?? '';
  const stalled = act?.phase === 'stalled';
  const tool = act?.currentTool;
  // Hop-budget chip: shows cumulative `events.length / hopBudget` with a
  // warn tint at ≥80% so the operator sees the cap approaching well before
  // the synthetic `cebab → _sink error` event lands.
  const hops = run.events.length;
  const budget = run.hopBudget;
  const budgetWarn = budget > 0 && hops / budget >= 0.8;

  // Cluster C Phase 4g1: resolve the active agent's per-participant control
  // state for the inline ParticipantStatePills mount. Wire-side envelopes
  // key by projectId, but the activity bar identifies the active agent by
  // bus slug — projects.busAgentName is the join key. Returns undefined
  // when no project matches (orchestrator, off-roster agent, or
  // `projects` not provided), in which case the pills component renders
  // null anyway.
  const activeAgentControl = (() => {
    if (!props.projects || agentName === '') return undefined;
    const proj = props.projects.find((p) => p.busAgentName === agentName);
    if (!proj) return undefined;
    return run.participantControls[proj.id];
  })();

  return (
    <div
      className={`ma-activity-bar${stalled ? ' is-stalled' : ''}`}
      role={stalled ? 'alert' : 'status'}
    >
      {stalled ? (
        // A hung worker must NOT look like a working one: static glyph,
        // never the breathing orb (no-color-only / no-motion-only).
        <span className="ma-stall-glyph" aria-hidden="true">
          ▢
        </span>
      ) : (
        <ThinkingIndicator
          variant="inline"
          phase={tool ? 'tool-running' : 'thinking'}
          startedAt={startedAt}
          toolName={tool}
          label={agentName}
        />
      )}
      <span className="ma-activity-text">
        <code>{agentName}</code>{' '}
        {stalled ? (
          <>
            <strong className="ma-stall-word">stalled</strong>
            {tool ? (
              <>
                {' · '}
                <code>{tool}</code>
              </>
            ) : null}
            {' · no output for '}
            {formatElapsed(elapsedMs)}
          </>
        ) : (
          <>
            <strong>working</strong>
            {tool ? (
              <>
                {' · running '}
                <code>{tool}</code>
              </>
            ) : null}
          </>
        )}
      </span>
      {/* Cluster C Phase 4g1: inline state pills for the currently active
       *  agent, when it has any control state. Sits right after the agent
       *  name so the operator's eye lands on "agent X is muted / paused /
       *  kicked" alongside the working indicator. */}
      <ParticipantStatePills control={activeAgentControl} />
      {/* Cluster G Phase 2c (UI-A3): per-run MOCK chip — placed right after
       *  the participant pills so the persistent posture cluster reads
       *  "agent X is muted/paused/kicked AND the run is MOCK" alongside
       *  the working indicator. Strict `=== true` mount predicate. */}
      {run.mock === true && <MockBadge variant="inline" />}
      <span
        className={`ma-hop-budget-chip${budgetWarn ? ' is-warn' : ''}`}
        aria-label={`hop budget: ${hops} of ${budget}`}
        title={
          budgetWarn
            ? `${hops} / ${budget} hops used — at or above 80% of the cap. The session stops when the cap is reached.`
            : `${hops} / ${budget} hops used. The session stops when the cap is reached; adjust the default in Settings or via CEBAB_HOP_BUDGET.`
        }
      >
        {hops} / {budget} hops
      </span>
      {run.mutations.length > 0 && <MutationsCounterChip mutations={run.mutations} />}
      {/* Cluster B Phase 6d (UI-B24): router-drops counter, hidden when
       *  count = 0. Sits after MutationsCounterChip per spec §6.2. */}
      <RouterDropsCounter drops={run.routerDrops} sessionId={run.sessionId} />
      {/* Cluster C Phase 4g1: aggregate per-participant control counter.
       *  Self-hides when count = 0. Sits after RouterDropsCounter so the
       *  "controls and constraints" cluster reads together. */}
      <ParticipantControlsCounter run={run} />
      {/* Cluster F Phase D5 (UI-D5): always-on "Consultant" reminder for
       *  orchestrator-mode runs only. Pairs with the ConsultantModeBanner
       *  in DraftView/TemplatePreviewModal; this chip is the at-a-glance
       *  reminder visible while the operator scrolls the scrollback. Chain
       *  runs have no consultant-mode prompt in `renderChainBriefing`, so
       *  surfacing the chip there would misrepresent agent posture. Trails
       *  the controls counter so the bar reads capacity → activity →
       *  exceptions → controls → guardrail. */}
      {run.mode === 'orchestrator' && <ConsultantModeChip />}
    </div>
  );
}

/**
 * Item #5: counter chip in the activity bar showing the cumulative mutation
 * count for this session. Amber by default; red when any mutation is
 * `dangerous`. Same render seam as the hop-budget chip. Click is not wired
 * in v1 (the disclosure is in Session info); the chip is read-only signal.
 */
function MutationsCounterChip(props: { mutations: MultiAgentMutationView[] }) {
  const n = props.mutations.length;
  const hasDangerous = props.mutations.some((m) => m.category === 'dangerous');
  return (
    <span
      className={`ma-mutations-chip${hasDangerous ? ' has-dangerous' : ''}`}
      aria-label={`${n} mutations${hasDangerous ? ' (some dangerous)' : ''}`}
      title={
        hasDangerous
          ? `${n} mutation${n === 1 ? '' : 's'} this session — at least one is classified dangerous. Open Session info to inspect.`
          : `${n} mutation${n === 1 ? '' : 's'} this session. Open Session info to inspect.`
      }
    >
      ⚠ {n}
    </span>
  );
}

/** No-color-only: every hop kind carries an icon AND its word. */
const KIND_MARK: Record<MultiAgentEventKind, string> = {
  intro: '↪',
  prompt: '›',
  reply: '↩',
  final: '◼',
  error: '✕',
};

/**
 * One scrollback row: full hop record (source → destination, kind, text).
 * Collapsed-body-by-default for the noisy kinds (intro/prompt/reply);
 * final/error/user-replies render expanded so the operator sees the
 * resolution without clicking. The metadata header is always rendered, so
 * `id="ev-<eventId>"` is a stable anchor for spine jumps and the Logs
 * `↗ event #N` deep-link.
 */
function EventRow(props: {
  event: MultiAgentEventView;
  defaultCollapsed: boolean;
  highlighted?: boolean;
}) {
  const { event } = props;
  // Initializer runs once per mount. Rows are keyed by eventId, so a
  // newly-streamed event mounts at its computed default while any row the
  // operator already toggled keeps its state as later events arrive.
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(event.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can fail under non-secure-context or denied
      // permissions. Leave the affordance idle; the operator can still
      // expand the message and select the text manually.
    }
  }
  const srcId = agentIdentity(event.source);
  return (
    <li
      id={`ev-${event.eventId}`}
      className={`event-row event-kind-${event.kind}${props.highlighted ? ' is-highlighted' : ''}`}
      data-agent-hue={srcId.hueVar ? '' : undefined}
      style={srcId.hueVar ? ({ '--agent-hue': srcId.hueVar } as CSSProperties) : undefined}
    >
      <div className="event-head">
        <button
          className={`icon-btn event-toggle${collapsed ? ' is-collapsed' : ''}`}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Show message' : 'Hide message (metadata only)'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <AgentTag slug={event.source} />
        <span className="event-arrow" aria-hidden="true">
          →
        </span>
        <AgentTag slug={event.destination} />
        <span className="event-kind">
          <span className="spine-kind-mark" aria-hidden="true">
            {KIND_MARK[event.kind]}
          </span>
          {event.kind}
        </span>
        <span className="event-ts">{formatTs(event.ts)}</span>
        <button
          className="icon-btn event-copy"
          onClick={copyText}
          title={copied ? 'Copied' : 'Copy message text'}
        >
          {copied ? '✓' : '⧉'}
        </button>
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
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: props.onClose });
  return (
    <div ref={overlayRef} className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
      <div className="modal event-modal modal-surface">
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

/**
 * Always-visible routing trail: one chip per persisted hop, in order. This
 * is the spine the operator reads instead of expanding N collapsed rows —
 * who routed to whom, what kind, when, all verified-by-construction (the
 * `bus_send` source is Cebab-pinned, unspoofable). Clicking a chip jumps to
 * (and briefly highlights) that hop's full row in the scrollback.
 */
function RoutingSpine(props: {
  run: MultiAgentRun;
  highlightedEventId: number | null;
  onJump: (eventId: number) => void;
}) {
  const { run } = props;
  if (run.events.length === 0) return null;
  return (
    <nav className="routing-spine" aria-label="Routing trail">
      <ol className="spine-list">
        {run.events.map((ev) => (
          <li key={ev.eventId}>
            <button
              type="button"
              className={`spine-chip event-kind-${ev.kind}${
                props.highlightedEventId === ev.eventId ? ' is-active' : ''
              }`}
              onClick={() => props.onJump(ev.eventId)}
              title={`Jump to this hop in the scrollback (${ev.source} → ${ev.destination}, ${ev.kind})`}
            >
              <AgentTag slug={ev.source} />
              <span className="spine-arrow" aria-hidden="true">
                →
              </span>
              <AgentTag slug={ev.destination} />
              <span className="spine-kind">
                <span className="spine-kind-mark" aria-hidden="true">
                  {KIND_MARK[ev.kind]}
                </span>
                {ev.kind}
              </span>
              <span
                className="spine-verified"
                title="Source is Cebab-pinned and unspoofable — every hop's sender is stamped server-side in the bus_send closure, not set by the agent."
              >
                <span aria-hidden="true">✔</span> verified
              </span>
              <span className="spine-ts">{formatTs(ev.ts)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
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

/**
 * Item #5: Mutations disclosure in Session info. Collapsed by default with a
 * `▸ N · contains dangerous` summary row; expanding lists every mutation
 * grouped by agent, in chronological order. Read-only tool calls are NOT in
 * this list — `multi_agent_mutations` only logs non-`read` rows.
 */
function MutationsDisclosure(props: { run: MultiAgentRun }) {
  const [open, setOpen] = useState(false);
  const { mutations } = props.run;
  const hasDangerous = mutations.some((m) => m.category === 'dangerous');
  // Group by agentName, preserving ts order within each group.
  const grouped = new Map<string, typeof mutations>();
  for (const m of mutations) {
    const list = grouped.get(m.agentName) ?? [];
    list.push(m);
    grouped.set(m.agentName, list);
  }
  return (
    <>
      <button
        type="button"
        className="ghost-btn ma-mutations-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Files written, edits, and Bash commands that mutated the filesystem during this session. Read-only tool calls are not listed."
      >
        {open ? '▾' : '▸'} {mutations.length} mutation{mutations.length === 1 ? '' : 's'}
        {hasDangerous && <span className="mutations-danger-marker"> · contains dangerous</span>}
      </button>
      {open && (
        <ol className="mutation-list">
          {[...grouped.entries()].map(([agent, list]) => (
            <li key={agent} className="mutation-group">
              <div className="mutation-agent">
                <code>{agent}</code> · {list.length}
              </div>
              <ul>
                {list.map((m) => (
                  <li
                    key={m.id}
                    className={`mutation-row mutation-${m.category}${
                      m.guardrailViolation ? ' has-guardrail-violation' : ''
                    }`}
                  >
                    <span className="mutation-icon" aria-hidden="true">
                      {m.category === 'dangerous' ? '⚠' : '✎'}
                    </span>
                    {/* Cluster F Phase F3 (UI-F3): when the server-side Bash
                     *  classifier produced a rationale, hang it off the
                     *  category badge as a `title` tooltip + aria-label. The
                     *  badge text itself stays the same ("MUTATE"/"DANGEROUS")
                     *  — operators who learn the rules can read the badge at a
                     *  glance, and operators who don't can hover for the
                     *  rule + matched fragment ("dangerous_subcommand:
                     *  'git push --force'"). For non-Bash mutations the tool
                     *  name (`Write`, `Edit`, …) is the rationale, so we fall
                     *  back to the existing label-only tooltip. */}
                    <span
                      className={`mutation-badge mutation-badge-${m.category}`}
                      data-testid="mutation-badge"
                      {...(m.classifierReason
                        ? {
                            title:
                              `${m.category.toUpperCase()} — classifier rule '${m.classifierReason.rule}'` +
                              ` matched '${m.classifierReason.matched}'.\n` +
                              `${m.classifierReason.detail}`,
                            'aria-label': `${m.category} (rule ${m.classifierReason.rule}, matched ${m.classifierReason.matched})`,
                          }
                        : {})}
                    >
                      {m.category.toUpperCase()}
                    </span>
                    <span className="mutation-tool">{m.toolName}</span>
                    <span className="mutation-summary">{m.summary}</span>
                    {/* Cluster F Phase D5+ (UI-D5+): orthogonal scope-violation
                     *  badge. Renders when the server's path classifier flagged
                     *  this mutation as targeting a file outside the agent's
                     *  project folder (the consultant-mode guardrail). The
                     *  tooltip names the resolved path so the operator can
                     *  judge whether their prompt actually authorized the
                     *  change. Independent of `category` — both axes can fire
                     *  on the same row (a dangerous Bash that wrote to /tmp
                     *  badges both ways). */}
                    {m.guardrailViolation && (
                      <span
                        className="mutation-guardrail-badge"
                        data-testid="mutation-guardrail-badge"
                        aria-label={`Out of scope: ${m.guardrailViolation.violatedPath}`}
                        title={
                          `Out-of-scope mutation: agent attempted to write to ${m.guardrailViolation.violatedPath}, ` +
                          `which is outside its project folder${
                            m.guardrailViolation.agentCwd
                              ? ` (${m.guardrailViolation.agentCwd})`
                              : ''
                          }. The consultant-mode prompt forbids mutations outside an agent's own folder unless your request explicitly directs it; this is advisory (no server-side enforcement). The safety_audit row carries the full forensic record.`
                        }
                      >
                        <span aria-hidden="true">↗</span> out of scope
                      </span>
                    )}
                    <span className="mutation-ts">{formatTs(m.ts)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * Sibling of `MutationsDisclosure` — collapses the `<ArtifactsView>` into a
 * Session-info row so promoted-file deliverables don't claim a full-width
 * scrollback-adjacent section. Same `▸/▾` ghost-btn pattern as Mutations and
 * Routing trail; caller (`SessionSettingsPanel`) only renders the row when
 * `groupArtifacts(run.mutations).length > 0`.
 */
function ArtifactsDisclosure(props: { run: MultiAgentRun }) {
  const [open, setOpen] = useState(false);
  const count = groupArtifacts(props.run.mutations).length;
  // Cluster I H3 UI: the WS send + side-channel subscribe for the lazy content
  // disclosure ride a context bridge (App mounts <ArtifactContentProvider>),
  // not props — this wrapper sits four typed-callback layers below MultiAgentTab.
  const { send, subscribeServerMsg } = useArtifactContentBridge();
  return (
    <>
      <button
        type="button"
        className="ghost-btn"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Promoted file mutations grouped by path. Subsequent edits to the same file collapse into the row's edit count."
      >
        {open ? '▾' : '▸'} {count} artifact{count === 1 ? '' : 's'}
      </button>
      {open && (
        <ArtifactsView run={props.run} send={send} subscribeServerMsg={subscribeServerMsg} />
      )}
    </>
  );
}

/**
 * Cluster B Phase 6e (UI-B9): in-session entry-point to the authority
 * inspector. Keeps the SessionSettingsPanel dl tight (button + modal) rather
 * than inlining a full panel. The modal opens in aggregate mode, one
 * AuthorityPanel per participant project.
 */
function SessionSettingsAuthorityButton(props: { projectIds: number[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ghost-btn ma-mutations-toggle"
        onClick={() => setOpen(true)}
        aria-label="Inspect resolved authority for all participants"
        title="Open the AuthorityPanel preflight inspector (one panel per participant project)"
      >
        ▸ Inspect {props.projectIds.length} participant
        {props.projectIds.length === 1 ? '' : 's'}…
      </button>
      {open && (
        <AuthorityPreflightModal projectIds={props.projectIds} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Cluster B Phase 6e (UI-B8 / DraftView per-participant): trailing icon
 * button on each participant row. Opens the preflight modal scoped to ONE
 * project — sibling pattern to the +new-chat ⓘ in ProjectList.
 */
function DraftParticipantAuthorityButton(props: { projectId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        title="Inspect resolved authority (tools, MCP servers, env, hooks) before starting"
        aria-label="Inspect authority for this participant"
        onClick={() => setOpen(true)}
      >
        ⓘ
      </button>
      {open && (
        <AuthorityPreflightModal projectIds={[props.projectId]} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * Cluster B Phase 6e (UI-B8 / DraftView composer): aggregate-mode inspect
 * button next to the composer textarea. Opens the preflight modal with
 * every participant project so the operator can review authority across
 * the whole draft before clicking Start.
 */
function DraftInspectAuthorityButton(props: { projectIds: number[] }) {
  const [open, setOpen] = useState(false);
  const label =
    props.projectIds.length === 1
      ? 'Inspect authority'
      : `Inspect authority · ${props.projectIds.length} participants`;
  return (
    <>
      <button
        type="button"
        className="ghost-btn multi-agent-inspect-btn"
        onClick={() => setOpen(true)}
        title="Open the AuthorityPanel preflight inspector for every participant in this draft"
      >
        {label}
      </button>
      {open && (
        <AuthorityPreflightModal projectIds={props.projectIds} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
