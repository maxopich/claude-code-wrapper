import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ParticipantControlView } from '../../store';
import type { ControlReasonCode, KickMode, PauseExpiryAction } from '@cebab/shared/protocol';
import { KickModal } from './KickModal';
import { MuteReasonModal, type MuteAction } from './MuteReasonModal';
import { PauseReasonModal } from './PauseReasonModal';
import { useForensicViewerActions } from './ForensicViewerContext';
import { nextIndex } from '../../listNavigation';

// Cluster C Phase 4g2 → 4g5: ⋮ menu on each participant row in the
// active-run Session info panel.
//
// History of this menu:
//   - 4g2: Mute / Unmute / Pause 5m / Pause 15m / Resume as direct
//     dispatches; reasonCode pinned to 'topology_repair'.
//   - 4g3: Kick… opens KickModal (reason picker + optional text).
//   - 4g4: Kicked-state row shows only "View forensics…".
//   - 4g5 (this file): every action goes through a reason-picker modal.
//     Mute/Unmute/Resume open MuteReasonModal (shared component);
//     Pause opens PauseReasonModal (adds duration + expiry pickers).
//     The Pause-5m / Pause-15m quick presets disappear from the menu
//     because they're now inside the modal as default selections.
//
// Conditional rendering:
//   - kicked → render only "View forensics…" (C4g4 forensic-viewer
//     affordance; no other verbs apply to a kicked agent).
//   - paused (alive) → show Resume… only; hide Pause… (one pause per
//     participant at a time).
//   - muted → show Unmute… instead of Mute….
//   - chain mode → hide Mute/Unmute entirely (server returns
//     `chain_mute_unsupported`; ship-side guard saves the round-trip).
//
// Closing: click-outside the panel closes via document mousedown handler;
// Escape closes via keydown. Modals own their own dismissal via
// useModalSurface — once a modal opens, the dropdown is already closed.
//
// Register U26: the panel declared `role="menu"` and implemented none of what
// that role obliges — opening moved focus nowhere, arrow keys did nothing,
// Escape stranded focus on a button that had just unmounted, and a bare <p>
// sat inside the menu (a role="menu" may only contain menuitem /
// menuitemcheckbox / menuitemradio / group / separator). All four are fixed
// below, on BOTH panels: the finding named the live-participant one at :274,
// but the kicked branch is a second role="menu" with the same gaps.

export type ParticipantControlMenuProps = {
  projectId: number;
  /**
   * Cluster C Phase 4g4: bus session id, required for opening the
   * KickForensicsModal (which fetches by sessionId + agentSlug). Not
   * needed for the C4g2 mute/pause/kick path because the parent binds
   * sessionId into the callbacks; the forensic viewer opens via a
   * sibling context, so we need it here.
   */
  sessionId: string;
  /**
   * Display label AND the bus agent slug used to identify this
   * participant on the wire. Phase 4g4's forensic fetch keys on this
   * value; Phases 4g1-4g3 only used it for display.
   */
  agentLabel: string;
  /** Active mode of the bus session; gates mute/unmute visibility. */
  sessionMode: 'chain' | 'orchestrator';
  /** Current control row for this participant (or undefined if untouched). */
  control: ParticipantControlView | undefined;
  /**
   * Operator-driven dispatchers. C4g5: every callback now carries the
   * `reasonText` field that the reason-picker modals collect (matches
   * the `reasonText?` field in each ClientMsg shape). Undefined means
   * the operator left the notes blank — the safety_audit row's
   * `payload_json` simply lacks that field.
   *
   * Cebab-u0s: each returns whether the verb reached the server. `false`
   * means the socket was not open and nothing was sent, so this menu keeps
   * the modal — and the reason typed into it — rather than closing over a
   * control the agent never received. The operator is told separately; all
   * this boolean decides is whether the dialog goes away.
   */
  onMute: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => boolean;
  onUnmute: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => boolean;
  onPause: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => boolean;
  onResume: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => boolean;
  /**
   * Cluster C Phase 4g3: kick dispatch. The menu opens the KickModal;
   * the modal collects reasonCode + reasonText and calls back here.
   * Mode is pinned to 'drain' in v1 (server rejects 'hard' with
   * `hard_kill_unsupported_v1`).
   */
  onKick: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) => boolean;
};

type ModalKind = null | 'mute' | 'unmute' | 'pause' | 'resume' | 'kick';

export function ParticipantControlMenu({
  projectId,
  sessionId,
  agentLabel,
  sessionMode,
  control,
  onMute,
  onUnmute,
  onPause,
  onResume,
  onKick,
}: ParticipantControlMenuProps) {
  const [open, setOpen] = useState(false);
  // C4g5: one modal slot per menu. The dropdown closes the moment any
  // modal opens (single-handed: operator clicks an item, modal takes
  // over, dropdown is gone). Only one modal can be open at a time
  // because each item path sets this state.
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // U26 focus management. `triggerRef` is where focus goes back to; `panelRef`
  // is attached to whichever of the two panels is mounted (never both).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // C4g4: forensic viewer context for the "View forensics…" item that
  // shows up on a kicked participant. The viewer is mounted globally
  // under <ForensicViewerProvider> in App.tsx; this component just
  // pokes the open action.
  const forensicActions = useForensicViewerActions();

  // Click-outside + Escape dismissal. Both attached only while open to
  // avoid the always-on listener footprint when no menu is on screen.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(ev: MouseEvent) {
      const root = containerRef.current;
      if (!root) return;
      const target = ev.target as Node | null;
      if (target && !root.contains(target)) setOpen(false);
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return;
      setOpen(false);
      // Escape returns focus to the trigger — the operator asked to leave the
      // menu, not to leave the page. A click OUTSIDE deliberately does not:
      // there the operator has already chosen where to be, and yanking focus
      // back would fight them. (APG's menu-button behaviour.)
      triggerRef.current?.focus();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus the first item when the menu opens. Without this the role announces
  // a menu and then leaves the operator's focus on the trigger, so the arrow
  // keys below would have had nothing to move.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  /**
   * Arrow / Home / End move focus between items. Bound on the panel rather
   * than each item: the keydown originates on the focused menuitem and bubbles
   * here, so one handler covers every item including ones added later.
   *
   * Menus wrap (APG) — `nextIndex` is told so explicitly. A key it doesn't
   * handle returns null and is left alone, so Tab and Escape still work.
   */
  function onPanelKeyDown(ev: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    // -1 when focus is somewhere unexpected; nextIndex treats that as "start".
    const current = items.indexOf(document.activeElement as HTMLElement);
    const target = nextIndex({ key: ev.key, current, count: items.length, wrap: true });
    if (target === null) return;
    ev.preventDefault();
    items[target]?.focus();
  }

  const isKicked = control?.kickedAt !== null && control?.kickedAt !== undefined;
  const isMuted = control?.muted === true;
  const isPaused =
    control?.pausedUntil !== null &&
    control?.pausedUntil !== undefined &&
    control.pausedUntil > Date.now();
  const muteAvailable = sessionMode === 'orchestrator';

  /**
   * Focus the trigger BEFORE the state update, on every path that closes the
   * panel in favour of a modal. `useModalSurface` captures
   * `document.activeElement` in a mount effect and restores it on close; the
   * menu item it would otherwise capture is unmounted in the same commit, so
   * without this line the modal's restore has nothing to return to and focus
   * falls to <body>. Doing it synchronously here (rather than in an effect)
   * sidesteps the child-before-parent effect ordering entirely.
   */
  function handOffFocusToTrigger() {
    triggerRef.current?.focus();
  }
  function openModal(kind: Exclude<ModalKind, null>) {
    handOffFocusToTrigger();
    setOpen(false);
    setActiveModal(kind);
  }
  function closeModal() {
    setActiveModal(null);
  }
  function openForensicsViewer() {
    handOffFocusToTrigger();
    setOpen(false);
    forensicActions.open(sessionId, agentLabel);
  }

  // Each handle* wraps the modal's onSubmit; it forwards to the parent
  // callback and closes the modal. The modal's own onClose runs after
  // onSubmit returns (see KickModal pattern), which sets activeModal to
  // null on the same render — closeModal() here is just defensive.
  //
  // Cebab-u0s: that second closer is exactly why gating only this file would
  // have changed nothing — the modal would still have closed itself. So the
  // boolean is returned onward to the modal, which now gates its own
  // `onClose()` too, and `closeModal()` here is gated for the same reason it
  // was defensive before: whichever path runs first must agree.
  function handleMuteSubmit(
    pid: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ): boolean {
    if (!onMute(pid, reasonCode, reasonText)) return false;
    closeModal();
    return true;
  }
  function handleUnmuteSubmit(
    pid: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ): boolean {
    if (!onUnmute(pid, reasonCode, reasonText)) return false;
    closeModal();
    return true;
  }
  function handlePauseSubmit(
    pid: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ): boolean {
    if (!onPause(pid, reasonCode, reasonText, timeoutMs, expiryAction)) return false;
    closeModal();
    return true;
  }
  function handleResumeSubmit(
    pid: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ): boolean {
    if (!onResume(pid, reasonCode, reasonText)) return false;
    closeModal();
    return true;
  }
  function handleKickSubmit(
    pid: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ): boolean {
    if (!onKick(pid, reasonCode, reasonText, mode)) return false;
    closeModal();
    return true;
  }

  // Kick available in orchestrator mode only; chain-mode kick of a
  // middle participant returns `chain_topology_broken`, and a kick of
  // the first/last participant is technically valid but would tear the
  // chain — surfacing the affordance asks the operator to think more
  // carefully than this v1 menu can support.
  const kickAvailable = sessionMode === 'orchestrator' && !isKicked;

  // Map the kind → action label/component for the shared MuteReasonModal.
  const muteModalActionFor: Record<'mute' | 'unmute' | 'resume', MuteAction> = {
    mute: 'mute',
    unmute: 'unmute',
    resume: 'resume',
  };
  const muteModalSubmitFor = {
    mute: handleMuteSubmit,
    unmute: handleUnmuteSubmit,
    resume: handleResumeSubmit,
  } as const;

  return (
    <div className="ma-control-menu" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="ma-control-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={isKicked ? `View forensics for ${agentLabel}` : `Controls for ${agentLabel}`}
        title={
          isKicked
            ? `View kick forensics for ${agentLabel}.`
            : `Mute / pause / resume controls for ${agentLabel}`
        }
        onClick={() => setOpen((cur) => !cur)}
      >
        ⋮
      </button>
      {open && isKicked && (
        <div
          role="menu"
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
          className="ma-control-menu-panel"
          aria-label={`${agentLabel} controls`}
        >
          {/* C4g4: kicked participants get only the forensic viewer
           *  affordance — every other verb is unavailable for a kicked
           *  agent (no unmute / unpause / unkick in v1). */}
          <button
            type="button"
            role="menuitem"
            className="ma-control-menu-item"
            onClick={openForensicsViewer}
            title={`Open the captured forensic bundle for ${agentLabel} (recent bus events, attributed mutations, audit lineage).`}
          >
            <span aria-hidden="true">🔍</span> View forensics…
          </button>
        </div>
      )}
      {open && !isKicked && (
        <div
          role="menu"
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
          className="ma-control-menu-panel"
          aria-label={`${agentLabel} controls`}
        >
          {muteAvailable && !isMuted && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item"
              onClick={() => openModal('mute')}
              title="Drop all outbound bus events from this participant at the router. The agent isn't told — its bus_send returns success regardless."
            >
              <span aria-hidden="true">⊘</span> Mute…
            </button>
          )}
          {muteAvailable && isMuted && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item"
              onClick={() => openModal('unmute')}
              title="Stop dropping this participant's outbound bus events. Routing resumes immediately."
            >
              <span aria-hidden="true">⊙</span> Unmute…
            </button>
          )}
          {!isPaused && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item"
              onClick={() => openModal('pause')}
              title="Hold incoming deliverTurn calls behind a pause gate. Choose duration and on-expiry behavior in the modal."
            >
              <span aria-hidden="true">⏸</span> Pause…
            </button>
          )}
          {isPaused && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item is-primary"
              onClick={() => openModal('resume')}
              title="Drain the pause gate; queued deliverTurn calls fire in order."
            >
              <span aria-hidden="true">▶</span> Resume…
            </button>
          )}
          {/* U26: this used to be a <p>, which a role="menu" may not contain —
           *  so the one sentence explaining an absent action was both invalid
           *  markup and, in menu-browsing mode, unread. It exists to explain
           *  why Mute is missing, and ARIA's answer to that is a DISABLED
           *  menu item: it stays in the accessibility tree, stays reachable by
           *  the arrow keys above, and announces its own reason. */}
          {!muteAvailable && (
            <button
              type="button"
              role="menuitem"
              aria-disabled="true"
              className="ma-control-menu-item is-unavailable"
              title="Muting a chain participant would break the topology — the server rejects it with `chain_mute_unsupported`."
            >
              <span aria-hidden="true">⊘</span> Mute — unavailable in chain mode
            </button>
          )}
          {kickAvailable && (
            <>
              <div className="ma-control-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ma-control-menu-item is-danger"
                onClick={() => openModal('kick')}
                title="Open the kick confirmation modal. Kick is terminal — there is no unkick verb in v1."
              >
                <span aria-hidden="true">⨯</span> Kick…
              </button>
            </>
          )}
        </div>
      )}
      {activeModal === 'mute' && (
        <MuteReasonModal
          action={muteModalActionFor.mute}
          projectId={projectId}
          agentLabel={agentLabel}
          onClose={closeModal}
          onSubmit={muteModalSubmitFor.mute}
        />
      )}
      {activeModal === 'unmute' && (
        <MuteReasonModal
          action={muteModalActionFor.unmute}
          projectId={projectId}
          agentLabel={agentLabel}
          onClose={closeModal}
          onSubmit={muteModalSubmitFor.unmute}
        />
      )}
      {activeModal === 'resume' && (
        <MuteReasonModal
          action={muteModalActionFor.resume}
          projectId={projectId}
          agentLabel={agentLabel}
          onClose={closeModal}
          onSubmit={muteModalSubmitFor.resume}
        />
      )}
      {activeModal === 'pause' && (
        <PauseReasonModal
          projectId={projectId}
          agentLabel={agentLabel}
          onClose={closeModal}
          onSubmit={handlePauseSubmit}
        />
      )}
      {activeModal === 'kick' && (
        <KickModal
          projectId={projectId}
          agentLabel={agentLabel}
          onClose={closeModal}
          onSubmit={handleKickSubmit}
        />
      )}
    </div>
  );
}
