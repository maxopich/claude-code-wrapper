import { useEffect, useId, useRef } from 'react';
import { useModalSurface } from '../../useModalSurface';
import type { AuthRefreshState } from './AuthRefreshContext';

// Cluster D Phase 6c (spec §6.4 / UI-D22 follow-up): the modal that
// drives the `claude login` subprocess via the AuthRefreshContext
// state machine. Renders one of four layouts depending on context
// state:
//
//   - `spawning`  — spinner + "Spawning claude login…" (transient).
//   - `running`   — terminal-style output area + Cancel button.
//   - `completed` — success/failure verdict + final output + Close.
//   - `failed`    — start-time error + Close (no Cancel — nothing to
//                   cancel; the spawn never started).
//
// The output display uses a `<pre>` with overflow-auto, monospace
// font, and auto-scroll-to-bottom on new chunks. We don't try to
// parse ANSI color codes — `claude login` produces plain text status
// + the OAuth URL. If a future version starts emitting color codes,
// the modal will render them as gibberish but the URL extraction will
// still work for the operator (they can copy it manually).
//
// Default focus: Cancel button while running (UI-D20 pattern from the
// ReopenSessionModal — safer default for a destructive in-flight
// action); Close button on terminal states (the only action available).

type SpawningState = Extract<AuthRefreshState, { kind: 'spawning' }>;
type RunningState = Extract<AuthRefreshState, { kind: 'running' }>;
type CompletedState = Extract<AuthRefreshState, { kind: 'completed' }>;
type FailedState = Extract<AuthRefreshState, { kind: 'failed' }>;

export type AuthRefreshModalProps = {
  state: Exclude<AuthRefreshState, { kind: 'idle' }>;
  onCancel: () => void;
  onClose: () => void;
};

export function AuthRefreshModal({ state, onCancel, onClose }: AuthRefreshModalProps) {
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const titleId = useId();

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay auth-refresh-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface auth-refresh-modal">
        {state.kind === 'spawning' && <SpawningBody state={state} titleId={titleId} />}
        {state.kind === 'running' && (
          <RunningBody state={state} titleId={titleId} onCancel={onCancel} />
        )}
        {state.kind === 'completed' && (
          <CompletedBody state={state} titleId={titleId} onClose={onClose} />
        )}
        {state.kind === 'failed' && (
          <FailedBody state={state} titleId={titleId} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function SpawningBody({ titleId }: { state: SpawningState; titleId: string }) {
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          Spawning <code>claude login</code>…
        </h3>
      </header>
      <p className="gate-modal-help">
        Asking the server to start the auth-refresh subprocess. Output will appear here once it's
        ready.
      </p>
      <div className="auth-refresh-modal-spinner" aria-live="polite">
        <span className="btn-spinner" aria-hidden="true" />
        <span className="sr-only">Spawning</span>
      </div>
    </>
  );
}

function RunningBody({
  state,
  titleId,
  onCancel,
}: {
  state: RunningState;
  titleId: string;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Default focus on Cancel (matches ReopenSessionModal's UI-D20 pattern
  // — safer default for a destructive in-flight action). Re-runs only
  // on mount.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Auto-scroll the output area to the bottom on new chunks so the
  // operator always sees the latest line (terminal convention). We
  // re-run when state.output length changes, which captures every
  // new chunk regardless of which stream it came from.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.output]);

  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          Re-authenticating…
        </h3>
        <span className="gate-modal-reason auth-refresh-modal-pid" title="Subprocess PID">
          pid {state.pid}
        </span>
      </header>
      <p className="gate-modal-help">
        Follow the URL <code>claude login</code> prints below to complete OAuth in your browser.
        This modal will close itself once the subprocess exits — your subscription credentials will
        refresh automatically.
      </p>
      <pre
        ref={outputRef}
        className="auth-refresh-modal-output"
        aria-label="claude login output"
        aria-live="polite"
      >
        {state.output || (
          <span className="auth-refresh-modal-output-placeholder">Waiting for output…</span>
        )}
      </pre>
      <div className="gate-modal-buttons">
        <button
          type="button"
          ref={cancelRef}
          className="ghost-btn gate-modal-btn"
          onClick={onCancel}
          title="Kill the claude login subprocess. The credentials file will only be updated if OAuth completed before cancellation."
        >
          Cancel
        </button>
      </div>
    </>
  );
}

function CompletedBody({
  state,
  titleId,
  onClose,
}: {
  state: CompletedState;
  titleId: string;
  onClose: () => void;
}) {
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          {state.success ? 'Re-authenticated' : 'Re-authentication failed'}
        </h3>
        <span
          className={
            state.success
              ? 'gate-modal-reason auth-refresh-modal-exit-success'
              : 'gate-modal-reason auth-refresh-modal-exit-failed'
          }
          title="Subprocess exit code"
        >
          exit {state.exitCode === null ? 'killed' : state.exitCode}
        </span>
      </header>
      <p className="gate-modal-help">
        {state.success
          ? 'The subprocess exited cleanly. The auth-expired banner will clear the next time a session starts (proof the new credentials work).'
          : state.exitCode === null
            ? 'The subprocess was cancelled or timed out before exiting normally. Credentials may not have been updated.'
            : `The subprocess exited with code ${state.exitCode}. Check the output below for the failure reason.`}
      </p>
      {state.output && (
        <pre className="auth-refresh-modal-output" aria-label="claude login final output">
          {state.output}
        </pre>
      )}
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

const FAILURE_TITLE = {
  already_running: 'Another auth refresh is in progress',
  spawn_failed: 'Failed to spawn claude login',
} as const;

function FailedBody({
  state,
  titleId,
  onClose,
}: {
  state: FailedState;
  titleId: string;
  onClose: () => void;
}) {
  return (
    <>
      <header className="gate-modal-header">
        <h3 id={titleId} className="gate-modal-title">
          {FAILURE_TITLE[state.reason]}
        </h3>
        <span className="gate-modal-reason auth-refresh-modal-failed-reason">{state.reason}</span>
      </header>
      <p className="gate-modal-help">
        {state.reason === 'already_running' ? (
          <>
            Another browser tab (or window) is already running a <code>claude login</code> refresh.
            Wait for it to complete, or cancel it from that tab.
            {state.existingRunId && (
              <>
                {' '}
                <span className="auth-refresh-modal-existing-run-id">
                  (existing run: <code>{state.existingRunId.slice(0, 8)}</code>)
                </span>
              </>
            )}
          </>
        ) : (
          <>
            Couldn't start the auth-refresh subprocess. The most common cause is the{' '}
            <code>claude</code> binary not being on the server's PATH. You can still run{' '}
            <code>claude login</code> manually in a terminal.
            {state.error && (
              <span className="auth-refresh-modal-error-detail">
                {' '}
                Server reported: {state.error}
              </span>
            )}
          </>
        )}
      </p>
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
