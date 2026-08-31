/**
 * The one definition of a session-log export's filename.
 *
 * WHY IT MOVED HERE (`Cebab-89j`). It was two hand-maintained copies —
 * `exportFilename` in `server/src/session_log_export.ts` and
 * `pickExportFilename` in `web/src/exports.ts` — each with its own tests
 * asserting the same shape by hand, and nothing tying them together. The web
 * copy's own comment said it "mirrors the server's `exportFilename()`", which
 * is a claim no test checked. Both packages already import runtime values from
 * `@cebab/shared`, so a shared definition costs nothing and removes the drift
 * surface instead of doubling it.
 *
 * WHY THE FORMAT IS IN THE NAME. A raw export and a redacted export of the
 * same session used to produce a BYTE-IDENTICAL filename. That is the sharpest
 * remaining edge of `Cebab-ygu.47`, whose whole finding was an artifact that
 * asserted `exported_redacted` while the file held plaintext: two files in a
 * Downloads folder, one safe to share and one not, indistinguishable. The
 * `safety_audit` row knows which is which; the file the operator actually
 * hands to someone did not say.
 *
 * The filename is the only part of the artifact that travels with it — a
 * reader who opens the JSONL sees lines, not a policy. Naming the format is
 * therefore the cheapest honest signal available, and unlike a policy line in
 * the body it changes no parser's contract and cannot be mistaken for an
 * assurance about the CONTENTS: `-redacted` names the code path that produced
 * the bytes, exactly as `REDACTED_CONTENT_POLICY` does on the audit row.
 *
 * IT IS NOT A CLAIM THAT THE FILE IS SAFE. `redact.test.ts`'s "KNOWN LIMIT"
 * case still passes: a secret with neither a credential-shaped key nor a
 * credential-shaped value still ships. `Cebab-89j` stays open for that.
 */

/** Which code path produced the bytes. Mirrors the server's `ExportFormat`. */
export type SessionLogExportFormat = 'redacted' | 'raw';

/**
 * `cebab-<shortid>-<YYYYMMDD-HHMMSS>-<format>.jsonl`.
 *
 * The stamp is LOCAL time, deliberately: the operator matches it against the
 * session they just watched, not against UTC. That makes it environment-
 * supplied, so tests derive the expected value rather than hardcoding it —
 * `session_log_export.test.ts` already learned this the hard way across a DST
 * boundary.
 */
export function sessionLogExportFilename(
  sessionId: string,
  sessionStartMs: number | null,
  format: SessionLogExportFormat,
): string {
  const short = sessionId.slice(0, 8);
  const ts = sessionStartMs ?? Date.now();
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `cebab-${short}-${stamp}-${format}.jsonl`;
}
