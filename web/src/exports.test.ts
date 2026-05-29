// @vitest-environment jsdom
/**
 * Cluster I C2 UI: tests for the shared exports module.
 *
 * Three layers exercised:
 *
 *   - Pure functions (`buildSessionLogExportUrl`, `pickExportFilename`,
 *     `parseContentDispositionFilename`) — pin URL / filename shapes
 *     without DOM or network.
 *
 *   - `triggerBlobDownload` — JSDOM is enough; we observe the
 *     dynamically-created `<a download>` to confirm filename + click.
 *
 *   - `downloadSessionLog` — injects `fetchImpl` and asserts the URL,
 *     headers (raw-ack pairing), 200-path filename pickup from
 *     Content-Disposition, fallback to `pickExportFilename`, and the
 *     three error shapes (`http`, `network`, JSON-typed).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildSessionLogExportUrl,
  downloadSessionLog,
  isDownloadError,
  parseContentDispositionFilename,
  pickExportFilename,
  RAW_ACK_HEADER,
  RAW_ACK_VALUE,
  triggerBlobDownload,
} from './exports';

const BASE = 'http://127.0.0.1:4319';

describe('buildSessionLogExportUrl', () => {
  test('omits format when not specified', () => {
    const url = buildSessionLogExportUrl({
      baseUrl: BASE,
      sessionId: 'sess-1',
      token: 'tok123',
    });
    expect(url).toBe(`${BASE}/session-log/sess-1?token=tok123`);
  });

  test('encodes a non-trivial sessionId', () => {
    const url = buildSessionLogExportUrl({
      baseUrl: BASE,
      sessionId: 'a/b c',
      token: 'tok',
    });
    expect(url).toBe(`${BASE}/session-log/a%2Fb%20c?token=tok`);
  });

  test('includes format=raw when requested', () => {
    const url = buildSessionLogExportUrl({
      baseUrl: BASE,
      sessionId: 's',
      token: 'tok',
      format: 'raw',
    });
    expect(url).toBe(`${BASE}/session-log/s?token=tok&format=raw`);
  });

  test('passes format=redacted explicitly (even though it is the default)', () => {
    const url = buildSessionLogExportUrl({
      baseUrl: BASE,
      sessionId: 's',
      token: 'tok',
      format: 'redacted',
    });
    expect(url).toBe(`${BASE}/session-log/s?token=tok&format=redacted`);
  });
});

describe('pickExportFilename', () => {
  test('uses the start time in UTC', () => {
    // 2024-01-15 09:30:45 UTC = 1705311045000
    const filename = pickExportFilename('abcd1234-cafe-beef-0000-000000000000', 1705311045000);
    expect(filename).toBe('cebab-abcd1234-20240115-093045.jsonl');
  });

  test('falls back to Date.now() when start is null', () => {
    const before = Date.now();
    const filename = pickExportFilename('xx', null);
    const after = Date.now();
    const m = filename.match(/^cebab-xx-(\d{8})-(\d{6})\.jsonl$/);
    expect(m).not.toBeNull();
    if (!m) return;
    const [, ymd, hms] = m;
    const stampMs = Date.UTC(
      Number(ymd!.slice(0, 4)),
      Number(ymd!.slice(4, 6)) - 1,
      Number(ymd!.slice(6, 8)),
      Number(hms!.slice(0, 2)),
      Number(hms!.slice(2, 4)),
      Number(hms!.slice(4, 6)),
    );
    expect(stampMs).toBeGreaterThanOrEqual(before - 1000);
    expect(stampMs).toBeLessThanOrEqual(after + 1000);
  });
});

describe('parseContentDispositionFilename', () => {
  test('extracts a quoted filename', () => {
    expect(
      parseContentDispositionFilename('attachment; filename="cebab-abc-20240115-093045.jsonl"'),
    ).toBe('cebab-abc-20240115-093045.jsonl');
  });

  test('returns null for unquoted variants (server always emits quoted form)', () => {
    expect(parseContentDispositionFilename('attachment; filename=cebab.jsonl')).toBeNull();
  });

  test('returns null for null/empty input', () => {
    expect(parseContentDispositionFilename(null)).toBeNull();
    expect(parseContentDispositionFilename('')).toBeNull();
  });

  test('returns null when no filename param', () => {
    expect(parseContentDispositionFilename('attachment')).toBeNull();
  });
});

describe('triggerBlobDownload', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let createdUrls: string[];

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    createdUrls = [];
    let id = 0;
    URL.createObjectURL = () => {
      id += 1;
      const url = `blob:fake-${id}`;
      createdUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  test('creates an <a download> with the filename and clicks it', () => {
    const clicked: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = originalCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => {
          clicked.push(el as HTMLAnchorElement);
        };
      }
      return el;
    });
    triggerBlobDownload({
      data: 'hello',
      mimeType: 'application/x-ndjson',
      filename: 'cebab-test.jsonl',
    });
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('cebab-test.jsonl');
    expect(clicked[0]!.href).toBe(createdUrls[0]);
    spy.mockRestore();
  });
});

describe('downloadSessionLog', () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  function mockResponse(opts: {
    status: number;
    body?: string;
    contentDisposition?: string;
    contentType?: string;
    rejectReason?: string;
  }): Response {
    const headers = new Headers();
    if (opts.contentDisposition) headers.set('content-disposition', opts.contentDisposition);
    if (opts.contentType) headers.set('content-type', opts.contentType);
    if (opts.rejectReason) headers.set('X-Cebab-Reject-Reason', opts.rejectReason);
    return new Response(opts.body ?? '', {
      status: opts.status,
      headers,
    });
  }

  test('hits the right URL with no headers when format=redacted', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return mockResponse({
        status: 200,
        body: 'line\n',
        contentDisposition: 'attachment; filename="cebab-sess-fix-20240115-093045.jsonl"',
        contentType: 'application/x-ndjson',
      });
    });
    const result = await downloadSessionLog({
      baseUrl: BASE,
      sessionId: 'sess-1',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/session-log/sess-1?token=tok`);
    // No raw-ack header on default (redacted) path.
    expect(
      (capturedInit?.headers as Record<string, string> | undefined)?.[RAW_ACK_HEADER],
    ).toBeUndefined();
    expect(result.filename).toBe('cebab-sess-fix-20240115-093045.jsonl');
    expect(result.bytes).toBe(5);
  });

  test('sends X-Cebab-Acknowledge-Raw only when format=raw AND ack=true', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return mockResponse({
        status: 200,
        body: 'x',
        contentDisposition: 'attachment; filename="raw.jsonl"',
      });
    });
    await downloadSessionLog({
      baseUrl: BASE,
      sessionId: 'sess-1',
      token: 'tok',
      format: 'raw',
      ack: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedHeaders?.[RAW_ACK_HEADER]).toBe(RAW_ACK_VALUE);
  });

  test('does NOT send the ack header when format=raw but ack is missing', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return mockResponse({
        status: 200,
        body: 'x',
        contentDisposition: 'attachment; filename="raw.jsonl"',
      });
    });
    await downloadSessionLog({
      baseUrl: BASE,
      sessionId: 'sess-1',
      token: 'tok',
      format: 'raw',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedHeaders?.[RAW_ACK_HEADER]).toBeUndefined();
  });

  test('falls back to filenameHint when server omits Content-Disposition', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 200, body: 'x' }));
    const result = await downloadSessionLog({
      baseUrl: BASE,
      sessionId: 'sess-fall',
      token: 'tok',
      filenameHint: 'my-fallback.jsonl',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.filename).toBe('my-fallback.jsonl');
  });

  test('falls back to pickExportFilename when neither header nor hint present', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 200, body: 'x' }));
    const result = await downloadSessionLog({
      baseUrl: BASE,
      sessionId: 'sess-fallback',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Shape only — Date.now() varies. `sess-fall` is the first 8 chars.
    expect(result.filename).toMatch(/^cebab-sess-fal-\d{8}-\d{6}\.jsonl$/);
  });

  test('throws DownloadSessionLogError on non-OK status', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 404, rejectReason: 'not_found' }));
    try {
      await downloadSessionLog({
        baseUrl: BASE,
        sessionId: 'sess-1',
        token: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isDownloadError(err)).toBe(true);
      if (isDownloadError(err)) {
        expect(err.kind).toBe('http');
        expect(err.status).toBe(404);
        expect(err.rejectReason).toBe('not_found');
      }
    }
  });

  test('throws DownloadSessionLogError on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    try {
      await downloadSessionLog({
        baseUrl: BASE,
        sessionId: 'sess-1',
        token: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isDownloadError(err)).toBe(true);
      if (isDownloadError(err)) {
        expect(err.kind).toBe('network');
        expect(err.message).toContain('Failed to fetch');
      }
    }
  });
});
