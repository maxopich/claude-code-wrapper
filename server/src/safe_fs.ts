/**
 * Bounded, TOCTOU-safe reads of paths Cebab does not control.
 *
 * WHY THIS EXISTS (register H02 + H03). Cebab reads several files that a
 * *project* supplies: its `.claude/settings*.json`, absolute paths named
 * inside that file (MCP server commands, hook targets), its root `CLAUDE.md`,
 * and any file a bus agent recorded touching. A bare `fs.readFileSync(path)`
 * on any of those is three separate hazards on a single-threaded server:
 *
 *   1. BLOCKING. A FIFO planted at the path parks the event loop until some
 *      writer shows up. Not the request — the whole server.
 *   2. UNBOUNDED. A multi-gigabyte file is read wholly into memory.
 *   3. TOCTOU. A path-based stat-then-read re-resolves the path twice, so a
 *      project can swap a regular file for a symlink to a secret in between
 *      (CodeQL `js/file-system-race`).
 *
 * The fix for all three is one shape: open ONCE with `O_NONBLOCK`, `fstat`
 * that descriptor rather than the path, reject anything that isn't a regular
 * file, and read at most `maxBytes`. The check and the use then act on one
 * inode instead of a name that can be re-pointed.
 *
 * WHY EVERY CALLER IS NOW HERE (register H11 + `Cebab-x1n.6.21`). When this
 * module landed in #277 it was the fifth writing of that shape and took over
 * only the two call sites that had no protection at all. Its header then said
 * the other four were "deliberately left alone (they work)". Three of them did
 * not:
 *
 *   - `bus/runtime.ts` (twice) read the WHOLE file and applied their character
 *     cap to the string afterwards — hazard 2, on the first turn of every bus
 *     participant.
 *   - `repo/hook_trust.ts` opened without `O_NONBLOCK` and read without a cap
 *     — hazards 1 and 2 both, on a path named in a project's settings file.
 *   - `repo/artifact_content.ts` was the one that genuinely implemented it.
 *
 * That is the argument against keeping a security-critical shape in five
 * places: not that five copies are untidy, but that four of them were vouched
 * for by a comment nobody could check. `bounded_reads.test.ts` now checks it —
 * every `openSync` / `readFileSync` / `createReadStream` under `server/src`
 * must be in this file or on an allowlist that names the Cebab-owned path it
 * reads.
 *
 * Never throws. A project-supplied file must not be able to crash a turn, so
 * every failure — missing, unreadable, wrong type, too big, short read —
 * comes back as a typed refusal the caller can map onto its own "no data"
 * path.
 */
import fs from 'node:fs';

/** Why a read was refused. `ok` reads carry the bytes instead. */
export type SafeReadRefusal =
  /** ENOENT / EACCES / ELOOP, or (on Windows) opening a directory. */
  | 'unreadable'
  /** Directory, FIFO, socket, character/block device — anything not a file. */
  | 'not_a_file'
  /** Regular file, but larger than the caller's cap. Whole-file reads only. */
  | 'too_large'
  /** fstat or read failed after a successful open. */
  | 'read_failed';

export type SafeReadResult =
  | { ok: true; bytes: Buffer; size: number; mtimeMs: number }
  | { ok: false; refusal: SafeReadRefusal };

/**
 * A prefix read never refuses for size — exceeding the cap is the expected
 * case and comes back as `truncated: true`, so `too_large` is unreachable.
 */
export type SafePrefixRefusal = Exclude<SafeReadRefusal, 'too_large'>;

export type SafePrefixResult =
  | {
      ok: true;
      bytes: Buffer;
      /** Bytes actually read (post-cap), NOT the on-disk size. */
      size: number;
      /** On-disk size at fstat time — the honest number for a size label. */
      onDiskSize: number;
      mtimeMs: number;
      /** True when the file was larger than the cap and `bytes` is its head. */
      truncated: boolean;
    }
  | { ok: false; refusal: SafePrefixRefusal };

/**
 * Read a whole file, or refuse.
 *
 * Deliberately all-or-nothing: there is no "truncated" success. Callers here
 * hash the bytes or parse them as JSON, and a silent prefix would be worse
 * than no answer in both cases — a prefix hash collides across different
 * binaries, and a prefix of JSON is a parse error that reads like corruption.
 * A caller that genuinely wants a prefix says so with `readFilePrefixBounded`.
 */
export function readFileBounded(filePath: string, maxBytes: number): SafeReadResult {
  const r = readCore(filePath, maxBytes, false);
  if (!r.ok) return r;
  return { ok: true, bytes: r.bytes, size: r.size, mtimeMs: r.mtimeMs };
}

/**
 * Read at most `maxBytes` from the head of a file, reporting whether there was
 * more.
 *
 * The counterpart to `readFileBounded` for callers that legitimately truncate:
 * a preview shows a file's first megabyte, a briefing injects a file's first
 * few thousand characters. Both want the bytes AND the fact that they are a
 * head, so `truncated` and `onDiskSize` come back alongside — a caller that
 * reported the READ size as the file's size would understate every truncated
 * file it showed.
 */
export function readFilePrefixBounded(filePath: string, maxBytes: number): SafePrefixResult {
  const r = readCore(filePath, maxBytes, true);
  if (!r.ok) {
    // `too_large` is unreachable with `allowPrefix`, but narrow rather than
    // assert: a future edit to `readCore` should fail to compile, not lie.
    return r.refusal === 'too_large'
      ? { ok: false, refusal: 'read_failed' }
      : { ok: false, refusal: r.refusal };
  }
  return {
    ok: true,
    bytes: r.bytes,
    size: r.size,
    onDiskSize: r.onDiskSize,
    mtimeMs: r.mtimeMs,
    truncated: r.truncated,
  };
}

/**
 * `readFileBounded` decoded as UTF-8, for callers that want text.
 *
 * Invalid byte sequences become U+FFFD rather than throwing — a project's file
 * must not be able to crash a turn by being malformed.
 */
export function readTextBounded(
  filePath: string,
  maxBytes: number,
): { ok: true; text: string } | { ok: false; refusal: SafeReadRefusal } {
  const r = readFileBounded(filePath, maxBytes);
  if (!r.ok) return r;
  return { ok: true, text: r.bytes.toString('utf8') };
}

/**
 * `readFilePrefixBounded` decoded as UTF-8.
 *
 * NOTE: the cap is in BYTES and the cut is not codepoint-aware, so a truncated
 * multi-byte character at the boundary decodes to U+FFFD. Callers that care
 * apply their own codepoint-level cap to the result (`bus/runtime.ts` does);
 * the byte cap's job is bounding the allocation, not framing the text.
 */
export function readTextPrefixBounded(
  filePath: string,
  maxBytes: number,
):
  | { ok: true; text: string; onDiskSize: number; truncated: boolean }
  | { ok: false; refusal: SafePrefixRefusal } {
  const r = readFilePrefixBounded(filePath, maxBytes);
  if (!r.ok) return r;
  return {
    ok: true,
    text: r.bytes.toString('utf8'),
    onDiskSize: r.onDiskSize,
    truncated: r.truncated,
  };
}

/**
 * The one implementation of the shape. `allowPrefix` decides whether a file
 * over the cap is a refusal or a head read; everything else — the single open,
 * the descriptor fstat, the type check, the short-read loop, the close — is
 * identical and must stay that way.
 */
function readCore(
  filePath: string,
  maxBytes: number,
  allowPrefix: boolean,
):
  | {
      ok: true;
      bytes: Buffer;
      size: number;
      onDiskSize: number;
      mtimeMs: number;
      truncated: boolean;
    }
  | { ok: false; refusal: SafeReadRefusal } {
  let fd: number;
  try {
    // O_NONBLOCK is the anti-hang bit: opening a FIFO with no writer returns
    // immediately instead of parking the event loop. It is a no-op for
    // regular files, and `?? 0` covers platforms where the constant is
    // absent (Windows), where the FIFO case does not arise the same way.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, refusal: 'unreadable' };
  }

  try {
    // fstat the DESCRIPTOR, never the path: whatever we opened is what we
    // measure and what we read. Re-resolving the name would reopen the
    // swap window this exists to close.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, refusal: 'not_a_file' };

    const onDiskSize = st.size;
    const overCap = onDiskSize > maxBytes;
    if (overCap && !allowPrefix) return { ok: false, refusal: 'too_large' };
    const toRead = overCap ? maxBytes : onDiskSize;

    const buf = Buffer.alloc(toRead);
    let read = 0;
    while (read < toRead) {
      // A single readSync may return fewer bytes than asked for; loop.
      const n = fs.readSync(fd, buf, read, toRead - read, read);
      // 0 means EOF — the file shrank between fstat and read. Return what we
      // actually got rather than a buffer padded with zeros, which would
      // hash to something that never existed on disk.
      if (n === 0) break;
      read += n;
    }
    return {
      ok: true,
      bytes: buf.subarray(0, read),
      size: read,
      onDiskSize,
      mtimeMs: st.mtimeMs,
      truncated: overCap,
    };
  } catch {
    return { ok: false, refusal: 'read_failed' };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already gone — nothing to release */
    }
  }
}
