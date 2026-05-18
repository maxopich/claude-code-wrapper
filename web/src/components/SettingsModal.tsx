import { useState } from 'react';
import type { SettingsView } from '../store';
import { useModalKeys } from '../useModalKeys';

export function SettingsModal(props: {
  settings: SettingsView;
  onClose: () => void;
  onSave: (path: string) => void;
}) {
  const [value, setValue] = useState(
    props.settings.workspaceRoot ?? props.settings.defaultWorkspaceRoot,
  );
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== props.settings.workspaceRoot;
  useModalKeys({
    onClose: props.onClose,
    onConfirm: () => props.onSave(trimmed),
    canConfirm: canSave,
  });

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button className="icon-btn" onClick={props.onClose} title="Close">
            ✕
          </button>
        </header>
        <section>
          <label>
            <div className="label">Workspace folder</div>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="/Users/you/agents"
              spellCheck={false}
              autoFocus
            />
          </label>
          <p className="hint">
            Absolute or <code>~</code>-prefixed path. Each subdirectory becomes a sidebar entry. The
            agent runs with that directory as its <code>cwd</code>, so the project's{' '}
            <code>CLAUDE.md</code>, <code>.claude/skills/</code>, and <code>.claude/mcp.json</code>{' '}
            auto-load.
          </p>
          {props.settings.workspaceRoot === null && (
            <p className="hint">No workspace folder set yet. Pick one to begin.</p>
          )}
          {!props.settings.workspaceRootValid && props.settings.workspaceRoot && (
            <p className="hint warn">
              Current path is missing or not a directory:{' '}
              <code>{props.settings.workspaceRoot}</code>
            </p>
          )}
        </section>
        <footer>
          <button className="ghost-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary-btn" disabled={!canSave} onClick={() => props.onSave(trimmed)}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
