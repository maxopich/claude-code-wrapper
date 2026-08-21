/**
 * Cebab-ws0.10: read and write a MANAGED agent's own configuration files.
 *
 * Once an agent is Cebab-managed (`Cebab-ws0.9`), its config should be editable
 * in the app rather than by hand in a terminal. The reason that is safe to ship
 * is one boundary and not a set of precautions: every byte under
 * `managedAgentsRoot()` was put there by Cebab, so there is no operator repo to
 * clobber. `isManagedProjectPath` is the gate, and it answers from where the
 * path SITS rather than from a column — see its header for why that distinction
 * is load-bearing rather than stylistic.
 *
 * THE WIRE CARRIES A KIND, NEVER A PATH. `MANAGED_EDITABLE` is a closed set of
 * three, so there is no traversal to defend against: the operator cannot ask
 * for `../../.ssh/id_rsa` because there is no field in which to name it. That is
 * a stronger property than sanitising a path would be, and it is the reason
 * `relPathIsContained` below guards the CONSTANT rather than the request.
 *
 * READS ARE ALL-OR-NOTHING, deliberately. `readFileBounded`, never
 * `readFilePrefixBounded`. A prefix read is a display nicety in most places and
 * data loss here: the operator would edit the head of their file and saving
 * would silently truncate the tail. An over-cap file refuses to open, and the
 * editor says so.
 *
 * WRITES ARE AUDITED BEFORE THEY LAND, and more strictly than the neighbouring
 * `set_project_model`. Editing `.claude/settings.json` can add hooks, MCP
 * servers and env injections — a strictly larger authority change than the
 * starting permission mode `Cebab-ws0.4` already audits. The ordering contract
 * (append first, refuse the write if the append fails) follows
 * `project_start_mode.ts`, which exists as its own module precisely so a spy
 * can make the append throw and then check that nothing landed.
 *
 * NO SCHEMA VALIDATION, only a parse check. Whether `mcpServers` is well-formed
 * is the CLI's judgement; a second schema here is how Cebab starts refusing
 * configurations that actually work.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathLooksSensitive } from '@cebab/shared';
// The wire is the one home for both of these (`scripts/sharedIsOneHome.test.mjs`
// enforces it). A server-side copy would be a second definition of the closed
// set that decides which path this module writes to.
import type { ManagedFileKind, ManagedFileRefusal, ServerMsg } from '@cebab/shared/protocol';
import { isManagedProjectPath } from './managed_agent.js';
import { emit } from './notifications/dispatcher.js';
import { getProject } from './repo/projects.js';
import { readFileBounded, writeFileAtomicBounded } from './safe_fs.js';

/**
 * The closed set. Paths are POSIX-style and joined per-platform below.
 *
 * `.claude/settings.json` rather than `settings.local.json`: the local file is
 * the one a checkout is not supposed to share, and an agent Cebab owns has no
 * second author to hide anything from.
 */
export const MANAGED_EDITABLE: Readonly<Record<ManagedFileKind, string>> = {
  settings: '.claude/settings.json',
  mcp: '.mcp.json',
  claude_md: 'CLAUDE.md',
};

export const MANAGED_FILE_KINDS = Object.keys(MANAGED_EDITABLE) as ManagedFileKind[];

/**
 * Config files, not payloads. Generous enough for a large `CLAUDE.md` and small
 * enough that an over-cap file is a sign something is wrong rather than a
 * limitation the operator runs into.
 */
export const MAX_MANAGED_FILE_BYTES = 1_000_000;

/**
 * Does this relative path stay inside the project root?
 *
 * Every input it will ever see is a value of `MANAGED_EDITABLE`, so on today's
 * code it can only return true — which would make it exactly the unfalsifiable
 * security guard `safe_fs.ts`'s `isDirectChildOf` header argues against, if it
 * were reached only through `resolveManagedFile`. It is exported and tested
 * DIRECTLY instead, with `..` and absolute inputs, so it is a real check with
 * real cases; and a test asserts every entry of the constant passes it. What it
 * guards is therefore not a hostile request — there is no request — but the
 * edit that adds a fourth entry to the constant and gets it wrong.
 */
export function relPathIsContained(rel: string): boolean {
  if (rel === '') return false;
  if (path.isAbsolute(rel)) return false;
  // Normalise first so `a/../../b` is judged by where it lands, not by how it
  // is spelled. Compare against the joined result the caller will actually use.
  const joined = path.normalize(path.join('root', rel));
  const relFromRoot = path.relative('root', joined);
  if (relFromRoot === '') return false;
  return !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot);
}

export type ResolvedManagedFile = {
  absPath: string;
  relPath: string;
  projectPath: string;
  projectName: string;
};

export function resolveManagedFile(
  projectId: number,
  kind: string,
): { ok: true; file: ResolvedManagedFile } | { ok: false; refusal: ManagedFileRefusal } {
  const project = getProject(projectId);
  if (!project) return { ok: false, refusal: 'unknown_project' };
  // The gate. Note it is asked about the project's PATH, and answers for a
  // directory that no longer exists too — a managed agent the operator deleted
  // by hand is still managed, and refusing it later (on the read) is the honest
  // order: "this is yours to edit, and it is gone" beats "this is not yours".
  if (!isManagedProjectPath(project.path)) return { ok: false, refusal: 'not_managed' };

  const relPosix = (MANAGED_EDITABLE as Record<string, string | undefined>)[kind];
  if (relPosix === undefined) return { ok: false, refusal: 'unknown_kind' };
  const relPath = relPosix.split('/').join(path.sep);
  if (!relPathIsContained(relPath)) return { ok: false, refusal: 'unknown_kind' };

  return {
    ok: true,
    file: {
      absPath: path.join(project.path, relPath),
      relPath,
      projectPath: project.path,
      projectName: project.name,
    },
  };
}

export type ManagedFileRead = {
  relPath: string;
  /** Empty string when the file does not exist — the editor opens blank and a
   *  save creates it. */
  content: string;
  exists: boolean;
  /** Optimistic-concurrency token; `0` when the file does not exist. */
  mtimeMs: number;
  /** True for the kinds `pathLooksSensitive` names, so the editor can say the
   *  bytes on screen are live credentials rather than guessing from the name. */
  sensitive: boolean;
};

export function readManagedFile(
  projectId: number,
  kind: string,
): { ok: true; read: ManagedFileRead } | { ok: false; refusal: ManagedFileRefusal } {
  const resolved = resolveManagedFile(projectId, kind);
  if (!resolved.ok) return resolved;
  const { absPath, relPath } = resolved.file;
  const sensitive = pathLooksSensitive(relPath);

  const r = readFileBounded(absPath, MAX_MANAGED_FILE_BYTES);
  if (r.ok) {
    return {
      ok: true,
      read: {
        relPath,
        content: r.bytes.toString('utf8'),
        exists: true,
        mtimeMs: r.mtimeMs,
        sensitive,
      },
    };
  }
  // `unreadable` covers ENOENT, which is the ordinary "this agent has no
  // .mcp.json yet" case and must not read as a failure — the editor opens empty
  // and saving brings the file into existence. Every other refusal is real.
  if (r.refusal === 'unreadable' && !fs.existsSync(absPath)) {
    return { ok: true, read: { relPath, content: '', exists: false, mtimeMs: 0, sensitive } };
  }
  return { ok: false, refusal: r.refusal === 'too_large' ? 'too_large' : 'unreadable' };
}

export type ManagedFileWriteResult =
  | { ok: true; mtimeMs: number; created: boolean }
  | { ok: false; refusal: ManagedFileRefusal; detail?: string };

/**
 * Validate, audit, write — in that order.
 *
 * `baseMtimeMs` is the token from the read the operator started editing from.
 * A file whose mtime has moved since is refused rather than overwritten. The
 * resolution is the filesystem's, so two writes inside the same millisecond
 * compare equal; that is acceptable for a human editor and would not be for a
 * high-rate loop, which this is not.
 */
export function writeManagedFile(
  projectId: number,
  kind: string,
  content: string,
  baseMtimeMs: number,
  send: (msg: ServerMsg) => void,
): ManagedFileWriteResult {
  const resolved = resolveManagedFile(projectId, kind);
  if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
  const { absPath, relPath, projectPath, projectName } = resolved.file;

  // Parse-check BEFORE anything is audited or written, so a typo costs nothing
  // and leaves no record of an authority change that did not happen.
  if (relPath.endsWith('.json') && content.trim() !== '') {
    try {
      JSON.parse(content);
    } catch (e) {
      return { ok: false, refusal: 'invalid_json', detail: (e as Error).message };
    }
  }

  let existed = false;
  let currentMtime = 0;
  try {
    const st = fs.statSync(absPath);
    existed = st.isFile();
    currentMtime = st.mtimeMs;
  } catch {
    /* absent — creating */
  }
  if (currentMtime !== baseMtimeMs) return { ok: false, refusal: 'stale' };

  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_MANAGED_FILE_BYTES) return { ok: false, refusal: 'too_large' };

  // [security] AUDITED, and the payload is metadata only. These are the files
  // `pathLooksSensitive` names — an audit log that quoted their contents is the
  // leak `Cebab-of0` closed, reopened from the other side. The hash is what
  // makes the row useful without the bytes: two rows with the same digest are
  // the same configuration.
  const audit = emit(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `project.managed_file_edited:${projectId}:${kind}`,
      title: existed
        ? `Managed agent config edited: ${relPath}`
        : `Managed agent config created: ${relPath}`,
      message: `${projectName} (${projectPath})`,
      projectId,
      reasonCode: 'managed_file_edited',
      auditKind: 'project.managed_file_edited',
      auditPayload: {
        projectId,
        path: projectPath,
        relPath,
        existed,
        bytes: bytes.byteLength,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
      sticky: false,
    },
    send,
  );
  if (!audit.ok) return { ok: false, refusal: 'audit_failed', detail: audit.error };

  // `.claude/` may not exist on an agent copied from a project that had none.
  // Inside the managed root, so this creates nothing outside Cebab's own space.
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
  } catch {
    return { ok: false, refusal: 'write_failed' };
  }

  // `0600` for the credential-bearing kinds, matching what `Cebab-ws0.11` gave
  // them at copy time — an edit must not relax the mode the copy tightened.
  const mode = pathLooksSensitive(relPath) ? 0o600 : 0o644;
  const w = writeFileAtomicBounded(absPath, bytes, { maxBytes: MAX_MANAGED_FILE_BYTES, mode });
  if (!w.ok)
    return { ok: false, refusal: w.refusal === 'too_large' ? 'too_large' : 'write_failed' };

  return { ok: true, mtimeMs: w.mtimeMs, created: !existed };
}
