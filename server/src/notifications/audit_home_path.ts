import os from 'node:os';
import path from 'node:path';

/**
 * Cebab-6fax.43.5 — collapse the operator's home directory to `~` in every
 * NEW safety_audit payload.
 *
 * The managed copy/delete/edit rows (and every other safety writer that names a
 * path) used to embed the operator's absolute home directory — and hence their
 * username — into the hash-chained audit log, which is the artifact most likely
 * to leave the machine (pasted into an issue, attached to a report). The
 * stray-folder writer deliberately avoided this; the maintainer's 2026-09-23
 * decision was to make ONE central substitution at the audit APPEND site so
 * every writer inherits it, rather than teaching each payload to sanitise
 * itself.
 *
 * The rule, exactly as decided:
 *   - a string that EQUALS the home directory becomes `~`;
 *   - a string that STARTS WITH the home directory followed by a path separator
 *     has that prefix replaced by `~` (e.g. /Users/alice/agents/foo ->
 *     ~/agents/foo);
 *   - anything else is untouched. A sibling like /Users/aliceX/... does not
 *     match (the boundary must be a separator), and a home path appearing
 *     mid-value is not a prefix and is left alone.
 *
 * On win32 the comparison is case-insensitive and accepts both `/` and `\` as
 * separators, matching how the rest of the server folds Windows paths.
 *
 * Applied BEFORE the payload is JSON-serialised and hashed, so the chain covers
 * exactly what is stored and verification is unaffected. Rows already written
 * are never touched.
 */

const IS_WIN = process.platform === 'win32';

/** Fold a Windows path for comparison: lowercase, and `/` treated as `\`. */
function normalizeWin(s: string): string {
  return s.toLowerCase().replace(/\//g, '\\');
}

/**
 * Replace a leading home-directory prefix in `value` with `~`, per the rule
 * documented above. Returns `value` unchanged when it does not begin at the
 * home directory on a separator boundary.
 */
export function collapseHomePath(value: string): string {
  const home = os.homedir();
  if (!home) return value;

  if (IS_WIN) {
    const nv = normalizeWin(value);
    const nh = normalizeWin(home);
    if (nv === nh) return '~';
    // The boundary char after the prefix must be a separator; both `/` and `\`
    // normalise to `\`. Slicing by `home.length` is safe — neither lowercasing
    // nor separator folding changes a string's length.
    if (nv.startsWith(nh) && nv[nh.length] === '\\') return '~' + value.slice(home.length);
    return value;
  }

  if (value === home) return '~';
  if (value.startsWith(home) && value[home.length] === path.sep) {
    return '~' + value.slice(home.length);
  }
  return value;
}

/**
 * Deep-copy `payload`, applying `collapseHomePath` to every string it contains
 * (top-level, inside arrays, and inside object values — object KEYS are left
 * as-is; they are field names, not operator data). Non-string leaves pass
 * through untouched. Mirrors what `JSON.stringify` serialises (own enumerable
 * properties), so the collapsed copy round-trips identically save for the home
 * prefixes.
 */
export function collapseHomePathsInPayload(payload: unknown): unknown {
  if (typeof payload === 'string') return collapseHomePath(payload);
  if (Array.isArray(payload)) return payload.map(collapseHomePathsInPayload);
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(payload)) {
      out[key] = collapseHomePathsInPayload(val);
    }
    return out;
  }
  return payload;
}
