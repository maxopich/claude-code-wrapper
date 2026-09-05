/**
 * [security] Register H02 + H03 — the bounded, TOCTOU-safe reader.
 *
 * The three hazards this closes, each asserted below:
 *
 *   BLOCKING   a FIFO parks the event loop until a writer appears. On a
 *              single-threaded server that is the WHOLE server, not one
 *              request. Asserted twice: with a real named pipe (end to end,
 *              POSIX only) AND on the open flags (fast, everywhere). The
 *              second is not redundant — a blocking regression freezes the
 *              worker, and vitest's timeout is JavaScript, so it cannot fire.
 *   UNBOUNDED  a huge file is read entirely into memory.
 *   WRONG TYPE a directory or device is not a file and must not be read.
 *
 * FIFO cases are POSIX-only — `mkfifo` does not exist on Windows, and the
 * O_NONBLOCK constant it depends on is absent there too. The size and type
 * cases run everywhere, so the Windows leg still covers the caps.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  isDirectChildOf,
  readFileBounded,
  readFilePrefixBounded,
  readTextBounded,
  readTextPrefixBounded,
  resolveSessionFolderInside,
} from './safe_fs.js';

const isWindows = process.platform === 'win32';
/** FIFO tests need mkfifo; skip the whole case on Windows rather than fake it. */
const posixOnly = isWindows ? test.skip : test;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-safe-fs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, contents: string | Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('[security] readFileBounded — the happy path still works', () => {
  test('reads a regular file whole', () => {
    const p = write('ok.txt', 'hello world');
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.toString('utf8')).toBe('hello world');
    expect(r.size).toBe(11);
  });

  test('reads an empty file as empty rather than refusing', () => {
    const p = write('empty.txt', '');
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(0);
  });

  test('a file exactly at the cap is allowed', () => {
    // Off-by-one guard: the check is `size > maxBytes`, so == must pass.
    const p = write('exact.bin', Buffer.alloc(100, 0x41));
    const r = readFileBounded(p, 100);
    expect(r.ok).toBe(true);
  });

  test('readTextBounded decodes utf8', () => {
    const p = write('utf8.txt', 'héllo — ok');
    const r = readTextBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('héllo — ok');
  });

  test('invalid utf8 becomes U+FFFD instead of throwing', () => {
    const p = write('bad.bin', Buffer.from([0xff, 0xfe, 0x41]));
    const r = readTextBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('A');
  });
});

describe('[security] readFileBounded — refusals', () => {
  test('refuses a file over the cap, and does not truncate it instead', () => {
    // The load-bearing distinction for H02: callers hash these bytes, so a
    // silent prefix would make different files compare equal. Over-cap must
    // be a REFUSAL, never a partial success.
    const p = write('big.bin', Buffer.alloc(2048, 0x42));
    const r = readFileBounded(p, 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('too_large');
  });

  test('refuses a directory', () => {
    const r = readFileBounded(tmp, 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Windows fails at open (a dir cannot be opened O_RDONLY); POSIX opens it
    // and fstat reports a directory. Both are refusals — that is what matters.
    expect(['not_a_file', 'unreadable']).toContain(r.refusal);
  });

  test('refuses a path that does not exist', () => {
    const r = readFileBounded(path.join(tmp, 'nope.txt'), 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('unreadable');
  });

  posixOnly(
    'refuses a FIFO WITHOUT hanging — the DoS this exists for',
    () => {
      const fifo = path.join(tmp, 'pipe');
      execFileSync('mkfifo', [fifo]);

      // No writer is ever attached. A plain fs.readFileSync here parks the
      // event loop forever; O_NONBLOCK makes the open return immediately.
      //
      // CAVEAT, measured rather than assumed: if this regresses the suite
      // HANGS, it does not fail. A blocking `openSync` freezes the event
      // loop, and vitest's per-test timeout is itself JavaScript, so it can
      // never fire — the earlier claim here that "vitest kills the run on its
      // timeout" was wrong. The flags assertion below is the counterpart that
      // reddens promptly; this case is kept because it is the only one that
      // exercises a real named pipe end to end.
      const started = Date.now();
      const r = readFileBounded(fifo, 1024);
      const elapsed = Date.now() - started;

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe('not_a_file');
      // Generous bound — a blocking open would sit here indefinitely, not for
      // two seconds. This asserts "returned promptly", not a latency budget.
      expect(elapsed).toBeLessThan(2000);
    },
    10_000,
  );

  posixOnly(
    'refuses a character device without reading it',
    () => {
      // /dev/zero is infinite: an unbounded read never terminates and eats
      // memory as fast as it can allocate.
      const r = readFileBounded('/dev/zero', 1024);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal).toBe('not_a_file');
    },
    10_000,
  );
});

describe('[security] both readers open NON-BLOCKING', () => {
  // The non-hanging counterpart to the FIFO cases. Those exercise a real named
  // pipe, but a regression makes them freeze rather than fail (see the caveat
  // above), and a frozen CI job is worse than a red one. This asserts the flag
  // that makes the FIFO case work, against an ordinary file, so it can never
  // block — and it runs on Windows too, where mkfifo does not exist.
  function flagsUsedBy(read: (p: string) => unknown): number[] {
    const p = write('flagged.txt', 'x');
    const flags: number[] = [];
    const realOpen = fs.openSync.bind(fs);
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike,
      f: number,
      m?: fs.Mode,
    ) => {
      flags.push(typeof f === 'number' ? f : 0);
      return realOpen(target, f, m);
    }) as typeof fs.openSync);
    try {
      read(p);
    } finally {
      spy.mockRestore();
    }
    return flags;
  }

  /** 0 on Windows, where the constant does not exist and the code says
   *  `?? 0`. There is no bit to assert there, so the flag check is skipped
   *  explicitly rather than passing vacuously against zero. */
  const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

  test('readFileBounded opens exactly once, non-blocking', () => {
    const flags = flagsUsedBy((p) => readFileBounded(p, 1024));
    expect(flags).toHaveLength(1);
    if (NONBLOCK === 0) return;
    expect(flags[0]! & NONBLOCK).toBe(NONBLOCK);
  });

  test('readFilePrefixBounded opens exactly once, non-blocking', () => {
    const flags = flagsUsedBy((p) => readFilePrefixBounded(p, 1024));
    expect(flags).toHaveLength(1);
    if (NONBLOCK === 0) return;
    expect(flags[0]! & NONBLOCK).toBe(NONBLOCK);
  });
});

describe('[security] readFileBounded — descriptor hygiene', () => {
  test('does not leak descriptors across many refused reads', () => {
    // A leak here would be a slow-motion DoS of its own: every pre-spawn
    // resolve that hits a hostile path would burn an fd until EMFILE.
    const dir = tmp;
    const missing = path.join(tmp, 'nope');
    const big = write('leak-big.bin', Buffer.alloc(4096, 0x43));
    const good = write('leak-good.txt', 'fine');

    for (let i = 0; i < 200; i++) {
      readFileBounded(dir, 1024);
      readFileBounded(missing, 1024);
      readFileBounded(big, 1024);
      readFileBounded(good, 1024);
    }

    // If the finally-block close were missing, 800 opens would have exhausted
    // the default fd limit long before here and this last read would fail.
    const r = readFileBounded(good, 1024);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The PREFIX variant (register H11 + Cebab-x1n.6.21). Same three hazards, but
// over-cap is a head read rather than a refusal — for the callers that
// legitimately truncate (a file preview, a CLAUDE.md injection).
// ---------------------------------------------------------------------------

describe('[security] readFilePrefixBounded — bounded head reads', () => {
  test('reads a whole file that fits, and does not claim truncation', () => {
    const p = write('small.txt', 'hello world');
    const r = readFilePrefixBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.toString('utf8')).toBe('hello world');
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(11);
    expect(r.onDiskSize).toBe(11);
  });

  test('a file exactly at the cap is not truncated', () => {
    // Off-by-one guard: the check is `size > maxBytes`, so == must come back
    // whole and NOT flagged — a spurious "(truncated)" label is a lie too.
    const p = write('exact.bin', Buffer.alloc(100, 0x41));
    const r = readFilePrefixBounded(p, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(100);
  });

  test('NEVER allocates past the cap, whatever the file size — the H11 assertion', () => {
    // The defect this replaces read the file WHOLE and applied its cap to the
    // resulting string, so memory tracked the file, not the cap. 4 MB against
    // a 64 KiB cap: `size` is the bytes actually pulled in, so asserting it
    // here is a direct measurement of that, not a proxy.
    const CAP = 64 * 1024;
    const p = write('huge.bin', Buffer.alloc(4 * 1024 * 1024, 0x44));
    const r = readFilePrefixBounded(p, CAP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.size).toBe(CAP);
    expect(r.bytes.length).toBe(CAP);
    expect(r.truncated).toBe(true);
    // And the caller still learns the real size, so a size label stays honest.
    expect(r.onDiskSize).toBe(4 * 1024 * 1024);
  });

  test('reports mtime, so a caller does not have to re-stat the path', () => {
    // Re-statting by PATH after the read is the TOCTOU this module exists to
    // avoid; carrying mtimeMs off the same descriptor is what lets
    // `artifact_content` drop its own fstat.
    const p = write('stamped.txt', 'x');
    const expected = fs.statSync(p).mtimeMs;
    const r = readFilePrefixBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mtimeMs).toBe(expected);
  });

  test('refuses a directory rather than reading one', () => {
    const r = readFilePrefixBounded(tmp, 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['not_a_file', 'unreadable']).toContain(r.refusal);
  });

  test('refuses a path that does not exist', () => {
    const r = readFilePrefixBounded(path.join(tmp, 'nope.txt'), 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('unreadable');
  });

  posixOnly(
    'refuses a FIFO WITHOUT hanging — a prefix read is not an excuse to block',
    () => {
      const fifo = path.join(tmp, 'prefix-pipe');
      execFileSync('mkfifo', [fifo]);
      const started = Date.now();
      const r = readFilePrefixBounded(fifo, 1024);
      const elapsed = Date.now() - started;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe('not_a_file');
      expect(elapsed).toBeLessThan(2000);
    },
    10_000,
  );

  posixOnly(
    'refuses a character device instead of reading its first cap bytes',
    () => {
      // /dev/zero is the case where "just read a bounded prefix" would look
      // reasonable and still be wrong: it always succeeds, so a caller would
      // render an endless run of NULs as a file's content.
      const r = readFilePrefixBounded('/dev/zero', 1024);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal).toBe('not_a_file');
    },
    10_000,
  );

  test('does not leak descriptors across many prefix reads', () => {
    const good = write('prefix-good.txt', 'fine');
    const big = write('prefix-big.bin', Buffer.alloc(4096, 0x45));
    for (let i = 0; i < 200; i++) {
      readFilePrefixBounded(tmp, 1024);
      readFilePrefixBounded(path.join(tmp, 'nope'), 1024);
      readFilePrefixBounded(big, 1024);
      readFilePrefixBounded(good, 1024);
    }
    expect(readFilePrefixBounded(good, 1024).ok).toBe(true);
  });
});

describe('[security] readTextPrefixBounded', () => {
  test('decodes utf8 and carries the truncation facts through', () => {
    const p = write('utf8-prefix.txt', 'héllo — ok');
    const r = readTextPrefixBounded(p, 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('héllo — ok');
    expect(r.truncated).toBe(false);
    expect(r.onDiskSize).toBe(Buffer.byteLength('héllo — ok', 'utf8'));
  });

  test('a byte cap that lands mid-codepoint decodes rather than throwing', () => {
    // The cut is byte-wise on purpose (the cap's job is bounding the
    // allocation), so a split multi-byte character must degrade to U+FFFD and
    // not take the read down with it.
    const p = write('split.txt', '—'.repeat(10)); // 3 bytes each
    const r = readTextPrefixBounded(p, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('—')).toBe(true);
  });
});

/**
 * [security] Cebab-ws0.13 — resolve-before-destroy.
 *
 * The caller deletes whatever this returns, so a wrong `ok: true` is an
 * arbitrary `rm -rf`. The name gate does most of the work (a traversal cannot
 * be spelled), which is exactly why the containment arithmetic is ALSO tested
 * directly, below: routed through this function, every prefix-trap input is
 * rejected by the regex before the containment logic runs, so a test that only
 * went through here would prove nothing about it.
 */
describe('[security] resolveSessionFolderInside (ws0.13)', () => {
  const legacyName = (id: string): string => `.cebab-session-${id}`;

  test('resolves a real session folder to its realpath', () => {
    const name = legacyName('abc-123');
    fs.mkdirSync(path.join(tmp, name));
    const r = resolveSessionFolderInside(tmp, name);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // realpath, not the joined string — on macOS `/var` is a symlink to
    // `/private/var`, so these differ and the caller must act on the resolved
    // one.
    expect(r.path).toBe(fs.realpathSync(path.join(tmp, name)));
  });

  test.each([
    ['a traversal', '../../etc'],
    ['an absolute path', path.join(path.sep, 'etc')],
    ['the bare prefix with no id', '.cebab-session-'],
    ['an unrelated directory name', 'notasession'],
    ['a name with a separator inside it', `.cebab-session-a${path.sep}b`],
    ['a project directory that merely starts similarly', '.cebab-sessions-old'],
    ['the empty string', ''],
  ])('refuses %s as bad_name', (_label, name) => {
    fs.mkdirSync(path.join(tmp, 'decoy'), { recursive: true });
    const r = resolveSessionFolderInside(tmp, name);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('bad_name');
  });

  test('refuses a regular FILE with a session-folder name', () => {
    const name = legacyName('file');
    fs.writeFileSync(path.join(tmp, name), 'x');
    const r = resolveSessionFolderInside(tmp, name);
    expect(r).toEqual({ ok: false, refusal: 'bad_name' });
  });

  test('refuses a name that does not exist', () => {
    expect(resolveSessionFolderInside(tmp, legacyName('ghost'))).toEqual({
      ok: false,
      refusal: 'unresolvable',
    });
  });

  // Unprivileged symlink creation fails on Windows; the skip is named so it is
  // visible in the report rather than silently absent.
  posixOnly('refuses a SYMLINK shaped like a session folder, and its target survives', () => {
    const outside = path.join(tmp, 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');

    const link = path.join(tmp, 'root', legacyName('evil'));
    fs.mkdirSync(path.join(tmp, 'root'));
    fs.symlinkSync(outside, link, 'dir');

    const r = resolveSessionFolderInside(path.join(tmp, 'root'), legacyName('evil'));
    expect(r).toEqual({ ok: false, refusal: 'symlink' });

    // The point of the refusal: had it resolved, the caller would have deleted
    // the link's TARGET. `lstat` is the only gate that distinguishes this from
    // a real directory.
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  posixOnly('resolves through a symlinked ROOT rather than calling it an escape', () => {
    // The realpath-both-sides gate. A root that is itself a link is ordinary —
    // `/tmp` is one on macOS — and comparing a resolved child against an
    // unresolved root would reject every entry under it.
    const real = path.join(tmp, 'real-root');
    fs.mkdirSync(path.join(real, legacyName('ok')), { recursive: true });
    const linkedRoot = path.join(tmp, 'linked-root');
    fs.symlinkSync(real, linkedRoot, 'dir');

    expect(resolveSessionFolderInside(linkedRoot, legacyName('ok')).ok).toBe(true);
  });
});

/**
 * The containment arithmetic, driven directly.
 *
 * Every input here is unreachable through `resolveSessionFolderInside` — the
 * name gate rejects these spellings first. That is the point: a containment
 * test the regex already caught measures the regex, not the containment, which
 * is the vacuous-gate failure mode this repo keeps finding.
 *
 * Both platform flavours, because a developer on macOS would otherwise never
 * execute the win32 branch, and it is the branch with the case-folding in it.
 */
describe('[security] isDirectChildOf — the containment arithmetic (ws0.13)', () => {
  for (const [label, impl, root, name] of [
    ['posix', path.posix, '/home/u/agents', '.cebab-session-x'],
    ['win32', path.win32, 'C:\\Users\\u\\agents', '.cebab-session-x'],
  ] as const) {
    describe(label, () => {
      const child = impl.join(root, name);

      test('a direct child is accepted', () => {
        expect(isDirectChildOf(root, child, name, impl)).toBe(true);
      });

      test('a prefix-sharing sibling root is rejected', () => {
        // `<root>X/.cebab-session-x` starts with `<root>` as a string and is not
        // inside it. NOTE what actually catches this: the `rel === name`
        // comparison, not a dedicated escape check — a revert-check proved a
        // `startsWith` implementation still passes this case, which is why the
        // escape checks that used to sit here were removed rather than kept as
        // untestable depth.
        expect(isDirectChildOf(root, impl.join(`${root}X`, name), name, impl)).toBe(false);
      });

      test('a GRANDCHILD is rejected — direct children only', () => {
        expect(isDirectChildOf(root, impl.join(root, 'nested', name), name, impl)).toBe(false);
      });

      test('the root itself is rejected', () => {
        expect(isDirectChildOf(root, root, name, impl)).toBe(false);
      });

      test('a resolved path that escaped the root is rejected', () => {
        expect(isDirectChildOf(root, impl.join(root, '..', 'elsewhere', name), name, impl)).toBe(
          false,
        );
      });

      test('a child whose NAME differs from the one asked for is rejected', () => {
        // Guards the case where realpath resolved to a different entry than the
        // caller named.
        expect(isDirectChildOf(root, impl.join(root, '.cebab-session-other'), name, impl)).toBe(
          false,
        );
      });
    });
  }

  test('win32 folds case, posix does not', () => {
    // On Windows realpath restores the on-disk casing, so a differently-cased
    // name is still the same entry. On POSIX it is a different entry, and
    // folding there would accept a directory the caller did not name.
    const upper = '.CEBAB-SESSION-X';
    const lower = '.cebab-session-x';
    expect(isDirectChildOf('C:\\r', path.win32.join('C:\\r', upper), lower, path.win32)).toBe(true);
    expect(isDirectChildOf('/r', path.posix.join('/r', upper), lower, path.posix)).toBe(false);
  });

  test('a directory literally named `..foo` is a valid child, not an escape', () => {
    expect(isDirectChildOf('/r', '/r/..foo', '..foo', path.posix)).toBe(true);
  });

  /**
   * The guard that makes `rel === name` sufficient. Both of these compare EQUAL
   * to their `name` and are not what the caller meant, so without the
   * single-entry check the one comparison this function rests on would accept
   * them.
   */
  test.each([
    ['a name containing a separator would match a GRANDCHILD', 'a/b', '/r/a/b'],
    ['a backslash name, for the Windows spelling', 'a\\b', '/r/a\\b'],
    ['`..` would match the PARENT of the root', '..', '/'],
    ['`.` would match the root itself', '.', '/r'],
    ['the empty name', '', '/r'],
  ])('rejects %s', (_label, name, child) => {
    expect(isDirectChildOf('/r', child, name, path.posix)).toBe(false);
  });
});
