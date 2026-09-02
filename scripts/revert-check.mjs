#!/usr/bin/env node
/**
 * Does each test in this branch actually depend on the change it ships with?
 *
 * Run by hand against a branch or a merged commit:
 *
 *   node scripts/revert-check.mjs                    # HEAD vs origin/main
 *   node scripts/revert-check.mjs --base <ref>       # HEAD vs <ref>
 *   node scripts/revert-check.mjs --rev <sha>        # <sha> vs its first parent
 *
 * DELIBERATELY NOT WIRED INTO THE LOOP'S GATE YET. `Cebab-pc95` carries that
 * step; this is the same decision (`revert_check.mjs`, shared) behind a manual
 * entry point, so the mechanism can be verified against known answers before a
 * green from it is allowed to mean anything. `Cebab-dwcq` names three tests in
 * the run of 2026-09-01 that pass with their fix reverted and twenty
 * server-side reverts that correctly went red — that is a positive and negative
 * control with the answer already recorded, and it is what this has to
 * reproduce.
 *
 * HOW IT WORKS, and why not the obvious way. The obvious implementation is to
 * reverse-apply the non-test hunks in the working tree, run, and re-apply. That
 * puts the tree into a broken intermediate state, and a failed restore corrupts
 * whatever else is running. Instead: a scratch git worktree at the BASE commit,
 * with only the test-file hunks applied on top. The live tree is never touched,
 * and a teardown failure costs a directory.
 *
 * PLATFORM. The scratch worktree needs `node_modules`, which is supplied by
 * symlinking the main checkout's. On Windows that needs Developer Mode or an
 * elevated shell, so this reports the failure and skips rather than pretending;
 * the loop runs on the operator's machine, which is POSIX.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  addedTestTitles,
  classifyAddedCases,
  classifyRevertRun,
  sourceFilesInDiff,
  stepFromVerdict,
  testFilesInDiff,
} from './lib/loop/revert_check.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = ['server', 'web', 'shared'];

const git = (args, cwd = REPO_ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** `--base X` / `--rev X`, defaulting to the merge base with origin/main. */
export function parseArgs(argv) {
  const out = { base: null, rev: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i] ?? null;
    else if (argv[i] === '--rev') out.rev = argv[++i] ?? null;
  }
  return out;
}

/**
 * The two commits to compare: what the tests are run against, and what the
 * change is taken from.
 *
 * For `--rev <sha>` the pair is (sha^, sha) — which is what makes a MERGED
 * commit checkable, and merged commits are the only corpus with a known answer.
 */
function resolveRange({ base, rev }) {
  if (rev) return { baseRef: git(['rev-parse', `${rev}^`]).trim(), headRef: rev };
  const head = git(['rev-parse', 'HEAD']).trim();
  const b = base ?? git(['merge-base', 'HEAD', 'origin/main']).trim();
  return { baseRef: b, headRef: head };
}

/** Link the main checkout's dependency trees in, absolute paths throughout. */
function linkNodeModules(dir) {
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  for (const w of WORKSPACES) {
    const target = join(REPO_ROOT, w, 'node_modules');
    if (existsSync(target)) symlinkSync(target, join(dir, w, 'node_modules'));
  }
}

function runVitest(cwd, files, outputFile) {
  return new Promise((res) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = [
      'exec',
      '--no',
      '--',
      'vitest',
      'run',
      ...files,
      '--reporter=json',
      `--outputFile.json=${outputFile}`,
    ];
    const child = spawn(npm, args, {
      cwd,
      env: process.env,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => res(code ?? 1));
    child.on('error', () => res(1));
  });
}

/**
 * Run the changed tests against a tree without the change.
 *
 * Returns the classifier's verdict plus the file lists, so a caller can report
 * WHICH tests were checked — a verdict with no corpus attached is the shape
 * that hides an empty run.
 */
export async function revertCheck({ baseRef, headRef }) {
  const changed = git(['diff', '--name-only', `${baseRef}..${headRef}`])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tests = testFilesInDiff(changed);
  const source = sourceFilesInDiff(changed);

  if (tests.length === 0) {
    return {
      verdict: 'empty',
      executed: 0,
      reason: 'the diff changes no test file',
      tests,
      source,
    };
  }
  if (source.length === 0) {
    // Nothing to withhold: a test-only diff has no change for the tests to
    // depend on. Reported rather than silently passed.
    return {
      verdict: 'empty',
      executed: 0,
      reason: 'the diff changes only test files — there is no change to withhold',
      tests,
      source,
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), 'cebab-revert-'));
  const tree = join(scratch, 'tree');
  const outputFile = join(scratch, 'vitest.json');
  try {
    git(['worktree', 'add', '--detach', '--quiet', tree, baseRef]);
    try {
      linkNodeModules(tree);
    } catch (err) {
      return {
        verdict: 'inconclusive',
        executed: 0,
        reason: `could not link node_modules into the scratch worktree (${String(err)})`,
        tests,
        source,
      };
    }

    // Only the TEST hunks. The source stays at base, which is the whole point.
    const patch = git(['diff', `${baseRef}..${headRef}`, '--', ...tests]);
    if (patch.trim()) {
      const patchFile = join(scratch, 'tests.patch');
      writeFileSync(patchFile, patch);
      try {
        git(['apply', '--whitespace=nowarn', patchFile], tree);
      } catch (err) {
        return {
          verdict: 'inconclusive',
          executed: 0,
          reason: `the test-only patch did not apply to ${baseRef.slice(0, 8)} (${String(err)})`,
          tests,
          source,
        };
      }
    }

    await runVitest(tree, tests, outputFile);
    let summary = null;
    try {
      summary = JSON.parse(readFileSync(outputFile, 'utf8'));
    } catch {
      summary = null;
    }

    const fileLevel = classifyRevertRun(summary);
    // Per-CASE is the real verdict; the file-level one only decides whether the
    // run is interpretable at all. A file where some other test failed looks
    // sound at file granularity while the case that shipped with the fix still
    // passes — measured on a009f68, which is why this exists.
    if (fileLevel.verdict !== 'depends' && fileLevel.verdict !== 'vacuous') {
      return { ...fileLevel, tests, source, cases: null };
    }
    const added = addedTestTitles(patch);
    const cases = classifyAddedCases(summary, added);
    if (added.length === 0) {
      return {
        verdict: 'empty',
        executed: fileLevel.executed,
        reason: 'the patch adds no statically-titled test case to check',
        tests,
        source,
        cases,
      };
    }
    if (cases.vacuous.length > 0) {
      return {
        verdict: 'vacuous',
        executed: fileLevel.executed,
        reason:
          `${cases.vacuous.length} of ${added.length} added test case(s) PASS without the ` +
          `change: ${cases.vacuous.map((t) => JSON.stringify(t)).join(', ')}`,
        tests,
        source,
        cases,
      };
    }
    return {
      verdict: 'depends',
      executed: fileLevel.executed,
      reason:
        `all ${cases.depends.length} added test case(s) fail without the change` +
        (cases.unmatched.length > 0
          ? `; ${cases.unmatched.length} not statically matchable and NOT checked`
          : ''),
      tests,
      source,
      cases,
    };
  } finally {
    try {
      git(['worktree', 'remove', '--force', tree]);
    } catch {
      /* a leaked scratch directory is not worth failing over */
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { baseRef, headRef } = resolveRange(parseArgs(process.argv.slice(2)));
  console.log(`[revert-check] ${baseRef.slice(0, 8)} .. ${headRef.slice(0, 8)}`);
  const out = await revertCheck({ baseRef, headRef });
  const step = stepFromVerdict('revert-check', out);
  console.log(
    `[revert-check] ${out.tests.length} test file(s), ${out.source.length} source file(s)`,
  );
  for (const t of out.tests) console.log(`               ${t}`);
  if (out.cases) {
    console.log(
      `[revert-check] cases: ${out.cases.depends.length} depend, ` +
        `${out.cases.vacuous.length} vacuous, ${out.cases.unmatched.length} unmatched`,
    );
    for (const t of out.cases.vacuous) console.log(`               VACUOUS  ${t}`);
    for (const t of out.cases.unmatched) console.log(`               unmatched  ${t}`);
  }
  console.log(`[revert-check] ${out.verdict.toUpperCase()}: ${out.reason}`);
  process.exit(step.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
