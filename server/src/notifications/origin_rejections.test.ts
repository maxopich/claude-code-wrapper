import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import {
  __resetForTests,
  capHeader,
  DEDUPE_KEYS_CAP,
  DISK_DEDUPE_WINDOW_MS,
  MAX_LOG_BYTES,
  MAX_RECORDED_HEADER_CHARS,
  recentRejections,
  recordRejection,
  rejectionLogPath,
  rotatedRejectionLogPath,
  REJECTION_RING_CAP,
  REJECTION_VISIBLE_WINDOW_MS,
  TRUNCATION_MARKER,
} from './origin_rejections.js';

// Cluster G E3 (server-side): origin_rejections.ts is the dual-write
// store for the Origin/Host gate. These tests pin:
//
//   1. Ring buffer FIFO + cap behaviour.
//   2. Visible-window query (5-min cutoff, `now` is injected).
//   3. Disk log: one JSON line per call, append-only, survives multiple
//      writes.
//   4. Failure isolation: disk-write failure doesn't take down the ring.
//
// The module relies on `config.dataDir` for the log location; we swap
// it to a tmpdir per test so cases don't bleed across runs.

let originalDataDir: string;
let tmpRoot: string;

beforeEach(() => {
  originalDataDir = config.dataDir;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-rejections-'));
  config.dataDir = path.join(tmpRoot, '.cebab');
});

afterEach(() => {
  config.dataDir = originalDataDir;
  __resetForTests();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // tmpdir cleanup is best-effort; nothing else uses it.
  }
});

describe('recordRejection / ring buffer', () => {
  test('first call inserts a single entry visible via recentRejections', () => {
    recordRejection({
      origin: 'http://evil.example',
      host: '127.0.0.1:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const r = recentRejections();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      origin: 'http://evil.example',
      host: '127.0.0.1:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(typeof r[0]?.ts).toBe('number');
  });

  test('multiple calls preserve insertion order (FIFO ring)', () => {
    for (const channel of ['http', 'ws', 'http'] as const) {
      recordRejection({
        origin: `http://${channel}.test`,
        host: null,
        reason: 'origin_not_allowed',
        channel,
      });
    }
    const r = recentRejections();
    expect(r.map((x) => x.origin)).toEqual([
      'http://http.test',
      'http://ws.test',
      'http://http.test',
    ]);
  });

  test('ring caps at REJECTION_RING_CAP — earliest entries drop off the front', () => {
    // Inject monotonically increasing ts so we can identify which
    // entries survived without depending on insertion-time order alone.
    for (let i = 0; i < REJECTION_RING_CAP + 5; i++) {
      recordRejection({
        ts: 1_700_000_000_000 + i,
        origin: `http://h${i}.test`,
        host: null,
        reason: 'origin_not_allowed',
        channel: 'http',
      });
    }
    // Use a future `now` so the window check doesn't truncate further.
    const r = recentRejections(1_700_000_000_000 + REJECTION_RING_CAP + 5);
    expect(r).toHaveLength(REJECTION_RING_CAP);
    // First entry should be index 5 (the 5 oldest got popped).
    expect(r[0]?.origin).toBe('http://h5.test');
    expect(r[r.length - 1]?.origin).toBe(`http://h${REJECTION_RING_CAP + 4}.test`);
  });

  test('recentRejections returns defensive copies — mutating the result does not affect the ring', () => {
    recordRejection({
      origin: 'http://x.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const a = recentRejections();
    a[0]!.reason = 'host_not_allowed';
    const b = recentRejections();
    expect(b[0]?.reason).toBe('origin_not_allowed');
  });
});

describe('recentRejections / visible window', () => {
  test('entries within REJECTION_VISIBLE_WINDOW_MS are returned; older are filtered', () => {
    const now = 1_700_000_000_000;
    // Just inside the window:
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS + 1,
      origin: 'http://recent.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    // Just outside the window:
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS - 1,
      origin: 'http://stale.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const r = recentRejections(now);
    expect(r.map((x) => x.origin)).toEqual(['http://recent.test']);
  });

  test('empty ring → empty array (sentinel for "no toast")', () => {
    expect(recentRejections()).toEqual([]);
  });

  test('all-stale ring → empty array (window filters every entry)', () => {
    const now = 1_700_000_000_000;
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS - 100,
      origin: 'http://stale.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(recentRejections(now)).toEqual([]);
  });
});

describe('disk log', () => {
  test('each distinct rejection appends one JSON line to origin_rejections.log', () => {
    recordRejection({
      origin: 'http://a.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    recordRejection({
      origin: null,
      host: 'evil.example:80',
      reason: 'host_not_allowed',
      channel: 'ws',
    });
    const raw = fs.readFileSync(rejectionLogPath(), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({
      origin: 'http://a.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(parsed[1]).toMatchObject({
      origin: null,
      host: 'evil.example:80',
      reason: 'host_not_allowed',
      channel: 'ws',
    });
  });

  test('log file is created lazily — dataDir/logs/ is mkdir -p before the first write', () => {
    // No `logs/` subdir exists yet; the first recordRejection must
    // create it. This guards against a regression where the module
    // assumes someone else (server boot) mkdirp'd the directory.
    expect(fs.existsSync(path.join(config.dataDir, 'logs'))).toBe(false);
    recordRejection({
      origin: 'http://x.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(fs.existsSync(rejectionLogPath())).toBe(true);
  });

  test('rejection survives in the ring even if disk write throws', () => {
    // Point dataDir at a path that exists as a FILE so mkdir + append
    // both fail (a regular file isn't a directory). The ring write
    // must still succeed and the entry must still be visible.
    config.dataDir = path.join(tmpRoot, 'notadir');
    fs.writeFileSync(config.dataDir, 'i am a file, not a directory');
    expect(() =>
      recordRejection({
        origin: 'http://x.test',
        host: null,
        reason: 'origin_not_allowed',
        channel: 'http',
      }),
    ).not.toThrow();
    expect(recentRejections()).toHaveLength(1);
  });
});

// [security] `Cebab-l4e` — the rejection log had no bound of any kind.
//
// `origin` and `host` are raw request headers, and `GET /auth-token` (one of
// the two callers) needs no token, so an unauthenticated local page can drive
// this path as fast as it can issue requests. Three independent bounds, one
// describe each, because each closes a hole the others leave open:
//
//   1. value cap    — one entry is small (ring, WS frame AND disk line)
//   2. disk dedupe  — a flood on one origin costs one line, not one per hit
//   3. rotation     — the backstop for a flood that VARIES the origin
//
// Every case asserts the ring is unaffected: repetition is the signal the
// operator's toast counts, and a "bound" that quietly stopped counting
// attempts would hide the abuse rather than the bytes.
describe('[security] bounded rejection log — value cap', () => {
  const overLong = `http://${'a'.repeat(MAX_RECORDED_HEADER_CHARS * 3)}.test`;

  test('an over-long origin is truncated with a marker, on disk and in the ring', () => {
    recordRejection({
      origin: overLong,
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });

    const expected = overLong.slice(0, MAX_RECORDED_HEADER_CHARS) + TRUNCATION_MARKER;
    expect(recentRejections()[0].origin).toBe(expected);

    const parsed = JSON.parse(fs.readFileSync(rejectionLogPath(), 'utf8').trim());
    expect(parsed.origin).toBe(expected);
    // The point of the cap: Node's 16 KiB header budget is the only other
    // limit, so without this a single line could be ~64x this size.
    expect(parsed.origin.length).toBeLessThan(overLong.length);
  });

  test('an over-long host is truncated too', () => {
    recordRejection({
      origin: null,
      host: 'h'.repeat(MAX_RECORDED_HEADER_CHARS * 2),
      reason: 'host_not_allowed',
      channel: 'ws',
    });
    expect(recentRejections()[0].host).toBe(
      'h'.repeat(MAX_RECORDED_HEADER_CHARS) + TRUNCATION_MARKER,
    );
  });

  // Anti-over-fix. A cap that also mangled ordinary values would make every
  // log line useless while still passing the truncation case above.
  test('a value at the cap is passed through untouched, and null stays null', () => {
    const exact = 'e'.repeat(MAX_RECORDED_HEADER_CHARS);
    expect(capHeader(exact)).toBe(exact);
    expect(capHeader('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(capHeader(null)).toBeNull();
  });

  // The cap must bound what is STORED, not what arrived — escaping expands,
  // so capping first would leave entries several times past the stated
  // constant and make the name a lie (register N03's shape).
  test('the cap bounds the stored value, escapes included', () => {
    const cut = capHeader('\u0000'.repeat(MAX_RECORDED_HEADER_CHARS))!;
    expect(cut.length).toBeLessThanOrEqual(MAX_RECORDED_HEADER_CHARS + TRUNCATION_MARKER.length);
    // …and the slice must not leave half an escape behind.
    expect(cut).not.toMatch(/\\u[0-9a-f]{0,3}$/);
    expect(cut.replace(TRUNCATION_MARKER, '')).toMatch(/^(\\u0000)+$/);
  });
});

// A rejection record is read by a human (`tail -f` on the log) and shipped to
// a browser (`recent_rejections`), and both fields in it are raw attacker-
// supplied request headers. `JSON.stringify` happens to escape the C0 half on
// the way to disk — which is why no line has ever been forged — but that is
// the serializer's property, not the record's, and it does nothing for the WS
// payload. These cases make the guarantee belong to `capHeader`.
describe('[security] bounded rejection log — hostile header characters', () => {
  test('CR and LF cannot forge a second log line', () => {
    recordRejection({
      origin: 'http://evil.test\r\n{"origin":"http://trusted.test","reason":"forged"}',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const raw = fs.readFileSync(rejectionLogPath(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(recentRejections()[0].origin).toContain('\\u000d\\u000a');
    // The forged fragment survives as inert TEXT inside the real record —
    // dropping it would lose the evidence of what was attempted.
    expect(recentRejections()[0].origin).toContain('forged');
  });

  test('terminal escapes cannot fire when the operator tails the log', () => {
    recordRejection({
      origin: 'http://a.test\u001b[2J\u001b[1;31mSAFE',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'ws',
    });
    const stored = recentRejections()[0].origin;
    const ESC = String.fromCharCode(27);
    // No raw ESC anywhere — in the WS payload OR on disk. The first half is
    // what JSON.stringify was never protecting.
    expect(stored).not.toContain(ESC);
    expect(stored).toContain('\\u001b');
    expect(fs.readFileSync(rejectionLogPath(), 'utf8')).not.toContain(ESC);
  });

  test('bidi overrides cannot make a hostile origin render as an allowed one', () => {
    recordRejection({
      origin: `http://${String.fromCharCode(0x202e)}tsoh-live${String.fromCharCode(0x202c)}.test`,
      host: null,
      reason: 'origin_not_allowed',
      channel: 'ws',
    });
    const stored = recentRejections()[0].origin;
    expect(stored).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(stored).toContain('\\u202e');
  });

  test('the escaping is reversible — a literal backslash is escaped first', () => {
    expect(capHeader('a\\u0041b')).toBe('a\\\\u0041b');
  });

  // Anti-over-fix: ordinary header characters must survive untouched, or
  // every record becomes unreadable while all four cases above still pass.
  test('ordinary origins and hosts pass through byte-for-byte', () => {
    for (const v of [
      'http://127.0.0.1:5173',
      'http://xn--80ak6aa92e.com',
      'https://sub.domain.example:8443',
      'localhost:4319',
      'http://example.test/~user?q=1&r=2#frag',
    ]) {
      expect(capHeader(v)).toBe(v);
    }
  });
});

describe('[security] bounded rejection log — disk dedupe', () => {
  const rep = {
    origin: 'http://flood.test',
    host: 'localhost:4319',
    reason: 'origin_not_allowed',
    channel: 'http',
  } as const;

  test('a flood on one key writes one line while the ring records every hit', () => {
    for (let i = 0; i < 50; i++) recordRejection({ ...rep, ts: 1_000 + i });

    const lines = fs.readFileSync(rejectionLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    // The ring is deliberately NOT deduped — 50 attempts is what the operator
    // is told about.
    expect(recentRejections(1_050)).toHaveLength(50);
  });

  test('the suppressed count is carried onto the next written line, not dropped', () => {
    for (let i = 0; i < 5; i++) recordRejection({ ...rep, ts: 1_000 + i });
    // Past the window: this one writes, and reports the four it swallowed.
    recordRejection({ ...rep, ts: 1_000 + DISK_DEDUPE_WINDOW_MS + 1 });

    const parsed = fs
      .readFileSync(rejectionLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    // The first line keeps the shape it always had — no field appears until
    // it means something.
    expect(parsed[0].suppressed).toBeUndefined();
    expect(parsed[1].suppressed).toBe(4);
  });

  test('distinct keys are not collapsed into each other', () => {
    recordRejection({ ...rep, ts: 1_000 });
    recordRejection({ ...rep, ts: 1_001, origin: 'http://other.test' });
    recordRejection({ ...rep, ts: 1_002, channel: 'ws' });
    recordRejection({ ...rep, ts: 1_003, reason: 'host_not_allowed' });

    const lines = fs.readFileSync(rejectionLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
  });

  // Anti-over-fix, and the case that matters most: the FIRST occurrence of
  // anything must always reach disk. A dedupe that swallowed cold keys would
  // pass every other case here and lose the only record of a one-off probe.
  test('a cold key always writes immediately', () => {
    recordRejection({ ...rep, ts: 5_000 });
    expect(fs.readFileSync(rejectionLogPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('the dedupe table is bounded — the coldest key is evicted, not remembered', () => {
    recordRejection({ ...rep, ts: 1_000 });
    // Push the first key out with exactly enough distinct ones.
    for (let i = 0; i < DEDUPE_KEYS_CAP; i++) {
      recordRejection({ ...rep, ts: 1_001 + i, origin: `http://k${i}.test` });
    }
    // Same key, still inside the dedupe window. It writes again — which is
    // only possible if the table forgot it, i.e. the Map did not grow.
    recordRejection({ ...rep, ts: 1_100 });

    const lines = fs.readFileSync(rejectionLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(DEDUPE_KEYS_CAP + 2);
    expect(1_100 - 1_000).toBeLessThan(DISK_DEDUPE_WINDOW_MS); // the window did not lapse
  });
});

describe('[security] bounded rejection log — rotation', () => {
  /** Pre-fill the log to the cap. Cheaper and more honest than making
   *  MAX_LOG_BYTES injectable: the test then exercises the real constant. */
  function fillLogToCap(): void {
    fs.mkdirSync(path.dirname(rejectionLogPath()), { recursive: true });
    fs.writeFileSync(rejectionLogPath(), 'x'.repeat(MAX_LOG_BYTES), { mode: 0o600 });
  }

  test('a write past MAX_LOG_BYTES rotates to .1 and starts a fresh log', () => {
    fillLogToCap();
    recordRejection({
      origin: 'http://rotate.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });

    expect(fs.existsSync(rotatedRejectionLogPath())).toBe(true);
    expect(fs.statSync(rotatedRejectionLogPath()).size).toBe(MAX_LOG_BYTES);
    // The new log holds only the line that triggered the roll.
    const lines = fs.readFileSync(rejectionLogPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).origin).toBe('http://rotate.test');
  });

  test('only one generation is kept — a second roll replaces .1', () => {
    fs.mkdirSync(path.dirname(rejectionLogPath()), { recursive: true });
    fs.writeFileSync(rotatedRejectionLogPath(), 'stale generation');
    fillLogToCap();
    recordRejection({
      origin: 'http://rotate2.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(fs.readFileSync(rotatedRejectionLogPath(), 'utf8')).not.toContain('stale generation');
  });

  // Anti-over-fix: rotation must not fire on an ordinary log.
  test('an under-cap log is not rotated', () => {
    recordRejection({
      origin: 'http://small.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(fs.existsSync(rotatedRejectionLogPath())).toBe(false);
  });

  test('the rotated generation keeps owner-only mode', () => {
    if (process.platform === 'win32') return;
    fillLogToCap();
    recordRejection({
      origin: 'http://rotate3.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    // rename() carries the mode across with the inode; a copy+truncate
    // implementation would silently re-create it under the ambient umask.
    expect(fs.statSync(rotatedRejectionLogPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rejectionLogPath()).mode & 0o777).toBe(0o600);
  });
});

// [security] Register H01 — the rejection log used the ambient umask.
//
// Rejection records name the origins and hosts that tried to reach the WS
// gate, and they sit in `~/.cebab/logs/` beside the transcripts. They get the
// same owner-only treatment. Windows-gated as `auth.test.ts:32` gates its own
// mode assertions — Node maps only the write bit there.
describe('[security] rejection log permissions', () => {
  test('the log and its directory are owner-only', () => {
    if (process.platform === 'win32') return;
    recordRejection({
      origin: 'http://evil.test',
      host: '127.0.0.1:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });

    expect(fs.statSync(rejectionLogPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(rejectionLogPath())).mode & 0o777).toBe(0o700);
  });
});
