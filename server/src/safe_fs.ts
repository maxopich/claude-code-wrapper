/**
 * Bounded, TOCTOU-safe reads of paths Cebab does not control.
 *
 * WHY THIS EXISTS (register H02 + H03). Cebab reads several files that a
 * *project* supplies: its `.claude/settings*.json`, and absolute paths named
 * inside that file (MCP server commands, hook targets). A bare
 * `fs.readFileSync(path)` on any of those is three separate hazards on a
 * single-threaded server:
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
 * That shape is already hand-rolled in four places — `bus/runtime.ts`
 * (twice), `repo/artifact_content.ts`, `repo/hook_trust.ts` — each with its
 * own reasoning comment. This module is the fifth writing of it and the first
 * shared one; the existing four are deliberately left alone for now (they
 * work, they're security-critical, and they differ in real ways). Folding
 * them onto this is tracked separately.
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
  /** Regular file, but larger than the caller's cap. */
  | 'too_large'
  /** fstat or read failed after a successful open. */
  | 'read_failed';

export type SafeReadResult =
  { ok: true; bytes: Buffer; size: number } | { ok: false; refusal: SafeReadRefusal };

/**
 * Read a whole file, or refuse.
 *
 * Deliberately all-or-nothing: there is no "truncated" success. Callers here
 * hash the bytes or parse them as JSON, and a silent prefix would be worse
 * than no answer in both cases — a prefix hash collides across different
 * binaries, and a prefix of JSON is a parse error that reads like corruption.
 * A caller that genuinely wants a prefix should say so with its own reader
 * (`artifact_content.ts` does, because a preview legitimately truncates).
 */
export function readFileBounded(filePath: string, maxBytes: number): SafeReadResult {
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
    if (st.size > maxBytes) return { ok: false, refusal: 'too_large' };

    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      // A single readSync may return fewer bytes than asked for; loop.
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      // 0 means EOF — the file shrank between fstat and read. Return what we
      // actually got rather than a buffer padded with zeros, which would
      // hash to something that never existed on disk.
      if (n === 0) break;
      read += n;
    }
    return { ok: true, bytes: buf.subarray(0, read), size: read };
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

/**
 * `readFileBounded` decoded as UTF-8, for callers that want text.
 *
 * Invalid byte sequences become U+FFFD rather than throwing — same posture as
 * `bus/runtime.ts`'s CLAUDE.md reader.
 */
export function readTextBounded(
  filePath: string,
  maxBytes: number,
): { ok: true; text: string } | { ok: false; refusal: SafeReadRefusal } {
  const r = readFileBounded(filePath, maxBytes);
  if (!r.ok) return r;
  return { ok: true, text: r.bytes.toString('utf8') };
}
