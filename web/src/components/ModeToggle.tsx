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
    ? 'Mode can only change while a session is running on this connection.'
    : props.mode === 'acceptEdits'
      ? 'Auto-allowing file edits + common shell commands. Click to switch back to ask-for-each.'
      : 'Asking for each tool use. Click to auto-allow file edits for this session.';
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
