import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { nextIndex } from '../listNavigation';

/**
 * A radiogroup of labelled cards with a roving tabindex.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. Two callers is normally thin evidence
 * for an abstraction, and the count is not the argument here — the duplication
 * would be a KEYBOARD MODEL. `widgetRoles.test.ts` exists because a composite
 * ARIA role without arrow-key handling is a control screen-reader and
 * keyboard operators cannot use, and `listNavigation.ts` exists so nobody
 * hand-rolls the arrow semantics per widget. A second copy of roving tabindex
 * + `nextIndex` + focus management is exactly the drift those two files were
 * written to prevent, and it would put a second file under the same gate
 * instead of one tested implementation under it.
 *
 * ARROWS SELECT AS THEY MOVE, which is correct for a radiogroup and is a
 * deliberate contrast with `ModeToggle`: that control refuses arrow-select
 * because arrowing across it would flip a LIVE session's permission posture
 * mid-run. Everything mounted here is a pre-session preference — nothing in
 * flight moves when the selection changes, and the previous choice is one
 * arrow back.
 *
 * Generic over the option value so a caller can use `null` for "no explicit
 * choice" without stringly-typing it. Both current callers do exactly that,
 * and it matters: `null` and a sentinel string reach the server differently.
 */

export type CardRadioOption<T> = {
  /** Stable React key + `data-testid` suffix. Distinct from `value`, which may be null. */
  key: string;
  value: T;
  label: string;
  /** Optional second line. Empty strings render nothing rather than an empty node. */
  description?: string;
};

export type CardRadioGroupProps<T> = {
  options: CardRadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. Required — an unnamed radiogroup is unusable. */
  ariaLabel: string;
  /** Prefix for each option's `data-testid`, e.g. `model-option`. */
  testIdPrefix: string;
  disabled?: boolean;
};

export function CardRadioGroup<T>(props: CardRadioGroupProps<T>) {
  const { options, value, onChange, disabled } = props;
  // Falls back to the first option when the stored value matches nothing —
  // a model that was retired, or a mode written by an older build. Checking
  // NO radio would leave every tabIndex at -1, making the group unreachable
  // by keyboard entirely, which is a worse failure than a wrong highlight.
  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const target = nextIndex({
      key: e.key,
      current: currentIdx,
      count: options.length,
      wrap: true,
      orientation: 'both',
    });
    if (target === null) return;
    e.preventDefault();
    onChange(options[target]!.value);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[target]?.focus();
  }

  return (
    <div
      className="card-radio-group"
      role="radiogroup"
      aria-label={props.ariaLabel}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={i === currentIdx}
          tabIndex={i === currentIdx ? 0 : -1}
          disabled={disabled}
          className={`card-radio-option${i === currentIdx ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
          data-testid={`${props.testIdPrefix}-${o.key}`}
        >
          <span className="card-radio-name">{o.label}</span>
          {o.description && <span className="card-radio-desc">{o.description}</span>}
        </button>
      ))}
    </div>
  );
}
