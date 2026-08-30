/**
 * Which SDK message classes are DURABLE, and which are transient partials.
 *
 * One rule, two consumers, because they have to agree:
 *
 *   - `runner/persist.ts` skips partials when writing the `events` table —
 *     they are high-volume and the durable message that follows carries the
 *     final text anyway.
 *   - `session_log_export.ts` skips them when building a `format=redacted`
 *     artifact, because per-line value redaction is structurally unable to see
 *     a secret that was chopped across two deltas (`Cebab-ygu.47`).
 *
 * The two used to be independent, and that is how the leak survived review: the
 * export's own header claimed parity with the Logs modal's redaction policy,
 * and the Logs modal reads `events` — a corpus that never contained a partial.
 * The sentence was true about the policy and false about the corpus, so
 * everyone reasoning from it concluded the export was covered.
 *
 * A DENY-list, deliberately, not an allow-list of durable classes. An
 * allow-list would diverge the first time the SDK adds a type: the DB would
 * keep it and the export would drop it, and "the export's corpus is the events
 * corpus" would quietly go false again — silently, in the direction that loses
 * data. A deny-list defaults new types to "durable, redact it", which is the
 * direction that fails visibly.
 *
 * Leaf module: zero imports, so both call sites can take it without a cycle
 * (`session_log_export.ts` in particular must not acquire a DB dependency).
 * Server-side rather than `shared/`, because no browser consumer exists and
 * `shared` ships to the bundle.
 */

/**
 * Is `type` a streaming partial — a fragment of a message rather than a
 * message?
 *
 * Today that is exactly `stream_event`. `runner/persist.ts`'s own comment
 * anticipated more ("other high-volume types in the future should also be
 * excluded here"); when one arrives it goes HERE, and both consumers follow.
 */
export function isStreamPartial(type: string): boolean {
  return type === 'stream_event';
}
