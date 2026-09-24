import { useAssistant } from './AssistantContext';
import { AssistantTranscript } from './AssistantTranscript';
import { AssistantComposer } from './AssistantComposer';
import { AssistantEmptyState } from './AssistantEmptyState';

/**
 * Cebab-8x8.3.2: the assistant popover body.
 *
 * A POPOVER, not a modal: no focus trap, no `inert` on siblings, no body
 * scroll lock (the dock, not `useModalSurface`, owns open/close — the app
 * stays interactive behind it, the way support widgets behave). The
 * `role="dialog"` here names the surface for assistive tech without changing
 * that; the dock manages Esc-close + focus restore to the trigger.
 *
 * Shows the four-chip empty state until the conversation has content, then the
 * transcript. The composer is always mounted so the operator can type from the
 * empty state too.
 */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const { session, running, reset } = useAssistant();
  const hasContent = session != null && session.messages.length > 0;

  return (
    <div className="assistant-panel" role="dialog" aria-label="Cebab help">
      <header className="assistant-panel-header">
        <span className="assistant-panel-title">Cebab help</span>
        {/* Cebab-eo71: the header's controls live in a group so a third button
            can't land mid-header (the header is space-between with the title). */}
        <div className="assistant-panel-actions">
          <button
            type="button"
            className="assistant-panel-newconv"
            onClick={reset}
            disabled={running || session == null}
            aria-label="New conversation"
            title="New conversation"
          >
            New conversation
          </button>
          <button
            type="button"
            className="assistant-panel-close icon-btn"
            onClick={onClose}
            aria-label="Close help"
            title="Close help"
          >
            ✕
          </button>
        </div>
      </header>
      {hasContent ? <AssistantTranscript session={session} /> : <AssistantEmptyState />}
      <AssistantComposer />
    </div>
  );
}
