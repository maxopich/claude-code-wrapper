import { useEffect, useRef, useState } from 'react';
import { GrowTextarea } from './GrowTextarea';
import { Icon } from './Icon';

/**
 * Cluster C Phase 1 (spec §4.1-4.3): single-agent message composer.
 *
 * The button is a stateful Send / Stop swap rather than two distinct
 * elements (UI-1: one DOM node, focus survives transition). When
 * `isRunning` is true, the in-flight `interrupt` ClientMsg is the
 * only meaningful action the operator can take; sending a new
 * message while one is in-flight isn't supported by the single-agent
 * runner. The textarea stays enabled while running so the operator
 * can draft the next message (UI-6).
 *
 * `disabled` and `isRunning` are distinct:
 *   - `disabled` = no active project / workspace unconfigured /
 *     unrecoverable state. Both textarea + button are disabled.
 *   - `isRunning` = a turn is in flight. Textarea enabled (drafting
 *     next prompt); button shows Stop variant.
 *
 * Esc keypress while the textarea has focus fires `onStop` (UI-7).
 * Until H1 ships the global ?-cheatsheet, this is the only Stop
 * keyboard shortcut. We don't try to intercept Esc globally — the
 * intent ("stop this turn") only makes sense when the composer or
 * scrollback has focus, and scoping to the composer wrapper keeps
 * the binding from leaking into modals or other inputs.
 */

export function InputBox(props: {
  disabled?: boolean;
  isRunning?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [text, setText] = useState('');
  // Cluster C Phase 1: once Stop is clicked we flip into a local
  // "stopping" state to disable the button until the parent reports
  // isRunning=false. Guards against double-click sending two
  // interrupts; the second click is silently swallowed by the
  // disabled attribute. Server is idempotent on duplicate interrupts
  // anyway (BE-3), so this is purely a UI affordance.
  const [stopping, setStopping] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Reset stopping flag whenever the parent reports the turn has
  // ended (isRunning flips back to false). This is the canonical
  // "stop completed" signal — see spec §4.4 "Observable post-interrupt
  // state on the wire": `session_running { running: false }` is the
  // ONLY guaranteed terminal envelope.
  useEffect(() => {
    if (!props.isRunning) setStopping(false);
  }, [props.isRunning]);

  function send() {
    const v = text.trim();
    if (!v) return;
    props.onSend(v);
    setText('');
  }

  function stop() {
    if (!props.onStop || stopping) return;
    setStopping(true);
    props.onStop();
  }

  // Esc-to-stop: scoped to the composer's wrapping div so the handler
  // only fires while focus is inside this component (UI-7). Global
  // keyboard routing lands with H1's cheatsheet.
  //
  // Inline closure so we capture the latest `stopping` state on every
  // render — re-binding only when the running/callback identity
  // changes. `wrapRef.current` resolves at effect time.
  const isRunning = props.isRunning;
  const onStop = props.onStop;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !isRunning || !onStop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && onStop) {
        e.preventDefault();
        if (!stopping) {
          setStopping(true);
          onStop();
        }
      }
    }
    wrap.addEventListener('keydown', onKey);
    return () => wrap.removeEventListener('keydown', onKey);
  }, [isRunning, onStop, stopping]);

  // Button state machine:
  //   - disabled (project not picked / workspace bad) → disabled Send
  //   - running + stopping (operator just clicked) → disabled Stop with spinner copy
  //   - running → Stop button (always enabled regardless of textarea)
  //   - idle → Send button (enabled iff textarea non-empty)
  const showStop = props.isRunning === true;
  const buttonDisabled =
    props.disabled === true ? true : showStop ? stopping : !text.trim();

  return (
    <div className="input-box" ref={wrapRef}>
      <GrowTextarea
        value={text}
        onChange={setText}
        onSubmit={send}
        // UI-6: textarea remains usable while a turn runs so the
        // operator can compose the follow-up. Only "structurally
        // disabled" (no project / workspace bad) makes it read-only.
        disabled={props.disabled}
        placeholder="Message Claude. Enter to send, Shift+Enter for newline."
        ariaLabel="Message Claude"
      />
      {showStop ? (
        <button
          type="button"
          className={`input-box-btn input-box-btn-stop${stopping ? ' is-stopping' : ''}`}
          onClick={stop}
          disabled={buttonDisabled}
          aria-label={stopping ? 'Stopping the current response' : 'Stop the current response'}
          title={stopping ? 'Stopping…' : 'Stop (Esc)'}
        >
          <Icon name="stop" />
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      ) : (
        <button
          type="button"
          className="input-box-btn input-box-btn-send"
          onClick={send}
          disabled={buttonDisabled}
          aria-label="Send message"
        >
          <Icon name="send" />
          Send
        </button>
      )}
    </div>
  );
}
