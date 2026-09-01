import { useEffect, useRef } from 'react';
import type { ServerMsg } from '@cebab/shared/protocol';
import { useModalSurface } from '../useModalSurface';

/**
 * Cebab-m1f — confirm deleting a managed agent.
 *
 * The mirror of `ManagedCopyModal`, and deliberately blunter. The copy shows a
 * measured size before a reversible act; this destroys the agent's files, its
 * conversations and its logs, and none of that comes back. So it opens straight
 * on a confirm — no preflight to soften it — and the primary button is not the
 * one that gets focus.
 */

export type ManagedDeleteState = {
  projectId: number;
  name: string;
  status: 'confirming' | 'deleting' | 'done';
  result: Extract<ServerMsg, { type: 'managed_delete_result' }>['result'] | null;
};

export type ManagedDeleteModalProps = {
  state: ManagedDeleteState;
  onConfirm: () => void;
  onClose: () => void;
};

export function ManagedDeleteModal({ state, onConfirm, onClose }: ManagedDeleteModalProps) {
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = `managed-delete-title-${state.projectId}`;

  useEffect(() => {
    // Focus the safe control first — the destructive button must not catch a
    // Return keypress meant for whatever had focus a moment ago.
    closeBtnRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface managed-delete-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Delete {state.name}
          </h3>
        </header>
        <p className="gate-modal-help">
          This removes Cebab's copy of the agent — its files, its conversations and its logs. It
          cannot be undone, and only affects this copy: nothing in your own workspace is touched.
        </p>

        {state.status === 'deleting' && (
          <p className="gate-modal-help managed-delete-progress" role="status">
            Deleting…
          </p>
        )}

        {state.status === 'done' && state.result && (
          <p
            className={`gate-modal-help ${state.result.ok ? 'managed-delete-done' : 'managed-delete-error'}`}
            data-testid="managed-delete-outcome"
            role="status"
          >
            {state.result.ok
              ? `Deleted ${state.result.name}${
                  state.result.sessionsRemoved > 0
                    ? ` and its ${state.result.sessionsRemoved.toLocaleString('en')} conversation${
                        state.result.sessionsRemoved === 1 ? '' : 's'
                      }`
                    : ''
                }.`
              : state.result.error}
          </p>
        )}

        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={closeBtnRef}
            className="ghost-btn gate-modal-btn"
            onClick={onClose}
          >
            {state.status === 'done' ? 'Done' : 'Cancel'}
          </button>
          {state.status !== 'done' && (
            <button
              type="button"
              className="ghost-btn gate-modal-btn gate-modal-btn-danger"
              onClick={onConfirm}
              disabled={state.status === 'deleting'}
            >
              {state.status === 'deleting' ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
