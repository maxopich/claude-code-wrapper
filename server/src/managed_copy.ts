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

import type { ManagedCopySkip, ManagedCopySkipReason, ServerMsg } from '@cebab/shared/protocol';
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

/**
 * [security] Cebab-6z6a — skip reasons that mean content the source HAD did not
 * arrive in the copy, as opposed to a deliberate policy skip or a file that
 * DID arrive.
 *
 * `copy_failed` (an ENOENT/EACCES/ENOSPC/mkdir error on one entry) and
 * `unreadable_dir` (a directory whose contents `readdir` refused) both leave
 * the snapshot missing bytes the operator believes are there. The others do
 * not, and are deliberately absent:
 *
 * - `permissions_unenforced` — the file was copied; only its mode is loose.
 * - `excluded_vcs` / `symlink_escapes` / `not_regular` — chosen omissions the
 *   preflight already named; refusing on them would make many ordinary copies
 *   (any git repo has a `.git`) impossible.
 * - `symlink_unsupported` — an intra-tree link that could not be recreated on
 *   Windows; its target is a real file copied elsewhere in the tree, so the
 *   content is present even though the link is not.
 */
const MISSING_REASONS: ReadonlySet<ManagedCopySkipReason> = new Set([
  'copy_failed',
  'unreadable_dir',
]);

/**
 * The files whose ABSENCE leaves a managed agent mis-configured, as opposed to
 * merely incomplete. Losing one of these refuses the copy and REMOVES the tree,
 * so the set has to be narrow enough to justify a destructive act.
 *
 * DELIBERATELY NOT `pathLooksSensitive` (`Cebab-6z6a`). That predicate is the
 * redactor's, and its header states the rule it is built on: a false negative
 * leaks a credential, so it errs wide on purpose — matching any basename whose
 * stem is `token`, `secret`, `credentials`, `key` or `pem`, and any path under a
 * credential-looking directory. Measured against it: `src/token.ts`,
 * `lib/secret.js`, `ui/Secret.tsx`, `docs/token.md`, `design/Deck.key`,
 * `test/fixtures/server.pem` and `node_modules/marked/lib/token.js` all match.
 * Erring wide is right for redaction and wrong here, where the consequence runs
 * the other way: one transient `copy_failed` on any ordinary source file with an
 * unlucky name would delete a finished multi-gigabyte copy — re-opening the
 * exact class `Cebab-ygu.14` closed, and `node_modules` (deliberately copied) is
 * where that churn actually happens.
 *
 * So this is an explicit list of the agent's own configuration, matched at the
 * project ROOT only, and never under `node_modules`. Widening it is a decision,
 * not a refactor.
 */
const CONFIG_CRITICAL_FILES: ReadonlySet<string> = new Set([
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

function configCriticalPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  // A vendored fixture is not this project's configuration, and it is where the
  // mid-copy churn lives.
  if (norm === 'node_modules' || norm.startsWith('node_modules/')) return false;
  if (CONFIG_CRITICAL_FILES.has(norm)) return true;
  // `.env`, `.env.local`, `.env.production` … at the root, where the CLI reads
  // them. A nested `.env` belongs to something the agent is not configured by.
  if (norm === '.env' || norm.startsWith('.env.')) return true;
  // A private key the project's own tooling would present. Root `.ssh/` only.
  if (norm.startsWith('.ssh/')) return true;
  return false;
}

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

export type ManagedCopyResult = { registered: boolean };

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
): Promise<ManagedCopyResult> {
  const fail = (error: string): ManagedCopyResult => {
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
    copied = await copyTree(
      project.path,
      target,
      (p) => {
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
      },
      // The survey above enforced these caps before the copy; passing them here
      // makes `copyTree` re-enforce them from within, so a tree that grew
      // between the survey and the copy — or a self-recursive walk — cannot
      // outrun the bound. `copyTree` also refuses a target outside the managed
      // root and a source that contains its target.
      caps,
    );
  } catch (err: unknown) {
    // A half-copied tree that no project row points at is garbage in the data
    // dir, and it is UNREACHABLE garbage: `runManagedDelete` has existed since
    // `Cebab-m1f`, but it starts from a project row, so a rowless tree is
    // exactly what no delete verb can reach. (`Cebab-6fax.43`: this used to
    // say "nothing in Cebab can delete a managed agent yet", which stopped
    // being true when that verb shipped.) Take it back.
    await removeManagedDir(target).catch(() => {});
    return fail(`the copy failed partway and was removed: ${String(err)}`);
  }

  // [security] Cebab-6z6a. `copyTree` tolerates a per-entry failure and returns
  // a `skips` list rather than throwing — the fix `Cebab-ygu.14`/`.13` made so
  // one churning cache file could not discard a multi-gigabyte copy. The cost
  // is that a copy which lost real content now looks successful: registering it
  // hands the operator a managed agent that "looks configured and is not". Two
  // cases make the snapshot unsafe to run, and both refuse-and-remove here,
  // exactly as the partial-throw and unregisterable paths above do.
  const missing = copied.skips.filter((s) => MISSING_REASONS.has(s.reason));

  // A credential or settings file that did not arrive — one of the files whose
  // absence makes an agent silently mis-configured rather than merely
  // incomplete.
  const sensitiveMissing = missing.filter((s) => configCriticalPath(s.rel));
  if (sensitiveMissing.length > 0) {
    await removeManagedDir(target).catch(() => {});
    const named = sensitiveMissing
      .slice(0, 3)
      .map((s) => s.rel)
      .join(', ');
    const more = sensitiveMissing.length > 3 ? `, and ${sensitiveMissing.length - 3} more` : '';
    return fail(
      `${project.name}: files that carry credentials or settings could not be copied ` +
        `(${named}${more}), so the copy would be missing configuration it needs to run. ` +
        `Nothing was registered.`,
    );
  }

  // A SYSTEMIC failure — an ENOSPC or EACCES on the target, not one transient
  // per-file error. The tell is that the source had files but essentially none
  // arrived, or the failures outnumber what was written. `survey.files` is the
  // regular-file count the same traversal measured moments ago.
  const systemic = (survey.files > 0 && copied.files === 0) || missing.length > copied.files;
  if (systemic) {
    await removeManagedDir(target).catch(() => {});
    const attempted = missing.length + copied.files;
    return fail(
      `${project.name}: the copy failed for most of the tree ` +
        `(${missing.length.toLocaleString('en')} of ${attempted.toLocaleString('en')} entries ` +
        `could not be written) — likely no space or no permission on the target. ` +
        `Nothing was registered.`,
    );
  }

  let row;
  try {
    row = registerManagedProject(project.name, target, project.path, Date.now());
  } catch (err: unknown) {
    // The tree is on disk but the project row could not be created — the name
    // disambiguation loop can exhaust, a schema error can bite. Same reasoning
    // as the two failure points above: a managed tree with no row pointing at
    // it holds `.claude/credentials.json` in the clear and NO delete verb will
    // touch a rowless directory, so it is unreachable garbage. Take it back.
    await removeManagedDir(target).catch(() => {});
    return fail(`the copy could not be registered and was removed: ${String(err)}`);
  }
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
