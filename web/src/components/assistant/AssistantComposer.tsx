import { useState } from 'react';
import { GrowTextarea } from '../GrowTextarea';
import { Icon } from '../Icon';
import { useAssistant } from './AssistantContext';

/**
 * Cebab-8x8.3.2: the assistant widget's input row.
 *
 * A trimmed cousin of {@link InputBox} — reuses {@link GrowTextarea} (Enter
 * submits, Shift+Enter newlines) rather than InputBox itself, which threads
 * far more SessionView (draft persistence, slash palette, mode chips) than a
 * popup should carry. Sending is delegated to the provider's `sendMessage`,
 * which optimistically echoes the text and ships the `send_message`.
 */
export function AssistantComposer() {
  const { sendMessage } = useAssistant();
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText('');
  };

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
    </div>
  );
}
