import { useState } from 'react';
import { GrowTextarea } from '../GrowTextarea';
import { Icon } from '../Icon';
import { useAssistant } from './AssistantContext';
import { PENDING_SESSION_ID } from './assistantReducer';

/**
 * Cebab-8x8.3.2: the assistant widget's input row.
 *
 * A trimmed cousin of {@link InputBox} — reuses {@link GrowTextarea} (Enter
 * submits, Shift+Enter newlines) rather than InputBox itself, which threads
 * far more SessionView (draft persistence, slash palette, mode chips) than a
 * popup should carry. Sending is delegated to the provider's `sendMessage`,
 * which optimistically echoes the text and ships the `send_message`.
 *
 * Cebab-eo71: while an answer runs, Send is replaced by a Stop button and Enter
 * no longer sends — the server refuses a second turn on a busy session. Stop
 * stays disabled until the server has handed back a real session id (there is
 * nothing to interrupt before then).
 */
export function AssistantComposer() {
  const { sendMessage, running, stop, session } = useAssistant();
  const [text, setText] = useState('');

  const submit = () => {
    if (running) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText('');
  };

  // The interrupt needs the adopted id; before it lands the session is still the
  // optimistic placeholder, so Stop has nothing to send.
  const canStop = running && session != null && session.id !== PENDING_SESSION_ID;

  return (
    <div className="assistant-composer">
      <GrowTextarea
        value={text}
        onChange={setText}
        onSubmit={submit}
        minRows={2}
        placeholder="Ask about Cebab…"
        ariaLabel="Message the assistant"
      />
      {running ? (
        <button
          type="button"
          className="assistant-send icon-btn"
          onClick={stop}
          disabled={!canStop}
          aria-label="Stop the answer"
          title="Stop the answer"
        >
          <Icon name="stop" />
        </button>
      ) : (
        <button
          type="button"
          className="assistant-send icon-btn"
          onClick={submit}
          disabled={text.trim() === ''}
          aria-label="Send message"
          title="Send message"
        >
          <Icon name="send" />
        </button>
      )}
    </div>
  );
}
