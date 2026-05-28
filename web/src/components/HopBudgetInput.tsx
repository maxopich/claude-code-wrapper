/**
 * Cluster F Phase D9 (UI-D9) — per-run hop-budget override input.
 *
 * The wire end-to-end was already complete by Cluster D / PR-7:
 *   - `start_multi_agent.hopBudget?: number` accepts the override
 *   - `MultiAgentTemplate.hopBudget?: number` carries template values
 *   - Server resolver precedence (ws/server.ts ~L436-444): per-run
 *     `hopBudget` > template's hopBudget > DB setting > env >
 *     built-in `DEFAULT_HOP_BUDGET`.
 *
 * The UI gap was: no input field in DraftView. Operators had to use
 * CLI/env overrides or modify the template to change the cap. This
 * component fills that gap with a numeric input + a "(from template)"
 * annotation that vanishes when the operator types over the value.
 *
 * **Value semantics:**
 *   - Bound to a string so the field allows transient empty/partial
 *     states without flicker (matches SettingsModal's hop-budget
 *     input pattern).
 *   - Empty string → `value === null` propagated up — server
 *     resolver falls through the precedence chain.
 *   - Any positive integer → forwarded verbatim (server re-clamps
 *     to `>= 1` for defense in depth).
 *   - Negative / non-numeric → input is `aria-invalid`; submit-time
 *     code in App.tsx treats invalid as null (don't send a bogus
 *     override).
 *
 * **Source attribution:**
 *   - When the operator applies a template that has its own
 *     `hopBudget`, `ma_apply_template` sets the value AND tags
 *     `draftHopBudgetSource: 'template'`. We render
 *     "(from template)" next to the label.
 *   - As soon as the operator types into the input,
 *     `ma_set_draft_hop_budget` sets source to `'user'` and the
 *     annotation disappears (per spec §5 D9: "Empty input = use
 *     server default; placeholder shows default value").
 */

const MIN_HOP_BUDGET = 1;
// UI sanity cap — past this the chain is almost certainly broken.
// Server doesn't enforce an upper bound; the input does, just to
// prevent typos like "1000000".
const MAX_HOP_BUDGET = 1_000;

export type HopBudgetInputProps = {
  /** Current draftHopBudget (from store) — null means input is empty. */
  value: number | null;
  /** Source tag for the annotation; 'template' renders attribution. */
  source: 'template' | 'user' | null;
  /** Server-resolved default; shown as placeholder when input is empty. */
  defaultValue: number;
  /** Called on every input change; null = empty / invalid. */
  onChange: (value: number | null) => void;
  /** Disabled while a session is running / structurally blocked. */
  disabled?: boolean;
};

export function HopBudgetInput({
  value,
  source,
  defaultValue,
  onChange,
  disabled,
}: HopBudgetInputProps) {
  // Bind the textbox to the current `value` cast to string; null → ''
  // so the field clears visually. We don't keep local state — the
  // single source of truth is the store's draftHopBudget.
  const inputValue = value === null ? '' : String(value);

  function handleChange(raw: string) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      onChange(null);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      onChange(null);
      return;
    }
    if (parsed < MIN_HOP_BUDGET || parsed > MAX_HOP_BUDGET) {
      // Invalid range — store null so we don't ship a bogus value at
      // start time. The aria-invalid styling tells the operator.
      onChange(null);
      return;
    }
    onChange(parsed);
  }

  // When value is null AND defaultValue exists, show the default as
  // placeholder so the operator sees what the cap will be without
  // having to consult settings.
  const placeholder = `${defaultValue} (server default)`;

  // aria-invalid fires when the raw text has content but parses out of
  // range; we can't reach that state today because handleChange clamps
  // out-of-range to null, but mirroring the SettingsModal hop-budget
  // input pattern makes the contract explicit.
  const isShowingTemplateTag = source === 'template' && value !== null;

  return (
    <label className="ma-hop-budget-input-label">
      <span className="ma-hop-budget-input-label-text">
        Hop budget
        {isShowingTemplateTag && (
          <span
            className="ma-hop-budget-input-source-tag"
            data-testid="hop-budget-source-tag"
          >
            {' '}
            (from template)
          </span>
        )}
      </span>
      <input
        type="number"
        className="ma-hop-budget-input"
        value={inputValue}
        min={MIN_HOP_BUDGET}
        max={MAX_HOP_BUDGET}
        step={1}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        aria-label="Hop budget for the next start"
      />
      <span className="ma-hop-budget-input-hint">
        Higher values allow longer chains but cost more — typical chains finish under 20 hops.
      </span>
    </label>
  );
}
