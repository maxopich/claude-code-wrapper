import { useEffect, useRef, useState } from 'react';
import { GrowTextarea } from './GrowTextarea';
import { Icon } from './Icon';
import { SlashCommandPalette } from './SlashCommandPalette';

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
 *
 * Cluster E Phase 1 (E1): slash command palette overlay.
 *   - `/` at cursor 0 + empty textarea → open palette (the `/` keypress
 *     is suppressed so it doesn't land in the textarea).
 *   - `Cmd/Ctrl+K` from any caret position → open palette.
 *   - When palette is open, Esc closes it (precedence over Esc-to-stop;
 *     see spec §H1-6: open palette > open modal > top banner > Stop).
 *   - On select: replace textarea with `<command>` + space. The
 *     operator presses Send when ready (no auto-send).
 */

export function InputBox(props: {
  disabled?: boolean;
  isRunning?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  /**
   * Cluster E Phase 1: SDK-discovered slash commands from
   * `session_started.slashCommands[]` (Cluster B Phase 2 forwarded
   * this on every init). Passed verbatim into the palette as the
   * "Discovered from session" group. Undefined or empty array =
   * palette shows only the Cebab-local section.
   */
  sdkSlashCommands?: readonly string[];
}) {
  const [text, setText] = useState('');
  // Cluster C Phase 1: once Stop is clicked we flip into a local
  // "stopping" state to disable the button until the parent reports
  // isRunning=false. Guards against double-click sending two
  // interrupts; the second click is silently swallowed by the
  // disabled attribute. Server is idempotent on duplicate interrupts
  // anyway (BE-3), so this is purely a UI affordance.
  const [stopping, setStopping] = useState(false);
  // Cluster E Phase 1: palette open/closed state. Owned here because
  // the trigger keys are detected at the textarea level and the
  // palette is rendered above the textarea (inside `.input-box`).
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  //
  // Cluster E Phase 1: the palette has Esc-precedence (spec §H1-6),
  // so the Esc-to-stop handler short-circuits when the palette is
  // open — the palette owns Esc dismissal in that state.
  const isRunning = props.isRunning;
  const onStop = props.onStop;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !isRunning || !onStop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && onStop) {
        // Palette is the higher-precedence Esc handler — leave it alone.
        if (paletteOpen) return;
        e.preventDefault();
        if (!stopping) {
          setStopping(true);
          onStop();
        }
      }
    }
    wrap.addEventListener('keydown', onKey);
    return () => wrap.removeEventListener('keydown', onKey);
  }, [isRunning, onStop, stopping, paletteOpen]);

  // Cluster E Phase 1: trigger detection for the palette. We attach to
  // the wrap (not the textarea) so the listener survives GrowTextarea
  // not exposing its internal textarea ref. The keydown bubbles up
  // from the textarea. We open the palette on:
  //   - `/` when the typed text is empty AND selectionStart === 0
  //   - `Cmd/Ctrl+K` from any caret position
  // We preventDefault on both so the keypress doesn't also land in the
  // textarea (otherwise `/` would type `/` into an empty box, leaving
  // the operator confused when they Esc out and the `/` is still there).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onKey(e: KeyboardEvent) {
      // Don't fire while the palette is already open — palette owns
      // its own keyboard.
      if (paletteOpen) return;
      // Cmd/Ctrl+K from any position → open palette.
      if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // `/` at cursor 0 + empty textarea → open palette.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (!(target instanceof HTMLTextAreaElement)) return;
        // selectionStart === selectionEnd === 0 + value empty = "fresh empty composer"
        if (target.value.length === 0 && target.selectionStart === 0) {
          e.preventDefault();
          setPaletteOpen(true);
          return;
        }
      }
    }
    wrap.addEventListener('keydown', onKey);
    return () => wrap.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  // Click-outside closes the palette. Attached on the document so we
  // catch clicks anywhere outside the InputBox wrap.
  useEffect(() => {
    if (!paletteOpen) return;
    function onMouseDown(ev: MouseEvent) {
      const root = wrapRef.current;
      if (!root) return;
      const target = ev.target as Node | null;
      if (target && !root.contains(target)) setPaletteOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [paletteOpen]);

  // Cluster E Phase 1: palette selection. Replace the textarea content
  // with the command + a trailing space (operator continues typing
  // context or hits Send immediately). We don't auto-send — the
  // operator decides when the prompt is ready.
  function handlePaletteSelect(command: string) {
    setText(`${command} `);
    setPaletteOpen(false);
  }

  function handlePaletteClose() {
    setPaletteOpen(false);
  }

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
      {paletteOpen && (
        <SlashCommandPalette
          sdkCommands={props.sdkSlashCommands}
          onSelect={handlePaletteSelect}
          onClose={handlePaletteClose}
        />
      )}
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
