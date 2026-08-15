/**
 * What the WS smoke actually checks — split out of `ws_smoke.ts` so it can be
 * unit-tested without standing up a server, matching the thin-executor split
 * the repo already uses (`executeSearchSessions`, `executeArchiveSession`).
 * The script keeps the socket plumbing; the judgement lives here.
 *
 * WHY THIS EXISTS AT ALL. `ws_smoke` is what `ci_smoke` runs, and `ci_smoke`
 * is a required check on every PR. Before this module, the smoke's `result`
 * handler printed the cost and called `process.exit(0)` — it read neither
 * `subtype` nor `errors`, never checked that any assistant text arrived, and
 * never checked that the fixture had replayed. Its only non-zero exits were
 * "project not found", socket close and socket error. So the gate proved the
 * server was REACHABLE and nothing else: a run ending
 * `error_during_execution`, or one that streamed no content at all, went green.
 *
 * TWO TIERS, and the reason for them. The always-on checks hold for any
 * runner, so the documented manual real-`claude` run
 * (`npm --workspace server exec tsx src/ws_smoke.ts`) still works. The strict
 * tier only arms under `MOCK=1`, where the output is a fixed fixture and
 * therefore assertable byte-for-byte. `ci_smoke` builds one `childEnv`
 * carrying `MOCK: '1'` and hands it to BOTH the server and the smoke, so CI
 * always takes the strict path.
 */

/** The exact assistant text `fixtures/hello.jsonl` replays. */
export const MOCK_EXPECTED_TEXT = "Hi there, friend, how's everything?";

/**
 * What the smoke observed over the socket. Deliberately a plain record rather
 * than the `ServerMsg` union: the script collects these as messages arrive,
 * and a test should be able to construct one without importing the protocol.
 */
export type SmokeObservation = {
  /** Set from `session_started`. */
  sessionId: string | undefined;
  /** Concatenated `stream_delta` text, in arrival order. */
  streamedText: string;
  /** The `result` message's subtype, if one arrived. */
  resultSubtype: string | undefined;
  /** The `result` message's `result` field, if present. */
  resultText: string | undefined;
  /** The `result` message's `errors`, if present. */
  errors: string[] | undefined;
  /** True when the run replayed a fixture and the strict tier should arm. */
  mock: boolean;
};

export type SmokeVerdict =
  { ok: true } | { ok: false; reason: string; expected?: string; actual?: string };

/**
 * Judge a completed smoke run. Returns the FIRST failure so the operator gets
 * the earliest broken link rather than a cascade — a run with no session id
 * will also have no text, and reporting both would bury the cause.
 */
export function judgeSmokeRun(obs: SmokeObservation): SmokeVerdict {
  if (obs.sessionId === undefined || obs.sessionId === '') {
    return { ok: false, reason: 'no session_started arrived — the turn never started' };
  }

  if (obs.resultSubtype === undefined) {
    return { ok: false, reason: 'no result message arrived — the turn never finished' };
  }

  // The check whose absence let a failed run pass. `subtype` is the SDK's own
  // verdict on the turn; `errors` is the detail. Both were on the wire the
  // whole time and neither was read.
  if (obs.resultSubtype !== 'success') {
    return {
      ok: false,
      reason: 'the turn ended in a non-success result',
      expected: 'success',
      actual: obs.errors?.length
        ? `${obs.resultSubtype} (${obs.errors.join('; ')})`
        : obs.resultSubtype,
    };
  }

  // A `success` result with nothing in it still means the replay/translate
  // path is broken, and that is precisely what an end-to-end smoke is for.
  if (obs.streamedText.trim() === '') {
    return { ok: false, reason: 'result was success but no assistant text streamed' };
  }

  if (!obs.mock) return { ok: true };

  // Strict tier: mock output is a fixed fixture, so anything but the exact
  // bytes means the replay, the persistence hop or `translate()` altered the
  // payload. Equality rather than `.includes` because the two differ on
  // EXTRA content, not on truncation — a truncated stream fails either way,
  // but a stream carrying the fixture PLUS anything else (a duplicated
  // replay, a leaked banner, a doubled delta) is exactly the corruption
  // `.includes` would wave through.
  if (obs.streamedText !== MOCK_EXPECTED_TEXT) {
    return {
      ok: false,
      reason: 'streamed text did not match the mock fixture exactly',
      expected: MOCK_EXPECTED_TEXT,
      actual: obs.streamedText,
    };
  }

  if (obs.resultText !== MOCK_EXPECTED_TEXT) {
    return {
      ok: false,
      reason: "the result's own text did not match the mock fixture exactly",
      expected: MOCK_EXPECTED_TEXT,
      actual: obs.resultText ?? '(absent)',
    };
  }

  return { ok: true };
}

/**
 * Register S11 — the LIVE smoke's resume check.
 *
 * The old check compared the follow-up answer against `String(process.pid)`,
 * the smoke script's own pid, while the first turn ran `echo cebab-live-test-$$`
 * whose `$$` expands inside the AGENT's bash. Those are unrelated values. It
 * then fell back to `/\d+/.test(...)` — any digit anywhere — against a prompt
 * that explicitly asks for a number, so nearly every answer passed. And both
 * outcomes reached the same `process.exit(0)`.
 *
 * A nonce the script generates itself is the only value it can honestly
 * assert on, and `includes` is right here (unlike the mock tier's exact
 * match): a live model legitimately wraps the string in a sentence, and the
 * question is whether the SECOND subprocess saw the FIRST one's context —
 * not how it chose to phrase the answer.
 *
 * Lives here rather than in `live_smoke.ts` so it is testable: that script
 * opens a WebSocket at module scope, so importing it from a test would
 * connect a socket.
 */
export function sawNonce(resultText: string, nonce: string): boolean {
  return resultText.includes(nonce);
}

/** Render a verdict for the console, including the diff when there is one. */
export function formatVerdict(v: SmokeVerdict): string {
  if (v.ok) return '[smoke] PASS — protocol replayed end-to-end';
  const lines = [`[smoke] FAIL — ${v.reason}`];
  if (v.expected !== undefined) lines.push(`  expected: ${JSON.stringify(v.expected)}`);
  if (v.actual !== undefined) lines.push(`  actual:   ${JSON.stringify(v.actual)}`);
  return lines.join('\n');
}
