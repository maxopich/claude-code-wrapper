/**
 * Phase H: hash-route helpers shared by `LogsButton` (which opens the modal
 * when the URL matches) and the bidirectional-link affordances on lane rows
 * and artifact rows (which navigate to the modal with a row pointer).
 *
 * Hash format:
 *   #/session/<sessionId>/logs           — open the Logs modal
 *   #/session/<sessionId>/logs?row=<id>  — open AND scroll to the LogRow
 *                                          whose id matches <id>
 *
 * `<id>` is a LogRow.id (e.g. `event:42` or `mutation:7`). It is the same
 * value the server emits in the chunk, so the modal can find the matching
 * row in its local cache without any extra round-trip.
 *
 * Pure: no DOM reads, no globals. Tests can import these directly.
 */

export function logsHashFor(sessionId: string, rowId?: string): string {
  const base = `#/session/${sessionId}/logs`;
  if (!rowId) return base;
  return `${base}?row=${encodeURIComponent(rowId)}`;
}

/** Parse `?row=<id>` out of a hash like `#/session/abc/logs?row=event:42`.
 *  Returns null when the hash has no `row=` query (or it's empty). */
export function parseLogsRowAnchor(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q === -1) return null;
  const query = hash.slice(q + 1);
  const params = new URLSearchParams(query);
  const row = params.get('row');
  return row ? row : null;
}

/** True iff this hash targets the Logs modal for `sessionId`. */
export function hashIsLogsFor(hash: string, sessionId: string): boolean {
  const expected = `#/session/${sessionId}/logs`;
  return hash === expected || hash.startsWith(`${expected}?`);
}
