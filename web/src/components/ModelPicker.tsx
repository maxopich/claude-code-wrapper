import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ModelCatalogueEntry } from '@cebab/shared/protocol';
import { nextIndex } from '../listNavigation';

/**
 * Choose the model a project's runs ask for (Cebab-ws0.3).
 *
 * THE LIST IS NOT OURS. Every row comes from the CLI's own
 * `Query.supportedModels()`, captured by the authority probe — no model id is
 * written down anywhere in Cebab. That is what keeps the list from rotting and
 * what makes it reflect the models THIS account may actually run. The cost is
 * that the list can be empty (nothing probed yet, or a CLI that cannot report
 * one), and an empty list is a normal state rather than an error.
 *
 * DEFAULT IS ALWAYS OFFERED, AND IT IS NOT A MODEL. The first row selects
 * `null`, which makes Cebab omit `Options.model` from the spawn entirely. The
 * CLI's own catalogue happens to include a row whose value is the literal
 * string `'default'`; when it is present we borrow its label and description —
 * better copy than anything hand-authored, and it tracks the CLI — but we still
 * store `null` for it. Choosing "Default" and never choosing must produce the
 * same spawn, and they only do if the model key is absent both times.
 *
 * WHY A RADIOGROUP RATHER THAN A LISTBOX OR A `<select>`. There is no `<select>`
 * anywhere in this app and no shared dropdown; the nearest precedent is the
 * theme picker, which is a radiogroup with roving tabindex. Arrows SELECT as
 * they move here, as they do there — unlike `ModeToggle`, which deliberately
 * refuses that because arrowing across it would flip a live session's
 * permission posture. Arrowing across this changes which model the NEXT turn
 * asks for; nothing in flight moves, and the previous choice is one arrow back.
 */

export type ModelPickerProps = {
  /** Catalogue rows as the CLI reported them. May be empty. */
  entries: ModelCatalogueEntry[];
  /** Current selection; `null` = let the CLI decide. */
  value: string | null;
  onChange: (model: string | null) => void;
  /** Re-probe. Omit to hide the affordance (e.g. no project in context). */
  onRefresh?: () => void;
  /** True while a refresh spawn is in flight. */
  refreshing?: boolean;
  /** When the rendered list was captured; null when nothing ever was. */
  capturedAt?: number | null;
  disabled?: boolean;
};

/** The synthetic first row. `value: null` is the whole point — see the header. */
type Row = { key: string; value: string | null; label: string; description: string };

const DEFAULT_FALLBACK_LABEL = 'Default';
const DEFAULT_FALLBACK_DESC = 'Let the CLI choose. Cebab sends no model.';

/**
 * Build the rendered rows. Exported for tests: this is where the two rules that
 * matter live — Default is always present, and the catalogue's own `'default'`
 * row is folded INTO it rather than offered as a second, differently-behaving
 * way to say the same thing.
 */
export function modelPickerRows(entries: ModelCatalogueEntry[]): Row[] {
  const cliDefault = entries.find((e) => e.value === 'default');
  const rows: Row[] = [
    {
      key: '__default__',
      value: null,
      label: cliDefault?.displayName ?? DEFAULT_FALLBACK_LABEL,
      description: cliDefault?.description || DEFAULT_FALLBACK_DESC,
    },
  ];
  for (const e of entries) {
    if (e.value === 'default') continue;
    rows.push({ key: e.value, value: e.value, label: e.displayName, description: e.description });
  }
  return rows;
}

export function ModelPicker(props: ModelPickerProps) {
  const rows = modelPickerRows(props.entries);
  const currentIdx = Math.max(
    0,
    rows.findIndex((r) => r.value === props.value),
  );

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (props.disabled) return;
    const target = nextIndex({
      key: e.key,
      current: currentIdx,
      count: rows.length,
      wrap: true,
      orientation: 'both',
    });
    if (target === null) return;
    e.preventDefault();
    props.onChange(rows[target]!.value);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[target]?.focus();
  }

  return (
    <div className="model-picker">
      <div
        className="model-picker-options"
        role="radiogroup"
        aria-label="Model"
        onKeyDown={onKeyDown}
      >
        {rows.map((r, i) => (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={i === currentIdx}
            tabIndex={i === currentIdx ? 0 : -1}
            disabled={props.disabled}
            className={`model-picker-option${i === currentIdx ? ' active' : ''}`}
            onClick={() => props.onChange(r.value)}
            data-testid={`model-option-${r.key}`}
          >
            <span className="model-picker-name">{r.label}</span>
            {r.description && <span className="model-picker-desc">{r.description}</span>}
          </button>
        ))}
      </div>
      <div className="model-picker-footer">
        {/* An empty catalogue says so rather than rendering a lone Default row
         *  with no explanation for why nothing else is offered. */}
        {props.entries.length === 0 && (
          <span className="model-picker-hint">
            No model list captured yet. Refresh to ask this project&apos;s CLI what it offers.
          </span>
        )}
        {props.onRefresh && (
          <button
            type="button"
            className="ghost-btn model-picker-refresh"
            onClick={props.onRefresh}
            disabled={props.disabled || props.refreshing}
          >
            {props.refreshing ? 'Asking the CLI…' : 'Refresh list'}
          </button>
        )}
      </div>
    </div>
  );
}
