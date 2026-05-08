import type { SessionPermissionMode } from '@cebab/shared/protocol';

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
  return (
    <div className={`mode-toggle ${props.disabled ? 'is-disabled' : ''}`} title={tooltip}>
      <span className="label">permissions:</span>
      <button
        type="button"
        className={`pill ${props.mode === 'default' ? 'on' : ''}`}
        onClick={() => set('default')}
        disabled={props.disabled}
      >
        ask
      </button>
      <button
        type="button"
        className={`pill ${props.mode === 'acceptEdits' ? 'on' : ''}`}
        onClick={() => set('acceptEdits')}
        disabled={props.disabled}
      >
        auto-edits
      </button>
    </div>
  );
}
