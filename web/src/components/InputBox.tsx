import { useState, type KeyboardEvent } from "react";

export function InputBox(props: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");

  function send() {
    const v = text.trim();
    if (!v) return;
    props.onSend(v);
    setText("");
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="input-box">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        placeholder="Message Claude. Enter to send, Shift+Enter for newline."
        disabled={props.disabled}
      />
      <button onClick={send} disabled={props.disabled || !text.trim()}>
        Send
      </button>
    </div>
  );
}
