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
  const { session } = useAssistant();
  const hasContent = session != null && session.messages.length > 0;

  return (
    <div className="assistant-panel" role="dialog" aria-label="Cebab assistant">
      <header className="assistant-panel-header">
        <span className="assistant-panel-title">Assistant</span>
        <button
          type="button"
          className="assistant-panel-close icon-btn"
          onClick={onClose}
          aria-label="Close assistant"
          title="Close assistant"
        >
          ✕
        </button>
      </header>
      {hasContent ? <AssistantTranscript session={session} /> : <AssistantEmptyState />}
      <AssistantComposer />
    </div>
  );
}
