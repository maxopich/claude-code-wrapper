import { useState } from 'react';
import type { SettingsView } from '../store';
import { useModalSurface } from '../useModalSurface';

export type SettingsSavePayload = {
  workspaceRoot: string;
  defaultHopBudget: number;
};

export function SettingsModal(props: {
  settings: SettingsView;
  onClose: () => void;
  /** Caller decides which fields actually changed and fires the matching
   *  ClientMsg(s). Both values are always provided. */
  onSave: (payload: SettingsSavePayload) => void;
}) {
  const [value, setValue] = useState(
    props.settings.workspaceRoot ?? props.settings.defaultWorkspaceRoot,
  );
  // Number input bound to a string so the user can type/clear without us
  // clobbering the field on every keystroke. Parsed at save time; an
  // unparseable value blocks save (canSave checks).
  const [hopBudgetInput, setHopBudgetInput] = useState(String(props.settings.defaultHopBudget));
  const trimmed = value.trim();
  const workspaceChanged = trimmed.length > 0 && trimmed !== props.settings.workspaceRoot;
  const parsedHopBudget = Number.parseInt(hopBudgetInput, 10);
  const hopBudgetValid = Number.isFinite(parsedHopBudget) && parsedHopBudget >= 1;
  const hopBudgetChanged = hopBudgetValid && parsedHopBudget !== props.settings.defaultHopBudget;
  const canSave = trimmed.length > 0 && hopBudgetValid && (workspaceChanged || hopBudgetChanged);

  const save = () => {
    if (!canSave) return;
    props.onSave({ workspaceRoot: trimmed, defaultHopBudget: parsedHopBudget });
  };

  const { overlayRef, onBackdropMouseDown } = useModalSurface({
    onClose: props.onClose,
    onConfirm: save,
    canConfirm: canSave,
  });

  return (
    <div ref={overlayRef} className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
      <div className="modal modal-surface">
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
        <section>
          <label>
            <div className="label">Default hop budget</div>
            <input
              type="number"
              min={1}
              step={1}
              value={hopBudgetInput}
              onChange={(e) => setHopBudgetInput(e.target.value)}
            />
          </label>
          <p className="hint">
            Hard cap on multi-agent hops per session. Cebab stops a run when this is reached and
            appends a <code>cebab → _sink</code> error event explaining the stop. Per-launch
            override: <code>CEBAB_HOP_BUDGET</code>. Takes effect on the next session start.
          </p>
          {!hopBudgetValid && <p className="hint warn">Hop budget must be a positive integer.</p>}
        </section>
        <footer>
          <button className="ghost-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary-btn" disabled={!canSave} onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
