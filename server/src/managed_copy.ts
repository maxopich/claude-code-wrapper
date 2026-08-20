/**
 * Cebab-ws0.9 — the preflight and the copy, as a module rather than two `case`
 * bodies.
 *
 * Same reason as `project_start_mode.ts`: the BE-1 contract (append the
 * hash-chained audit row BEFORE the consequential act, and refuse the act if
 * the append fails) is only a contract if something checks it, and a switch
 * case inside `handleClientMsg` is module-private and untestable. Here a spy
 * can make the append throw and then look at the filesystem.
 *
 * WHAT COUNTS AS THE CONSEQUENTIAL ACT. Not "a directory appeared" — that is an
 * empty 0700 dir with nothing in it. It is duplicating an agent's tree,
 * credentials included, into a second location; that is the fact `Cebab-ws0.11`
 * exists for. So the order is: claim the directory (which is what makes the
 * target NAMEABLE in the audit row), audit, then copy. A failed append removes
 * the empty directory and refuses, so nothing is left behind and nothing was
 * duplicated.
 */

import type { ManagedCopySkip, ServerMsg } from '@cebab/shared/protocol';
import { MANAGED_COPY_SKIP_LIMIT } from '@cebab/shared/protocol';
import { emit } from './notifications/dispatcher.js';
import {
  DEFAULT_CAPS,
  type Caps,
  claimManagedDir,
  copyTree,
  removeManagedDir,
  surveyTree,
} from './managed_agent.js';
import { getProject, registerManagedProject } from './repo/projects.js';

/** Progress messages are throttled to this, so a fast copy cannot flood the socket. */
const PROGRESS_INTERVAL_MS = 400;

/** Same cap, for the credential-file list — see `truncateSkips`. */
function truncatePaths(paths: string[]): { paths: string[]; truncated: number } {
  if (paths.length <= MANAGED_COPY_SKIP_LIMIT) return { paths, truncated: 0 };
  return {
    paths: paths.slice(0, MANAGED_COPY_SKIP_LIMIT),
    truncated: paths.length - MANAGED_COPY_SKIP_LIMIT,
  };
}

function truncateSkips(skips: ManagedCopySkip[]): {
  skips: ManagedCopySkip[];
  skipsTruncated: number;
} {
  // A tree with thousands of escaping symlinks must not turn one WebSocket
  // frame into megabytes. The count survives even when the list does not, so
  // the operator is never told "nothing was skipped" when plenty was.
  if (skips.length <= MANAGED_COPY_SKIP_LIMIT) return { skips, skipsTruncated: 0 };
  return {
    skips: skips.slice(0, MANAGED_COPY_SKIP_LIMIT),
    skipsTruncated: skips.length - MANAGED_COPY_SKIP_LIMIT,
  };
}

/** Measure what the copy would write. Writes nothing. */
export async function preflightManagedCopy(
  projectId: number,
  send: (msg: ServerMsg) => void,
  caps: Caps = DEFAULT_CAPS,
): Promise<void> {
  const project = getProject(projectId);
  if (!project) {
    send({ type: 'managed_copy_preflight', projectId, preflight: null });
    return;
  }
  const survey = await surveyTree(project.path, caps);
  const { skips, skipsTruncated } = truncateSkips(survey.skips);
  const credentials = truncatePaths(survey.credentialFiles);
  send({
    type: 'managed_copy_preflight',
    projectId,
    preflight: {
      projectId,
      bytes: survey.bytes,
      files: survey.files,
      dirs: survey.dirs,
      symlinks: survey.symlinks,
      largest: survey.largest,
      skips,
      skipsTruncated,
      credentialFiles: credentials.paths,
      credentialFilesTruncated: credentials.truncated,
      overCap: survey.overCap,
      maxBytes: caps.maxBytes,
      maxFiles: caps.maxFiles,
    },
  });
}

export type ManagedCopyOutcome = { registered: boolean };

/**
 * Copy a project into managed space and register the copy.
 *
 * Re-surveys rather than trusting a preflight the client might have gathered
 * minutes ago against a tree that has since grown — the cap has to hold at the
 * moment of the copy, not at the moment of the estimate.
 */
export async function runManagedCopy(
  projectId: number,
  send: (msg: ServerMsg) => void,
  /**
   * Overridable so the refusal above the cap can be exercised without building
   * a five-gigabyte fixture. Production never passes it — the WS layer calls
   * with two arguments, so the default is what ships.
   */
  caps: Caps = DEFAULT_CAPS,
): Promise<ManagedCopyOutcome> {
  const fail = (error: string): ManagedCopyOutcome => {
    send({ type: 'managed_copy_result', projectId, result: { ok: false, error } });
    return { registered: false };
  };

  const project = getProject(projectId);
  if (!project) return fail('that project no longer exists');

  const survey = await surveyTree(project.path, caps);
  if (survey.overCap) {
    return fail(
      `${project.name} is larger than Cebab will copy — over ${formatBytes(caps.maxBytes)} ` +
        `or ${caps.maxFiles.toLocaleString('en')} files. Nothing was written.`,
    );
  }

  let target: string;
  try {
    target = await claimManagedDir(project.name);
  } catch (err: unknown) {
    return fail(`could not create a directory for the copy: ${String(err)}`);
  }

  // [security] AUDIT BEFORE THE COPY. The directory above exists so this row
  // can name it; it is empty, and a failed append takes it away again.
  const audit = emit(
    {
      class: 'safety',
      severity: 'warn',
      dedupeKey: `project.managed_copy_started:${projectId}:${target}`,
      title: 'Copying an agent into Cebab-managed space',
      message: `${project.name} → ${target}`,
      projectId,
      reasonCode: 'managed_copy_started',
      auditKind: 'project.managed_copy_started',
      auditPayload: {
        projectId,
        sourcePath: project.path,
        targetPath: target,
        bytes: survey.bytes,
        files: survey.files,
      },
      sticky: false,
    },
    send,
  );
  if (!audit.ok) {
    await removeManagedDir(target).catch(() => {});
    return fail(`could not record the copy in the audit log (${audit.error}); nothing was copied.`);
  }

  let last = 0;
  let copied;
  try {
    copied = await copyTree(project.path, target, (p) => {
      const now = Date.now();
      if (now - last < PROGRESS_INTERVAL_MS) return;
      last = now;
      send({
        type: 'managed_copy_progress',
        projectId,
        files: p.files,
        bytes: p.bytes,
        totalFiles: survey.files,
        totalBytes: survey.bytes,
      });
    });
  } catch (err: unknown) {
    // A half-copied tree that no project row points at is garbage in the data
    // dir, and nothing in Cebab can delete a managed agent yet. Take it back.
    await removeManagedDir(target).catch(() => {});
    return fail(`the copy failed partway and was removed: ${String(err)}`);
  }

  const row = registerManagedProject(project.name, target, project.path, Date.now());
  const { skips, skipsTruncated } = truncateSkips(copied.skips);
  send({
    type: 'managed_copy_result',
    projectId,
    result: {
      ok: true,
      managedProjectId: row.id,
      name: row.name,
      files: copied.files,
      bytes: copied.bytes,
      symlinks: copied.symlinks,
      skips,
      skipsTruncated,
    },
  });
  return { registered: true };
}

function formatBytes(n: number): string {
  const gb = n / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}
