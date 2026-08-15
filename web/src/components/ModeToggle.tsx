import type { SessionPermissionMode } from '@cebab/shared/protocol';

/**
 * The per-session permission posture: ask for each tool use, or auto-allow
 * edits. Register U17 — selection was signalled by a CSS class alone, so a
 * screen-reader operator could not tell whether tool calls were being
 * auto-approved, and the explanation of why the control was read-only lived in
 * a `title` on the wrapper `<div>`, where nothing announces it.
 *
 * Why `aria-pressed` toggle buttons and not the radio group the finding
 * suggests: a radio group's arrow keys SELECT as they move. On the one control
 * in this app whose entire job is to gate side effects, arrowing past would
 * flip a live session into auto-approving tool calls with no deliberate
 * action. `.session-search-chip` and `.tools-list-usage-toggle-btn` are
 * already mutually-exclusive `aria-pressed` chips, so this is also the shape
 * the codebase already uses — and `aria-pressed` on a `<button>` promises
 * exactly what it delivers, which a role without its keyboard model does not.
 */
export function ModeToggle(props: {
  mode: SessionPermissionMode;
  disabled?: boolean;
  onChange: (mode: SessionPermissionMode) => void;
}) {
  function set(mode: SessionPermissionMode) {
    if (props.disabled || mode === props.mode) return;
    props.onChange(mode);
  }
  const tooltip = props.disabled
    ? 'Mode is read-only for past sessions. The next run will resume with this mode; toggle while a session is running to change it.'
    : props.mode === 'acceptEdits'
      ? 'Auto-allowing file edits + common shell commands. Persists across turns until you toggle back.'
      : 'Asking for each tool use. Persists across turns until you toggle to auto-edits.';
  const hintId = 'mode-toggle-hint';
  // `aria-disabled`, not the native attribute: a disabled button is removed
  // from the tab order, so the sentence explaining WHY it is disabled could
  // never be read by the operator who most needs it. `set()` already refuses
  // the change, so nothing acts on a click either way.
  const ariaDisabled = props.disabled ? true : undefined;
  return (
    <div
      className={`mode-toggle ${props.disabled ? 'is-disabled' : ''}`}
      role="group"
      aria-label="Permission mode"
      title={tooltip}
    >
      <span className="label">permissions:</span>
      {/* The same text the `title` carries, as a real element the pills can
       *  point at — a `title` is not reliably announced, and this one sat on
       *  the wrapper where it described nothing in particular. */}
      <span id={hintId} className="sr-only">
        {tooltip}
      </span>
      <button
        type="button"
        className={`pill ${props.mode === 'default' ? 'on' : ''}`}
        aria-pressed={props.mode === 'default'}
        aria-disabled={ariaDisabled}
        aria-describedby={hintId}
        onClick={() => set('default')}
      >
        ask
      </button>
      <button
        type="button"
        className={`pill ${props.mode === 'acceptEdits' ? 'on' : ''}`}
        aria-pressed={props.mode === 'acceptEdits'}
        aria-disabled={ariaDisabled}
        aria-describedby={hintId}
        onClick={() => set('acceptEdits')}
      >
        auto-edits
      </button>
    </div>
  );
}
