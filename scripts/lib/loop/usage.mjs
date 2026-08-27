/**
 * Autonomous loop — what a run CONSUMED, in units the operator actually has.
 *
 * PURE. Every function here takes an envelope or a plain totals object and
 * returns another one; nothing reads a clock, a file or `process`.
 *
 * WHY NOT DOLLARS. The loop runs on a Claude subscription, not on API billing,
 * so `total_cost_usd` is a price for a transaction that never happens. The
 * operator's actual constraint is a rolling usage window, and a dollar figure
 * says nothing about how much of one an overnight run ate. It is still RECORDED
 * on every ledger row — it is the CLI's own number and the only cross-model
 * normaliser we get for free — and it is never printed. Tokens, turns and wall
 * time are what the human-facing output reports.
 *
 * WHAT THE ENVELOPE ACTUALLY CARRIES, measured against the shipped SDK types
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `SDKResultSuccess`
 * and `SDKResultError`): `usage` (a `NonNullableUsage`, i.e. the Beta usage
 * block in snake_case), `modelUsage` (per-model, camelCase), `num_turns`,
 * `duration_ms` and `total_cost_usd`. What it does NOT carry is any plan
 * rate-limit utilization — `SDKControlGetUsageResponse.rate_limits` is a
 * control-protocol request available only to a streaming-input SDK session, and
 * BUILD shells out to `claude -p --output-format json`, which cannot issue one.
 * So "you have used N% of your weekly window" is not reachable from here and
 * this module does not pretend otherwise. `Cebab-qd2.38`.
 *
 * THE FOUR CLASSES ARE KEPT APART ON PURPOSE. A cache READ is roughly an order
 * of magnitude cheaper than fresh input and, on an agent loop that re-sends a
 * growing transcript every turn, it dominates the raw sum by 10-40x. A single
 * "total tokens" number is therefore mostly a measure of the discount, which is
 * why `meteredTokens` below excludes it and says so.
 */

export const ZERO_TOKENS = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
});

/**
 * The four token classes out of one result envelope, or null.
 *
 * NULL, NOT ZEROS, when there is no usage block. A capped or crashed build
 * still emits an envelope and still spent; an unparseable one spent too but
 * cannot say how much, and recording that as `0` would make an unknown
 * indistinguishable from a free turn in the ledger — the same confusion
 * `land.sha: null` used to create.
 *
 * Reads `usage` first and falls back to summing `modelUsage`, because they are
 * populated by different code paths in the CLI and a run that has one without
 * the other is cheaper to tolerate than to diagnose at 3am.
 */
export function tokensFrom(envelope) {
  const usage = envelope?.usage;
  if (usage && typeof usage === 'object') {
    const totals = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreation: num(usage.cache_creation_input_tokens),
    };
    if (anyPositive(totals)) return totals;
  }

  const perModel = envelope?.modelUsage;
  if (perModel && typeof perModel === 'object') {
    let totals = { ...ZERO_TOKENS };
    for (const entry of Object.values(perModel)) {
      if (!entry || typeof entry !== 'object') continue;
      totals = addTokens(totals, {
        input: num(entry.inputTokens),
        output: num(entry.outputTokens),
        cacheRead: num(entry.cacheReadInputTokens),
        cacheCreation: num(entry.cacheCreationInputTokens),
      });
    }
    if (anyPositive(totals)) return totals;
  }

  return null;
}

/** Accumulate. A null addend is "this build could not say", and adds nothing. */
export function addTokens(base, extra) {
  const a = base ?? ZERO_TOKENS;
  const b = extra ?? ZERO_TOKENS;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

/**
 * The number a ceiling is measured against: input + output + cache WRITES.
 *
 * Cache reads are excluded and the exclusion is the decision, not an omission.
 * They are the cheapest class by roughly an order of magnitude and they are
 * also the largest by far on this workload, so a ceiling on the raw sum would
 * fire on the discount rather than on the work. Stated here rather than in a
 * config comment because this is the only place that defines what the knob
 * means.
 */
export function meteredTokens(totals) {
  const t = totals ?? ZERO_TOKENS;
  return t.input + t.output + t.cacheCreation;
}

/** 1234 -> '1.2k', 1800000 -> '1.8M'. Terminal-width, not precision. */
export function formatCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/**
 * All four classes, in the order they cost. Never a single total — see the
 * header: one number here would be a measure of the cache-read discount.
 */
export function formatTokens(totals) {
  const t = totals ?? ZERO_TOKENS;
  return (
    `${formatCount(t.input)} in / ${formatCount(t.output)} out / ` +
    `${formatCount(t.cacheCreation)} cache write / ${formatCount(t.cacheRead)} cache read`
  );
}

/** '7m12s' / '48s'. Null in, empty out, so callers can concatenate freely. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '';
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * One line for a human: turns, wall time, and the four token classes.
 *
 * `turns` and `ms` are both optional because a build can fail before either
 * exists, and a usage line that says "0 turns" about an unparseable envelope is
 * a claim rather than a reading.
 */
export function formatUsage({ turns = null, ms = null, tokens = null } = {}) {
  const parts = [];
  if (turns !== null && turns !== undefined) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  const elapsed = formatDuration(ms);
  if (elapsed) parts.push(elapsed);
  parts.push(tokens ? formatTokens(tokens) : 'token usage unavailable');
  return parts.join(', ');
}

/**
 * A state.json written before this loop stopped counting in dollars.
 *
 * `--status` dumps the file verbatim, which is the right default — it is a
 * debugging artifact and hiding fields from it is how a stale key survives
 * unnoticed. The one exception is the key this whole change exists to remove:
 * a `spentUsd` left by the PREVIOUS run would otherwise be the first thing an
 * operator sees, once, after upgrading. Dropped rather than reformatted,
 * because there is no honest way to convert it into tokens after the fact.
 */
export function withoutLegacyCost(state) {
  if (!state || typeof state !== 'object' || !('spentUsd' in state)) return state;
  const { spentUsd, ...rest } = state;
  void spentUsd;
  return rest;
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const anyPositive = (t) => t.input > 0 || t.output > 0 || t.cacheRead > 0 || t.cacheCreation > 0;
const trim = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};
