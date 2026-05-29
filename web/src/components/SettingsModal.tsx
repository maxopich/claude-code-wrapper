import { useState } from 'react';
import type { SettingsView } from '../store';
import { useModalSurface } from '../useModalSurface';

export type SettingsSavePayload = {
  workspaceRoot: string;
  defaultHopBudget: number;
  /**
   * Cluster F Phase A1b (UI-A1): operator-set default MAX_TURNS for
   * single-agent runs. Always present in the payload so the caller can
   * compare against the prior `settings.defaultMaxTurns` and only fire
   * `set_default_max_turns` when it changed. The server's resolver
   * silently clamps to `>= 1`; this modal's input enforces the same
   * floor before allowing Save (canSave checks).
   *
   * The MAX_TURNS env reading lives on `config.maxTurns` which is read
   * once at boot and isn't perturbed by this save — the operator is
   * persisting a DB-layer override that wins above env on next turn.
   */
  defaultMaxTurns: number;
};

// Cluster F Phase A1b (UI-A1): keep the built-in MAX_TURNS fallback in
// sync with `server/src/config.ts` `config.maxTurns` default. Used to
// seed the input when the server hasn't shipped `defaultMaxTurns` yet
// (older server, or first paint before the settings ServerMsg lands).
const MAX_TURNS_BUILT_IN_DEFAULT = 50;

export function SettingsModal(props: {
  settings: SettingsView;
  onClose: () => void;
  /** Caller decides which fields actually changed and fires the matching
   *  ClientMsg(s). All values are always provided. */
  onSave: (payload: SettingsSavePayload) => void;
}) {
  const [value, setValue] = useState(
    props.settings.workspaceRoot ?? props.settings.defaultWorkspaceRoot,
  );
  // Number input bound to a string so the user can type/clear without us
  // clobbering the field on every keystroke. Parsed at save time; an
  // unparseable value blocks save (canSave checks).
  const [hopBudgetInput, setHopBudgetInput] = useState(String(props.settings.defaultHopBudget));
  // Cluster F Phase A1b (UI-A1): defaultMaxTurns input. Seeded from the
  // server-resolved value when present; falls back to the built-in 50
  // so the operator can save a value even on older servers (the
  // set_default_max_turns ClientMsg is silently ignored by older
  // servers that don't have the handler — but new servers will).
  const [maxTurnsInput, setMaxTurnsInput] = useState(
    String(props.settings.defaultMaxTurns ?? MAX_TURNS_BUILT_IN_DEFAULT),
  );
  const trimmed = value.trim();
  const workspaceChanged = trimmed.length > 0 && trimmed !== props.settings.workspaceRoot;
  const parsedHopBudget = Number.parseInt(hopBudgetInput, 10);
  const hopBudgetValid = Number.isFinite(parsedHopBudget) && parsedHopBudget >= 1;
  const hopBudgetChanged = hopBudgetValid && parsedHopBudget !== props.settings.defaultHopBudget;
  const parsedMaxTurns = Number.parseInt(maxTurnsInput, 10);
  const maxTurnsValid = Number.isFinite(parsedMaxTurns) && parsedMaxTurns >= 1;
  // The server-side "current" we compare against — undefined defaults to
  // the built-in 50 so a save from an empty/default state to a different
  // value is still detected as a change.
  const currentDefaultMaxTurns = props.settings.defaultMaxTurns ?? MAX_TURNS_BUILT_IN_DEFAULT;
  const maxTurnsChanged = maxTurnsValid && parsedMaxTurns !== currentDefaultMaxTurns;
  const canSave =
    trimmed.length > 0 &&
    hopBudgetValid &&
    maxTurnsValid &&
    (workspaceChanged || hopBudgetChanged || maxTurnsChanged);

  // Cluster E Phase 3 (A4): the "(default fallback)" annotation is visible
  // ONLY when the operator hasn't stored a workspace (workspaceRoot === null)
  // AND the current input still matches the default — i.e. the pre-filled
  // value hasn't been edited yet. Editing immediately clears the hint so
  // the operator's typed-in path doesn't carry the misleading label.
  const isShowingFallback =
    props.settings.workspaceRoot === null && trimmed === props.settings.defaultWorkspaceRoot;
  const fallbackSource = props.settings.defaultWorkspaceRootSource;

  const save = () => {
    if (!canSave) return;
    props.onSave({
      workspaceRoot: trimmed,
      defaultHopBudget: parsedHopBudget,
      defaultMaxTurns: parsedMaxTurns,
    });
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
            <div className="label">
              Workspace folder
              {/* Cluster E Phase 3 (A4): inline "(default fallback)" tag
               * when the operator hasn't saved a custom path AND the input
               * value still equals the default. Vanishes as soon as they
               * edit the field. Source attribution distinguishes
               * "env" (WORKSPACE_ROOT was set at server boot) from
               * "builtin" (~/agents). */}
              {isShowingFallback && (
                <span className="settings-modal-fallback-tag" data-testid="fallback-tag">
                  {' '}
                  ({sourceLabel(fallbackSource)})
                </span>
              )}
            </div>
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
            // Cluster E Phase 3 (A4): when no workspace is saved, name
            // the resolved default path so the operator knows where runs
            // and logs will land if they accept the fallback. Previous
            // copy was a generic "Pick one to begin"; the path callout
            // surfaces the actual landing location.
            <p className="hint">
              No workspace folder set yet — runs and logs land in{' '}
              <code>{props.settings.defaultWorkspaceRoot}</code>{' '}
              {fallbackSourceSentence(fallbackSource)} unless you set a workspace.
            </p>
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
        <section>
          {/* Cluster F Phase A1b (UI-A1): default MAX_TURNS for single-agent
           * runs. Mirrors the hop-budget input layout above; the server's
           * resolver precedence is: per-turn `send_message.maxTurns` >
           * this DB setting > MAX_TURNS env > built-in 50. The per-turn
           * override lives next to the composer (see MaxTurnsInput);
           * this value is the fallback when no override is in play. */}
          <label>
            <div className="label">Default max turns</div>
            <input
              type="number"
              min={1}
              step={1}
              value={maxTurnsInput}
              onChange={(e) => setMaxTurnsInput(e.target.value)}
              data-testid="default-max-turns-input"
            />
          </label>
          <p className="hint">
            Cap on agent turns per single-agent send. The SDK ends the turn with{' '}
            <code>error_max_turns</code> when reached. Per-launch override: <code>MAX_TURNS</code>{' '}
            env. Per-turn override available in the chat header. Takes effect on the next send.
          </p>
          {!maxTurnsValid && <p className="hint warn">Max turns must be a positive integer.</p>}
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

/**
 * Cluster E Phase 3 (A4): short label for the inline "(default fallback)" tag
 * next to the Workspace folder label. Server forwards either:
 *   'env'     → the WORKSPACE_ROOT env var resolved the path at boot
 *   'builtin' → server fell back to the hard-coded ~/agents
 * Undefined source means the server is older than Phase 3 — we still show
 * "default fallback" so the operator at least sees that this is a default,
 * just without attribution.
 */
function sourceLabel(source: 'env' | 'builtin' | undefined): string {
  switch (source) {
    case 'env':
      return 'default — from WORKSPACE_ROOT env';
    case 'builtin':
      return 'default — built-in ~/agents';
    default:
      return 'default fallback';
  }
}

/**
 * Cluster E Phase 3 (A4): suffix in the empty-state hint that mirrors the
 * `sourceLabel` attribution but reads naturally as a sentence fragment
 * after the resolved path.
 */
function fallbackSourceSentence(source: 'env' | 'builtin' | undefined): string {
  switch (source) {
    case 'env':
      return '(resolved from the WORKSPACE_ROOT env var)';
    case 'builtin':
      return "(Cebab's built-in default)";
    default:
      return '(default fallback)';
  }
}
