/**
 * Cluster I Phase H3 (UI_Findings spec §4.4): read the CURRENT on-disk content
 * of the file a bus mutation touched, for the `ArtifactsView` "▸ View latest
 * content" disclosure. The companion to `repo/search.ts` (C4) — both are the
 * pure(ish), Conn-free, unit-testable core that a thin WS executor delegates
 * to.
 *
 * Two responsibilities:
 *   1. `redactArtifactContent` — apply the per-session-log redaction policy to
 *      a file body. No I/O; same input → same output.
 *   2. `readArtifactContent` — look the mutation up by id, resolve its file,
 *      read it TOCTOU-safely with a 1 MB cap, and redact. The only impure part;
 *      never throws (a disk error becomes an `error` field, not an exception).
 *
 * **Privacy posture (spec §3 + H3-3): redact-at-display.** We never persist a
 * redacted copy — we read the raw bytes from disk and mask on the way out.
 * There is NO raw/unredacted path for artifact previews (unlike C2 export and
 * C4 search): an artifact preview is always redacted, so there is no audit gate
 * here either.
 *
 * **Security (spec §4.4): TOCTOU-safe bounded read.** Mirrors
 * `bus/runtime.ts` `readProjectClaudeMd`: open the path EXACTLY ONCE
 * (`O_RDONLY | O_NONBLOCK`), `fstat` the open fd (not the re-resolved path) to
 * reject non-regular files, and read a BOUNDED number of bytes from that SAME
 * descriptor. This closes the stat-then-read race (CodeQL js/file-system-race —
 * a malicious project can't swap the file for a symlink-to-secret between the
 * check and the read), the FIFO DoS (a pipe planted as the path can't block the
 * event loop), and the OOM a blind `readFileSync(fd)` would risk on a huge file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSensitive, type ArtifactContentError } from '@cebab/shared';
import { getMultiAgentMutation } from './multi_agent.js';

/** 1 MB read cap (spec §4.4 / H3-4). Files larger than this preview their
 *  first megabyte; the reply's `truncated` flag tells the UI to say so. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** Cap on the number of `line:N` paths reported in `redactedFields`. A
 *  pathological all-secrets file would otherwise list thousands of lines; the
 *  UI only needs to know SOMETHING was masked to show the badge, so an exact
 *  list past this point isn't worth the payload. */
const MAX_REDACTED_FIELDS = 100;

/** Must match `redact.ts`'s mask token so a masked artifact line reads
 *  identically to the per-session log view. (Not exported from redact.ts;
 *  intentionally duplicated and kept in sync.) */
const REDACTED_TOKEN = '<redacted>';

export type ArtifactContentOutcome = {
  /** Redacted body (empty string on error). */
  content: string;
  /** File mtime, ms epoch (0 on error / unknown). */
  mtime: number;
  /** Bytes actually read, post-cap (NOT the on-disk size; 0 on error). */
  size: number;
  /** True when the on-disk file exceeded the cap and `content` is the head. */
  truncated: boolean;
  /** What the redactor masked (`['content']` whole-file, or `['line:N', …]`). */
  redactedFields: string[];
  /** Present iff the content could not be produced. */
  error?: ArtifactContentError;
};

/**
 * Redact a file body using the same policy the per-session log view applies.
 *
 * Two tiers, in order:
 *   1. **Whole-file** — if the file's OWN path is sensitive (`.env`,
 *      `credentials`, `id_rsa`, anything under `~/.aws|.ssh|.gnupg|.kube`,
 *      `.git/config`, …), every byte is a secret, so mask the entire body. We
 *      don't duplicate `redact.ts`'s path list — we PROBE it:
 *      `redactSensitive({ file_path, content })` masks the `content` sibling
 *      iff the path is sensitive (the same sibling-masking rule the log view
 *      relies on).
 *   2. **Per-line** — otherwise mask only the individual lines that carry an
 *      obvious inline credential (AWS key, `sk-…`, JWT, bearer / authorization
 *      header — `redactSensitive`'s value patterns). Masking line-by-line keeps
 *      an otherwise-readable file readable instead of blanking the whole body
 *      on a single match (which is what `redactSensitive` of the bare string
 *      would do — it masks the entire string value on any one pattern hit).
 *
 * Exported for direct unit testing.
 */
export function redactArtifactContent(
  filePath: string | null,
  content: string,
): { redacted: string; fields: string[] } {
  // Tier 1 — sensitive PATH ⇒ the whole body is a secret.
  if (filePath !== null && filePath.length > 0) {
    // `PROBE` is innocuous (never matches an inline value pattern), so the
    // only way the sibling comes back changed is the path-sensitivity rule.
    const PROBE = 'x';
    const probe = redactSensitive({ file_path: filePath, content: PROBE });
    const sibling = (probe.redacted as { content?: unknown }).content;
    if (sibling !== PROBE) {
      return { redacted: REDACTED_TOKEN, fields: ['content'] };
    }
  }

  // Tier 2 — per-line inline-secret mask.
  const lines = content.split('\n');
  const fields: string[] = [];
  let anyMasked = false;
  const out = lines.map((line, i) => {
    const { redacted } = redactSensitive(line);
    if (redacted !== line) {
      anyMasked = true;
      if (fields.length < MAX_REDACTED_FIELDS) fields.push(`line:${i + 1}`);
      return REDACTED_TOKEN;
    }
    return line;
  });
  // Preserve the exact bytes (CRLF, trailing newline) when nothing was masked.
  return anyMasked ? { redacted: out.join('\n'), fields } : { redacted: content, fields: [] };
}

/**
 * Resolve + read the current content of the file a mutation touched.
 *
 * We deliberately do NOT re-confine the resolved path to `cwd`: the
 * `multi_agent_mutations` row is Cebab's own record of a tool call it observed
 * (the agent can't forge rows), so `filePath` is exactly the file the operator
 * is asking to preview. Redaction — not path confinement — is the privacy
 * boundary here.
 */
export function readArtifactContent(mutationId: number): ArtifactContentOutcome {
  const fail = (error: ArtifactContentError): ArtifactContentOutcome => ({
    content: '',
    mtime: 0,
    size: 0,
    truncated: false,
    redactedFields: [],
    error,
  });

  const mutation = getMultiAgentMutation(mutationId);
  if (!mutation) return fail('mutation_not_found');

  const { filePath, cwd } = mutation;
  // No single target file: Bash / Agent / Task mutations, or a pre-012 row.
  if (filePath === null || filePath.length === 0) return fail('no_file_path');

  // Resolve against the agent's recorded cwd. An absolute `filePath` wins; a
  // relative one needs `cwd` (a pre-012 row without cwd can't be located).
  let abs: string;
  if (path.isAbsolute(filePath)) {
    abs = filePath;
  } else if (cwd !== null && cwd.length > 0) {
    abs = path.resolve(cwd, filePath);
  } else {
    return fail('no_file_path');
  }

  // ── TOCTOU-safe bounded read (mirrors bus/runtime.ts readProjectClaudeMd). ──
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return fail('read_failed'); // ENOENT / EACCES / ELOOP / (Windows) dir
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return fail('not_a_file'); // dir / device / fifo

    const onDisk = st.size;
    const truncated = onDisk > MAX_ARTIFACT_BYTES;
    const toRead = Math.min(onDisk, MAX_ARTIFACT_BYTES);

    const buf = Buffer.alloc(toRead);
    let read = 0;
    // A single readSync may return fewer bytes than requested; loop to fill.
    while (read < toRead) {
      let n: number;
      try {
        n = fs.readSync(fd, buf, read, toRead - read, read);
      } catch {
        return fail('read_failed');
      }
      if (n === 0) break; // EOF — the file shrank between fstat and read
      read += n;
    }

    const raw = buf.subarray(0, read).toString('utf8');
    const { redacted, fields } = redactArtifactContent(filePath, raw);
    return {
      content: redacted,
      mtime: Math.floor(st.mtimeMs),
      size: read,
      truncated,
      redactedFields: fields,
    };
  } catch {
    return fail('read_failed'); // fstat or other unexpected error
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already gone — nothing to release */
    }
  }
}
