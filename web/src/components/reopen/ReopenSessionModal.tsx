import { useEffect, useId, useRef, useState } from 'react';
import type { ReopenSessionFailureReason } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';
import type { ReopenState } from './ReopenContext';

// Cluster D Phase 5d (spec §6.3 / UI-D19, UI-D20, UI-D21): swept-session
// reopen confirmation modal. Renders one of three layouts depending on
// the context state:
//
//   - `probing` / `committing` — spinner + status text.
//   - `confirming`             — workspace-diff facts + optional ack
//                                checkbox + optional typed input.
//   - `failed`                 — terminal error + Close button.
//
// Typed-confirmation gate (BE-D21 — mirrored client-side so the operator
// can't fire the commit ClientMsg without satisfying it, AND server-side
// re-verified): fires when `filesChanged > 0` OR `!fullDiffAvailable`.
// Mirrors the server's `needsTypedGate` logic in
// `executeReopenSessionConfirmed`.
//
// Default focus per spec UI-D20: Cancel button (safer default). The
// modal's accessible name comes from the dynamic title — set per-state.

type ConfirmingState = Extract<ReopenState, { kind: 'confirming' }>;
type CommittingState = Extract<ReopenState, { kind: 'committing' }>;
type FailedState = Extract<ReopenState, { kind: 'failed' }>;
type ProbingState = Extract<ReopenState, { kind: 'probing' }>;

export type ReopenSessionModalProps = {
  state: Exclude<ReopenState, { kind: 'idle' }>;
  onConfirm: (args: { acknowledgedWorkspaceDiff: boolean; typedConfirmation?: string }) => void;
  onClose: () => void;
};

export function ReopenSessionModal({ state, onConfirm, onClose }: ReopenSessionModalProps) {
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const titleId = useId();

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay reopen-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface reopen-modal">
        {state.kind === 'probing' && <ProbingBody state={state} titleId={titleId} />}
        {state.kind === 'confirming' && (
          <ConfirmingBody state={state} titleId={titleId} onConfirm={onConfirm} onClose={onClose} />
        )}
        {state.kind === 'committing' && <CommittingBody state={state} titleId={titleId} />}
        {state.kind === 'failed' && (
          <FailedBody state={state} titleId={titleId} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function ProbingBody({ state, titleId }: { state: ProbingState; titleId: string }) {
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          Checking workspace…
        </h3>
      </header>
      <p className="gate-modal-help">
        Comparing the project against the swept session <code>{state.sessionId.slice(0, 8)}</code>{' '}
        so you can review what changed before reopening.
      </p>
      <div className="reopen-modal-spinner" aria-live="polite">
        <span className="btn-spinner" aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </div>
    </>
  );
}

function CommittingBody({ state, titleId }: { state: CommittingState; titleId: string }) {
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          Reopening…
        </h3>
      </header>
      <p className="gate-modal-help">
        Displacing the active session (if any) and reactivating{' '}
        <code>{state.sessionId.slice(0, 8)}</code>.
      </p>
      <div className="reopen-modal-spinner" aria-live="polite">
        <span className="btn-spinner" aria-hidden="true" />
        <span className="sr-only">Reopening</span>
      </div>
    </>
  );
}

function ConfirmingBody({
  state,
  titleId,
  onConfirm,
  onClose,
}: {
  state: ConfirmingState;
  titleId: string;
  onConfirm: ReopenSessionModalProps['onConfirm'];
  onClose: () => void;
}) {
  // Mirror of server-side `needsTypedGate` in
  // `executeReopenSessionConfirmed` — the client computes the same
  // predicate so the button stays consistent with the server's check.
  // Both treat `!fullDiffAvailable` as safe-by-default require-typed.
  const needsTypedGate = state.diff.filesChanged > 0 || !state.diff.fullDiffAvailable;

  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Default focus on Cancel per spec UI-D20 — operator must reach for
  // Reopen deliberately. Re-runs only on mount; subsequent re-renders
  // (e.g. checkbox toggle) keep focus where the operator put it.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const typedOk = !needsTypedGate || typed === 'reopen';
  const canSubmit = acknowledged && typedOk;

  function handleSubmit() {
    if (!canSubmit) return;
    onConfirm({
      acknowledgedWorkspaceDiff: acknowledged,
      ...(needsTypedGate ? { typedConfirmation: typed } : {}),
    });
  }

  const { diff } = state;
  const isClean = diff.fullDiffAvailable && diff.filesChanged === 0;

  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          Reopen this session?
        </h3>
      </header>
      <p className="gate-modal-help">
        Reopening will set aside your current active session and bring{' '}
        <code>{state.sessionId.slice(0, 8)}</code> back. You can archive or reopen either side
        later.
      </p>
      <dl className="gate-modal-facts reopen-modal-facts">
        <div className="gate-modal-fact">
          <dt>Comparing against</dt>
          <dd>
            <code className="gate-modal-path">{state.projectPath}</code>
          </dd>
        </div>
        {isClean ? (
          <div className="gate-modal-fact">
            <dt>Workspace</dt>
            <dd className="reopen-modal-clean">
              No uncommitted changes (matches the last clean commit).
            </dd>
          </div>
        ) : !diff.fullDiffAvailable ? (
          <div className="gate-modal-fact">
            <dt>Workspace</dt>
            <dd className="reopen-modal-no-git">
              Couldn&apos;t enumerate changes (not a git repo, or git is missing). Treat as
              modified.
            </dd>
          </div>
        ) : (
          <>
            <div className="gate-modal-fact">
              <dt>Workspace</dt>
              <dd className="reopen-modal-dirty">
                <strong>{diff.filesChanged}</strong> file{diff.filesChanged === 1 ? '' : 's'}{' '}
                changed
                {diff.filesAdded > 0 && (
                  <span className="reopen-modal-detail"> · {diff.filesAdded} added</span>
                )}
                {diff.filesDeleted > 0 && (
                  <span className="reopen-modal-detail"> · {diff.filesDeleted} deleted</span>
                )}
              </dd>
            </div>
            {diff.sampleChanges.length > 0 && (
              <div className="gate-modal-fact">
                <dt>Sample paths</dt>
                <dd>
                  <ul className="reopen-modal-samples">
                    {diff.sampleChanges.map((p) => (
                      <li key={p}>
                        <code>{p}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </>
        )}
      </dl>

      {state.lastFailureMessage && (
        <p className="reopen-modal-error" role="alert">
          {state.lastFailureMessage}
        </p>
      )}

      <label className="reopen-modal-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>
          I understand the workspace may have changed since this session ran, and any unfinished
          work in the active session will be set aside.
        </span>
      </label>

      {needsTypedGate && (
        <label className="reopen-modal-typed">
          <span className="reopen-modal-typed-prompt">
            Type <code>reopen</code> to confirm:
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Type reopen to confirm"
          />
        </label>
      )}

      <div className="gate-modal-buttons">
        <button
          type="button"
          ref={cancelRef}
          className="ghost-btn gate-modal-btn"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ghost-btn gate-modal-btn gate-modal-btn-primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
          title={
            canSubmit
              ? undefined
              : needsTypedGate
                ? 'Tick the acknowledgement and type "reopen" to enable.'
                : 'Tick the acknowledgement to enable.'
          }
        >
          Reopen
        </button>
      </div>
    </>
  );
}

const FAILURE_TITLE: Record<ReopenSessionFailureReason, string> = {
  not_found: 'Session not found',
  still_running: 'Session is already running',
  no_participant: 'No participant project',
  ack_required: 'Acknowledgment required',
  typed_confirmation_required: 'Typed confirmation required',
  chain_reconstruction_unsupported: 'Cannot reopen chain session',
  reactivate_failed: 'Reactivation failed',
};

function FailedBody({
  state,
  titleId,
  onClose,
}: {
  state: FailedState;
  titleId: string;
  onClose: () => void;
}) {
  // Reuse the gate-modal-reason chip to surface the reason as a colored
  // tag, mirroring the McpTofuModal pattern.
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          {FAILURE_TITLE[state.reason]}
        </h3>
        <span className="gate-modal-reason reopen-modal-failed-reason">{state.reason}</span>
      </header>
      <p className="gate-modal-help">{state.message}</p>
      <div className="gate-modal-buttons">
        <button
          type="button"
          className="ghost-btn gate-modal-btn gate-modal-btn-primary"
          onClick={onClose}
          autoFocus
        >
          Close
        </button>
      </div>
    </>
  );
}
