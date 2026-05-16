import { useState } from 'react';
import { GrowTextarea } from './GrowTextarea';

export function InputBox(props: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  function send() {
    const v = text.trim();
    if (!v) return;
    props.onSend(v);
    setText('');
  }

  return (
    <div className="input-box">
      <GrowTextarea
        value={text}
        onChange={setText}
        onSubmit={send}
        disabled={props.disabled}
        placeholder="Message Claude. Enter to send, Shift+Enter for newline."
        ariaLabel="Message Claude"
      />
      <button onClick={send} disabled={props.disabled || !text.trim()}>
        Send
      </button>
    </div>
  );
}
