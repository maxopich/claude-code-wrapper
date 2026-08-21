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
 *
 * WHY A DESTROY CHECK ALSO LIVES HERE (Cebab-ws0.13). `resolveSessionFolderInside`
 * at the bottom is not a read. It is here because it is the same discipline
 * seen from the other side: the check and the use must land on ONE resolution,
 * not on a name that can be re-pointed in between. Reads solve that by holding
 * a descriptor; a delete cannot, so it resolves once and hands the caller the
 * resolved path to act on. Putting it in a module of its own would re-open
 * exactly the mistake the paragraph above narrates — a security-critical path
 * shape written somewhere else, vouched for by a comment nobody re-checks.
 *
 * Note the asymmetry in what guards them: `bounded_reads.test.ts` polices every
 * `openSync`/`readFileSync`/`createReadStream` under `server/src`, but nothing
 * polices `rm`/`rmSync`. That gap is filed (Cebab-pop) rather than bolted onto
 * the reads gate, whose value is narrating one hazard well.
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** Why a containment check refused. There is no partial success. */
export type ContainRefusal =
  /** Not the literal `.cebab-session-<safe-id>` shape, or not a directory. */
  | 'bad_name'
  /** The entry is a symlink. We never follow one into a delete. */
  | 'symlink'
  /** The entry or the root vanished, or could not be resolved. */
  | 'unresolvable'
  /** Resolved outside the root. */
  | 'outside_root';

export type ContainResult = { ok: true; path: string } | { ok: false; refusal: ContainRefusal };

/**
 * The one directory-name shape this helper will resolve.
 *
 * The id alphabet matches `session_log_export.ts`'s `SAFE_SID_RE` and exists
 * for the same reason: `..`, `/`, `\`, a drive letter and NUL are all outside
 * it, so a traversal cannot be SPELLED, let alone resolved.
 */
const SESSION_FOLDER_NAME_RE = /^\.cebab-session-[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolve `name` inside `root` for a caller that is about to DELETE the result.
 *
 * Takes a bare entry NAME, never a path — the server re-derives the root from
 * its own configuration, so no operator-supplied path reaches the filesystem.
 * That single decision removes most of what this function would otherwise have
 * to defend against; the four gates below are what remains.
 *
 *   1. NAME SHAPE. See `SESSION_FOLDER_NAME_RE`. This is what makes gates 3-4
 *      a second line of defence rather than the only one.
 *   2. LSTAT, NOT STAT. A symlink named `.cebab-session-x` pointing at `~` is
 *      shaped like a session folder and `stat`s like a directory — `lstat` is
 *      the only call that tells them apart. Cebab never created one, so there
 *      is no legitimate case being refused here.
 *   3. REALPATH BOTH SIDES. The root can itself be a symlink (`/tmp` is, on
 *      macOS). Comparing a resolved child against an unresolved root compares
 *      two different namespaces, which means nothing.
 *   4. `path.relative`, NOT `startsWith`. `<root>X/.cebab-session-y` shares a
 *      string prefix with `<root>` and is not inside it. `relative` also
 *      normalises separators and Windows drive-letter casing. The escape test
 *      names `path.sep` explicitly, because a bare `startsWith('..')` would
 *      also reject a legitimately named `..foo`.
 *
 * Never throws, like everything else in this module.
 */
export function resolveSessionFolderInside(root: string, name: string): ContainResult {
  if (typeof name !== 'string' || !SESSION_FOLDER_NAME_RE.test(name)) {
    return { ok: false, refusal: 'bad_name' };
  }
  const candidate = path.join(root, name);

  let st: fs.Stats;
  try {
    st = fs.lstatSync(candidate);
  } catch {
    return { ok: false, refusal: 'unresolvable' };
  }
  if (st.isSymbolicLink()) return { ok: false, refusal: 'symlink' };
  if (!st.isDirectory()) return { ok: false, refusal: 'bad_name' };

  let realRoot: string;
  let realChild: string;
  try {
    realRoot = fs.realpathSync(root);
    realChild = fs.realpathSync(candidate);
  } catch {
    return { ok: false, refusal: 'unresolvable' };
  }

  if (!isDirectChildOf(realRoot, realChild, name)) {
    return { ok: false, refusal: 'outside_root' };
  }
  return { ok: true, path: realChild };
}

/**
 * Is `child` the entry `name`, directly inside `parent`? Both paths must
 * already be resolved.
 *
 * ONE COMPARISON DOES ALL THE WORK, and that is deliberate. This was first
 * written the defence-in-depth way — reject `rel === ''`, reject `..`, reject
 * `..<sep>`, reject an absolute `rel`, THEN compare against the name. A
 * revert-check killed it: replacing `path.relative` with the `startsWith` this
 * repo keeps warning about reddened NOTHING, because the final comparison
 * already caught every input the earlier guards claimed to. Guards that no
 * input can distinguish are not depth, they are unfalsifiable code sitting in a
 * security path — and their presence had made a test look like it was covering
 * the prefix trap when the name check was doing the catching.
 *
 * Why `rel === name` is sufficient on its own: if the relative path from
 * `parent` to `child` is exactly a single entry name, then `child` IS
 * `parent`/`name` renormalised. An escape produces a `..` segment, a different
 * drive produces an absolute `rel`, and the parent itself produces `''` — none
 * of which can equal a single entry name.
 *
 * That sufficiency is what makes the guard below load-bearing rather than
 * decorative: it holds only while `name` really is a single entry. With
 * `name = 'a/b'` a grandchild would compare equal, and with `name = '..'` the
 * parent's parent would. Both are rejected here, and both have tests.
 *
 * Case-folded under win32 semantics, where realpath restores the on-disk casing
 * so a differently-cased spelling is still the same entry. The condition tests
 * the IMPLEMENTATION rather than `process.platform`: on Windows
 * `path === path.win32`, so the default argument folds there, and a test on any
 * host reaches the branch by passing `path.win32`. Keying off the platform
 * would put this branch beyond the reach of the only tests that can cover it.
 *
 * Exported for its own tests. Every input that exercises the comparison is
 * rejected by `resolveSessionFolderInside`'s name gate before it could get
 * here, so testing only through that function would measure the regex and call
 * it containment.
 */
export function isDirectChildOf(
  parent: string,
  child: string,
  name: string,
  impl: typeof path = path,
): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  const rel = impl.relative(parent, child);
  return impl === path.win32 ? rel.toLowerCase() === name.toLowerCase() : rel === name;
}

// ---- the write ----

/** Why a write was refused. There is no partial success: either the new bytes
 *  are wholly at the path or the previous contents are untouched. */
export type SafeWriteRefusal =
  /** Content larger than the caller's cap. Nothing was written. */
  | 'too_large'
  /** The containing directory is missing, unwritable, or not a directory. */
  | 'unwritable'
  /** The temp file was created but could not be moved into place. */
  | 'commit_failed';

export type SafeWriteResult =
  { ok: true; mtimeMs: number } | { ok: false; refusal: SafeWriteRefusal };

/**
 * Replace a file's contents, or refuse (`Cebab-ws0.10`).
 *
 * WHY THIS IS NOT `fs.writeFileSync` WITH A COMMENT. Everything above this line
 * exists because a path can be re-pointed between the check and the use, and
 * the reads answer that by holding one descriptor. A write cannot borrow that
 * answer — it has to put bytes at a NAME — so it answers the same hazard the
 * only other way there is: build the content somewhere else, then replace the
 * name in one step.
 *
 *   - A symlink planted at the target is DESTROYED by the rename rather than
 *     written through. `writeFileSync` would follow it and deposit the
 *     operator's config wherever it pointed; `O_NOFOLLOW` would merely refuse,
 *     leaving the planted link in place. This is the stronger of the two.
 *   - A reader never sees a half-written file, and a crash mid-write leaves the
 *     previous contents intact. `rename` is atomic within a filesystem, which
 *     is why the temp file is created in the TARGET'S OWN DIRECTORY and not in
 *     `os.tmpdir()` — a cross-device rename is not atomic and, on most hosts,
 *     is not even a rename.
 *
 * `mode` applies at creation, so the bytes are never briefly world-readable on
 * the way to being `0600` — the window a `writeFileSync`-then-`chmod` leaves
 * open, on exactly the credential-bearing files `pathLooksSensitive` names.
 *
 * Never throws, matching its neighbours: a caller handling a project's files
 * gets a typed refusal to map onto its own failure path.
 */
export function writeFileAtomicBounded(
  filePath: string,
  bytes: Buffer,
  opts: { maxBytes: number; mode: number },
): SafeWriteResult {
  if (bytes.byteLength > opts.maxBytes) return { ok: false, refusal: 'too_large' };

  const dir = path.dirname(filePath);
  // Dot-prefixed and suffixed so a temp left behind by a killed process is
  // recognisable and is not mistaken for a config file by anything that scans
  // the directory — `Cebab-ws0.6`'s scan reads `.mcp.json` by exact name, but a
  // future glob would otherwise pick these up.
  const tmp = path.join(dir, `.${path.basename(filePath)}.cebab-tmp-${process.pid}-${Date.now()}`);

  let fd: number | undefined;
  try {
    // `wx` — fail if it somehow exists, rather than truncating a file we did
    // not create. Combined with the pid+time suffix this cannot collide with a
    // concurrent write from this process.
    fd = fs.openSync(tmp, 'wx', opts.mode);
    fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
    // Durability before the rename: a rename that lands before the data is
    // flushed can survive a power loss pointing at an empty file.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed or never opened cleanly */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    return { ok: false, refusal: 'unwritable' };
  }

  try {
    // Replaces whatever is at the path — regular file, or a symlink pointing
    // somewhere it should not. Node maps this to `MoveFileEx(...,
    // MOVEFILE_REPLACE_EXISTING)` on Windows, so it overwrites there too rather
    // than failing on an existing destination.
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename may have half-succeeded; nothing more to do */
    }
    return { ok: false, refusal: 'commit_failed' };
  }

  // Read the committed mtime back rather than stamping `Date.now()`: it is
  // handed to the caller as an optimistic-concurrency token and has to be the
  // value a later `stat` will produce, at the filesystem's own resolution.
  try {
    return { ok: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch {
    // The bytes ARE committed; only the token is unavailable. Reporting a
    // failure here would tell the operator their save was lost when it was not.
    return { ok: true, mtimeMs: 0 };
  }
}
