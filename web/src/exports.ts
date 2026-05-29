/**
 * Cluster I C2 UI: shared export helpers.
 *
 * Consolidates the blob-download pattern that previously lived as a local
 * helper inside `LogsModal` (NDJSON of filtered LogRows) and now also
 * serves the per-session `GET /session-log/:sid` JSONL fetch from the
 * sidebar `⤓` icon-btn. The C5 bulk-export slice will hang off the same
 * helpers when it lands.
 *
 * Three layers:
 *
 *   - `triggerBlobDownload({ data, mimeType, filename })` — wraps the
 *     `Blob` + `URL.createObjectURL` + invisible `<a download>` + click
 *     + revoke dance. Pure browser concern; no auth or network.
 *
 *   - `buildSessionLogExportUrl({ baseUrl, sessionId, token, format })`
 *     — builds the gated URL the C2 backend serves. Used by the actual
 *     download path AND by tests that don't want to roundtrip the fetch.
 *
 *   - `downloadSessionLog({ baseUrl, sessionId, token, format, ack,
 *     filenameHint })` — the high-level "click happened, do the right
 *     thing" function: fetch with the optional `X-Cebab-Acknowledge-Raw`
 *     header (when `format === 'raw'`), turn the response into a blob,
 *     trigger the download, return `{ filename, bytes }` so the caller
 *     can toast the result.
 *
 * Filename convention mirrors the server's `exportFilename()` in
 * `server/src/session_log_export.ts`: `cebab-<shortid>-<YYYYMMDD-
 * HHMMSS>.jsonl` where the stamp is the session **start** time (NOT
 * the export time) so a folder of exports sorts by run order. The
 * server already stamps the Content-Disposition header with this
 * filename, so the client only computes a fallback for the rare case
 * where the response lacks one (offline test fixture, error paths).
 *
 * Privacy posture: this module does NOT make raw-vs-redacted decisions
 * by itself. The default `format` is `redacted`; callers that want
 * `raw` must explicitly pass `format: 'raw'` + `ack: true` to ALSO
 * include the `X-Cebab-Acknowledge-Raw: I-understand` header. The
 * paired flag stops "the modal lib defaults to ack:true" from
 * silently downgrading the privacy posture; an opt-in must spell
 * BOTH out.
 */

/** Mirror of the server's `X-Cebab-Acknowledge-Raw` header name. */
export const RAW_ACK_HEADER = 'X-Cebab-Acknowledge-Raw';
/** Literal value the server checks for. */
export const RAW_ACK_VALUE = 'I-understand';

export type ExportFormat = 'redacted' | 'raw';

/**
 * Trigger a browser download for in-memory data. Used by:
 *   1. The new per-session JSONL export path (this slice).
 *   2. LogsModal's NDJSON export of filtered rows.
 *   3. (Future) C5 bulk-export blob handoff.
 *
 * Implementation note: the deferred `revokeObjectURL` gives the
 * browser ~1s to start the download before we release the blob URL.
 * Skipping that delay can cause the download to silently fail on
 * Safari (race between the click and the revoke).
 */
export function triggerBlobDownload(opts: {
  data: BlobPart;
  mimeType: string;
  filename: string;
}): void {
  const blob = new Blob([opts.data], { type: opts.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build the URL the browser fetches for `GET /session-log/:sid`.
 * Pure: no DOM, no network. Exported so tests can pin the URL shape
 * (`?token=...&format=...`) without spinning up a server.
 */
export function buildSessionLogExportUrl(opts: {
  baseUrl: string;
  sessionId: string;
  token: string;
  format?: ExportFormat;
}): string {
  const params = new URLSearchParams();
  params.set('token', opts.token);
  if (opts.format) params.set('format', opts.format);
  // encodeURIComponent on sessionId — defense-in-depth even though the
  // server enforces a [a-zA-Z0-9_-]{1,128} regex on its end.
  return `${opts.baseUrl}/session-log/${encodeURIComponent(opts.sessionId)}?${params.toString()}`;
}

/**
 * Default filename: `cebab-<shortid>-<YYYYMMDD-HHMMSS>.jsonl`. Mirrors
 * the server's `exportFilename()`. Used when the response is missing a
 * Content-Disposition (offline fixtures, error paths) — production
 * downloads should pick up the server-stamped filename instead.
 */
export function pickExportFilename(sessionId: string, sessionStartMs: number | null): string {
  const short = sessionId.slice(0, 8);
  const ts = sessionStartMs ?? Date.now();
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `cebab-${short}-${stamp}.jsonl`;
}

/**
 * Parse `filename="..."` out of a Content-Disposition header. Returns
 * null when the header is missing or doesn't carry a quoted filename.
 * Conservative — we don't try to handle `filename*=UTF-8''` extended
 * encoding; the server always emits the simple ASCII form.
 */
export function parseContentDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const m = /filename="([^"]+)"/.exec(headerValue);
  return m ? (m[1] ?? null) : null;
}

export type DownloadSessionLogResult = {
  filename: string;
  bytes: number;
};

export type DownloadSessionLogError = {
  /**
   * Discriminator. `http` means the fetch landed with a non-OK status
   * (the server told us no); `network` means the fetch itself threw
   * (server down / disconnected mid-stream); `unknown` is the catchall.
   */
  kind: 'http' | 'network' | 'unknown';
  status?: number;
  /** Server's `X-Cebab-Reject-Reason` when present; helps the toast
   *  pick a more specific message than "Download failed". */
  rejectReason?: string;
  message: string;
};

function isDownloadError(value: unknown): value is DownloadSessionLogError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in (value as Record<string, unknown>) &&
    'message' in (value as Record<string, unknown>)
  );
}

/**
 * Fetch the session log, turn the response into a blob, trigger a
 * browser download. Throws a `DownloadSessionLogError` on any path
 * (HTTP, network, unknown); caller is expected to catch + toast.
 *
 * `ack` MUST be `true` to send the `X-Cebab-Acknowledge-Raw` header.
 * The pairing with `format: 'raw'` is deliberate — see the privacy
 * note in the module header.
 */
export async function downloadSessionLog(opts: {
  baseUrl: string;
  sessionId: string;
  token: string;
  format?: ExportFormat;
  /** Required-true to send the raw-export acknowledgement header. */
  ack?: boolean;
  /** Fallback filename when the response has no Content-Disposition. */
  filenameHint?: string;
  /** Test injection point; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}): Promise<DownloadSessionLogResult> {
  const url = buildSessionLogExportUrl({
    baseUrl: opts.baseUrl,
    sessionId: opts.sessionId,
    token: opts.token,
    format: opts.format,
  });
  const headers: Record<string, string> = {};
  if (opts.format === 'raw' && opts.ack === true) {
    headers[RAW_ACK_HEADER] = RAW_ACK_VALUE;
  }
  const fetcher = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await fetcher(url, { headers });
  } catch (err) {
    const error: DownloadSessionLogError = {
      kind: 'network',
      message: err instanceof Error ? err.message : String(err),
    };
    throw error;
  }
  if (!res.ok) {
    const rejectReason = res.headers.get('X-Cebab-Reject-Reason') ?? undefined;
    const error: DownloadSessionLogError = {
      kind: 'http',
      status: res.status,
      rejectReason,
      message: `download failed: ${res.status}${rejectReason ? ` (${rejectReason})` : ''}`,
    };
    throw error;
  }
  // Server stamps the canonical filename. Fall back to the hint when
  // a test rig or proxy strips the header.
  const dispositionFilename = parseContentDispositionFilename(
    res.headers.get('content-disposition'),
  );
  const filename =
    dispositionFilename ?? opts.filenameHint ?? pickExportFilename(opts.sessionId, null);

  const buf = await res.arrayBuffer();
  triggerBlobDownload({
    data: buf,
    mimeType: res.headers.get('content-type') ?? 'application/x-ndjson',
    filename,
  });
  return { filename, bytes: buf.byteLength };
}

/**
 * Re-export so callers can `catch (e) { if (isDownloadError(e)) … }`
 * without redefining the discriminator. The thrown shape is the
 * `DownloadSessionLogError` type above; this helper exists so consumers
 * outside this module can type-guard on it.
 */
export { isDownloadError };
