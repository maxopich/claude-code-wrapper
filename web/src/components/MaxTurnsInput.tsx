/**
 * Cluster F Phase A1b (UI-A1) — per-turn MAX_TURNS override input.
 *
 * The wire end-to-end was already shipped by F-A1a:
 *   - `send_message.maxTurns?: number` accepts the override.
 *   - Server resolver precedence (ws/server.ts `resolveMaxTurns`):
 *     per-turn override > DB setting > MAX_TURNS env > built-in 50.
 *
 * The UI gap was: no input field next to the composer. Operators had
 * to use env overrides to change the cap for a single turn. This
 * component fills that gap with a compact numeric input that lives in
 * the chat header alongside the model / trust chips.
 *
 * Mirrors the F-D9 HopBudgetInput pattern but simpler — single-agent
 * doesn't have a "template" source, so the source tag isn't needed.
 * The value clears after each send (per-turn scope; App.tsx owns the
 * setter and clears on `user_send`).
 *
 * **Value semantics:**
 *   - Bound to a string so the field allows transient empty/partial
 *     states without flicker.
 *   - Empty string → `value === null` propagated up — App.tsx omits
 *     `maxTurns` from the `send_message` payload (server resolver
 *     falls through to DB setting / env / default).
 *   - Any positive integer → forwarded verbatim.
 *   - Out-of-range → silently clamps to `null` so we don't ship a
 *     bogus override.
 */

const MIN_MAX_TURNS = 1;
// UI sanity cap. Server doesn't enforce an upper bound; the input does,
// to prevent typos like "5000".
const MAX_MAX_TURNS = 1_000;

export type MaxTurnsInputProps = {
  /** Current per-turn override (from App state). null = use default. */
  value: number | null;
  /** Server-resolved default (settings.defaultMaxTurns); shown as placeholder. */
  defaultValue?: number;
  /** Called on every input change; null = empty / invalid. */
  onChange: (value: number | null) => void;
  /** Disabled while a turn is running or composer is structurally disabled. */
  disabled?: boolean;
};

export function MaxTurnsInput({ value, defaultValue, onChange, disabled }: MaxTurnsInputProps) {
  // Bind the textbox to the current `value` cast to string; null → ''
  // so the field clears visually. We don't keep local state — the
  // single source of truth is App.tsx's draftMaxTurns.
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
    if (parsed < MIN_MAX_TURNS || parsed > MAX_MAX_TURNS) {
      onChange(null);
      return;
    }
    onChange(parsed);
  }

  // Placeholder shows the resolved default so the operator sees what cap
  // applies if they leave the field empty. Falls back to a neutral label
  // when the server hasn't shipped a `defaultMaxTurns` yet (older server,
  // first paint before the settings ServerMsg lands).
  const placeholder = defaultValue !== undefined ? `${defaultValue}` : '50';

  return (
    <label className="max-turns-input-label" title="Per-turn max turns override (empty = default)">
      <span className="max-turns-input-label-text">Turns</span>
      <input
        type="number"
        className="max-turns-input"
        value={inputValue}
        min={MIN_MAX_TURNS}
        max={MAX_MAX_TURNS}
        step={1}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        aria-label="Max turns for the next send"
      />
    </label>
  );
}
