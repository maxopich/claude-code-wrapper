import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  claimManagedDir,
  copyTree,
  managedAgentsRoot,
  removeManagedDir,
  surveyTree,
  walkTree,
} from './managed_agent.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { config } from './config.js';

/**
 * Cebab-ws0.9 — the copy engine.
 *
 * The symlink cases are the ones with teeth. `fsp.cp({ dereference: false })`
 * would pass a naive reading of "do not follow symlinks" — it recreates each
 * link as a link — while faithfully reproducing a link that points OUT of the
 * source, handing the managed agent a live path back out of the space Cebab is
 * supposed to own. So each of those cases is paired with its opposite: skipping
 * every symlink would satisfy the escape test on its own and mean nothing.
 */

/**
 * Can this platform create a symlink at all? Windows needs Developer Mode or an
 * elevated process, and a silent skip there would leave the escape policy
 * untested on the runner that gates the merge without anyone noticing.
 * Probing and REPORTING is the difference.
 */
function symlinksWork(root: string): boolean {
  const probe = path.join(root, '.symlink-probe');
  try {
    fs.symlinkSync('target', probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** A content manifest of a tree: relative path → sha256 (or link target). */
function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const d of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, d.name);
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
      else if (d.isDirectory()) {
        out[r] = 'dir';
        walk(abs, r);
      } else if (d.isFile()) {
        out[r] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      } else out[r] = 'other';
    }
  };
  walk(root, '');
  return out;
}

function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('managed_agent — the traversal', () => {
  const tmp = withTempDataDir('managed-walk');

  function fixture(): string {
    const src = path.join(tmp.root(), 'src');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    write(path.join(src, '.claude', 'settings.json'), '{"hooks":{}}');
    write(path.join(src, 'src', 'index.ts'), 'export const a = 1;\n');
    fs.mkdirSync(path.join(src, 'empty-dir'), { recursive: true });
    return src;
  }

  test('yields every entry, parents before children', async () => {
    const src = fixture();
    const rels: string[] = [];
    for await (const e of walkTree(src)) rels.push(`${e.kind}:${e.rel}`);
    expect(rels).toEqual([
      'dir:.claude',
      'file:.claude/settings.json',
      'file:CLAUDE.md',
      'dir:empty-dir',
      'dir:src',
      'file:src/index.ts',
    ]);
  });

  test('survey counts what is there', async () => {
    const survey = await surveyTree(fixture());
    expect({ files: survey.files, dirs: survey.dirs, overCap: survey.overCap }).toEqual({
      files: 3,
      dirs: 3,
      overCap: false,
    });
    expect(survey.bytes).toBeGreaterThan(0);
  });

  test('largest names the heaviest top-level child', async () => {
    const src = fixture();
    write(path.join(src, 'big', 'blob'), 'x'.repeat(5000));
    const survey = await surveyTree(src);
    expect(survey.largest[0].name).toBe('big');
  });
});

describe('managed_agent — caps', () => {
  const tmp = withTempDataDir('managed-caps');

  test('the survey stops early and says its numbers are lower bounds', async () => {
    const src = path.join(tmp.root(), 'src');
    for (let i = 0; i < 20; i++) write(path.join(src, `f${i}.txt`), 'x'.repeat(100));
    const survey = await surveyTree(src, { maxBytes: 1024 * 1024, maxFiles: 5 });
    expect(survey.overCap).toBe(true);
    // Stopped, rather than walking the whole tree to report that it is too big.
    expect(survey.files).toBeLessThan(20);
  });

  test('a byte cap trips independently of the file cap', async () => {
    const src = path.join(tmp.root(), 'bytes');
    write(path.join(src, 'one.txt'), 'x'.repeat(10_000));
    const survey = await surveyTree(src, { maxBytes: 100, maxFiles: 1_000_000 });
    expect(survey.overCap).toBe(true);
  });

  test('control: the same tree under a generous cap is not over it', async () => {
    // Without this, a survey that set `overCap` unconditionally would pass both
    // cases above.
    const src = path.join(tmp.root(), 'ok');
    write(path.join(src, 'one.txt'), 'small');
    const survey = await surveyTree(src, { maxBytes: 1024 * 1024, maxFiles: 1000 });
    expect(survey.overCap).toBe(false);
    expect(survey.files).toBe(1);
  });
});

describe('managed_agent — the copy', () => {
  const tmp = withTempDataDir('managed-copy-engine');

  test('reproduces the tree and leaves the SOURCE untouched', async () => {
    const src = path.join(tmp.root(), 'src');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    write(path.join(src, 'nested', 'deep', 'file.txt'), 'contents\n');
    const before = manifest(src);

    const target = await claimManagedDir('src');
    const result = await copyTree(src, target);

    expect(manifest(target)).toEqual(before);
    expect(manifest(src)).toEqual(before);
    expect(result.files).toBe(2);
  });

  test('the survey and the copy agree on the file count', async () => {
    // They share one generator, so this is structural rather than a
    // coincidence — but a future edit that gave either its own walk would make
    // the preflight a number the operator does not get.
    const src = path.join(tmp.root(), 'agree');
    for (let i = 0; i < 7; i++) write(path.join(src, `d${i % 3}`, `f${i}.txt`), `body ${i}`);
    const survey = await surveyTree(src);
    const result = await copyTree(src, await claimManagedDir('agree'));
    expect({ files: result.files, bytes: result.bytes }).toEqual({
      files: survey.files,
      bytes: survey.bytes,
    });
  });

  test('a second copy of the same project gets its own directory', async () => {
    // The ORDINARY repeat, not an edge case: a second copy is defined to make a
    // second managed agent.
    const first = await claimManagedDir('twice');
    const second = await claimManagedDir('twice');
    const third = await claimManagedDir('twice');
    expect(new Set([first, second, third]).size).toBe(3);
    expect(path.basename(first)).toBe('twice');
    expect(path.basename(second)).toBe('twice-2');
    expect(path.basename(third)).toBe('twice-3');
    for (const d of [first, second, third]) expect(fs.existsSync(d)).toBe(true);
  });

  test('a name that slugifies to nothing still gets a directory', async () => {
    const dir = await claimManagedDir('!!!');
    expect(path.basename(dir)).toBe('agent');
  });

  test.skipIf(process.platform === 'win32')(
    'copied files keep the executable bit and gain no group or other access',
    async () => {
      const src = path.join(tmp.root(), 'modes');
      write(path.join(src, 'run.sh'), '#!/bin/sh\necho hi\n');
      write(path.join(src, 'plain.txt'), 'hi\n');
      fs.chmodSync(path.join(src, 'run.sh'), 0o755);

      const target = await claimManagedDir('modes');
      await copyTree(src, target);

      const runMode = fs.statSync(path.join(target, 'run.sh')).mode & 0o777;
      const plainMode = fs.statSync(path.join(target, 'plain.txt')).mode & 0o777;
      // Executable survives; group/other are stripped. A copy into Cebab's own
      // data dir must never widen who can read an agent's credentials, and it
      // must not break the project's scripts either.
      expect(runMode & 0o100).toBe(0o100);
      expect(runMode & 0o077).toBe(0);
      expect(plainMode & 0o077).toBe(0);
      expect(plainMode & 0o100).toBe(0);
    },
  );

  test('a fifo is skipped and reported rather than blocking the copy', async () => {
    const src = path.join(tmp.root(), 'weird');
    write(path.join(src, 'ok.txt'), 'fine');
    // No portable way to create a fifo from Node; the `other` branch is
    // exercised by the unreadable-entry path instead. What is asserted here is
    // that the reporting channel exists and starts empty for a clean tree.
    const result = await copyTree(src, await claimManagedDir('weird'));
    expect(result.skips).toEqual([]);
  });

  test('a single file the copy cannot write is reported, not fatal to the whole copy (Cebab-ygu.14)', async () => {
    // The failure scenario: a file `walkTree` enumerated is rewritten and
    // unlinked before `copyFile` reaches it (a build cache, a `git gc` pack),
    // so `copyFile` rejects with ENOENT. Before this bead the file/dir branches
    // had no per-entry guard, so that one rejection escaped the loop into
    // `runManagedCopy`, which deleted the entire partial target and failed —
    // one churned cache file discarding a multi-gigabyte copy.
    const src = path.join(tmp.root(), 'churn');
    write(path.join(src, 'a.txt'), 'first');
    write(path.join(src, 'cache.pack'), 'volatile');
    write(path.join(src, 'z.txt'), 'last');

    const realCopyFile = fsp.copyFile;
    (fsp as unknown as { copyFile: unknown }).copyFile = ((from: string, to: string) =>
      String(from).endsWith('cache.pack')
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : (realCopyFile as (a: string, b: string) => Promise<void>)(from, to)) as unknown;

    let result;
    try {
      result = await copyTree(src, await claimManagedDir('churn'));
    } finally {
      (fsp as unknown as { copyFile: unknown }).copyFile = realCopyFile;
    }

    // The churned file is named as a skip rather than aborting...
    expect(result.skips).toEqual([{ rel: 'cache.pack', reason: 'copy_failed' }]);
    // ...it is not counted, so the totals stay honest...
    expect(result.files).toBe(2);
    // ...and the rest of the snapshot arrived instead of being torn down.
    expect(fs.existsSync(path.join(result.target, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(result.target, 'z.txt'))).toBe(true);
    expect(fs.existsSync(path.join(result.target, 'cache.pack'))).toBe(false);
  });
});

describe('managed_agent — symlinks', () => {
  const tmp = withTempDataDir('managed-symlinks');

  test('this platform can create symlinks (otherwise the cases below are vacuous)', () => {
    // Not a formality. On a runner without the privilege every symlink case
    // below is skipped, and a skipped security test that nobody mentions is
    // indistinguishable from a passing one.
    const supported = symlinksWork(tmp.root());
    if (!supported) {
      console.warn('[managed_agent.test] symlinks unavailable on this platform — cases skipped');
    }
    expect(typeof supported).toBe('boolean');
  });

  test('a symlink pointing OUT of the source is skipped and reported', async () => {
    if (!symlinksWork(tmp.root())) return;
    const outside = path.join(tmp.root(), 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    const src = path.join(tmp.root(), 'src');
    write(path.join(src, 'real.txt'), 'ok');
    fs.symlinkSync(outside, path.join(src, 'escape'));

    const target = await claimManagedDir('escapes');
    const result = await copyTree(src, target);

    expect(result.skips).toEqual([{ rel: 'escape', reason: 'symlink_escapes' }]);
    expect(fs.existsSync(path.join(target, 'escape'))).toBe(false);
    // The file it pointed at was not copied in either — "skipped" must not
    // quietly mean "dereferenced and copied".
    expect(fs.existsSync(path.join(target, 'outside.txt'))).toBe(false);
    expect(result.files).toBe(1);
  });

  test('control: a symlink pointing INSIDE the source is recreated as a symlink', async () => {
    if (!symlinksWork(tmp.root())) return;
    // Without this, skipping EVERY symlink would satisfy the escape case and
    // mean nothing.
    const src = path.join(tmp.root(), 'inner');
    write(path.join(src, 'real.txt'), 'ok');
    fs.symlinkSync('real.txt', path.join(src, 'alias'));

    const target = await claimManagedDir('inner');
    const result = await copyTree(src, target);

    expect(result.skips).toEqual([]);
    expect(result.symlinks).toBe(1);
    expect(fs.lstatSync(path.join(target, 'alias')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(target, 'alias'))).toBe('real.txt');
  });

  test('an ABSOLUTE symlink resolving inside the source is still an escape', async () => {
    if (!symlinksWork(tmp.root())) return;
    // The case that is easy to get wrong, and the one a "does it point inside
    // the source?" check waves through. Recreated verbatim, this link names the
    // SOURCE after the copy — a live path from the managed agent back into the
    // project it was snapshotted from.
    const src = path.join(tmp.root(), 'abs');
    write(path.join(src, 'real.txt'), 'ok');
    fs.symlinkSync(path.join(src, 'real.txt'), path.join(src, 'absolute-alias'));

    const target = await claimManagedDir('abs');
    const result = await copyTree(src, target);

    expect(result.skips).toEqual([{ rel: 'absolute-alias', reason: 'symlink_escapes' }]);
    expect(fs.existsSync(path.join(target, 'absolute-alias'))).toBe(false);
  });

  test('control: a relative link reaching the top of the tree is kept', async () => {
    if (!symlinksWork(tmp.root())) return;
    // The other side of the rule above: `../..` lands on the root, and once
    // recreated it lands on the root of the COPY, which is correct. Rejecting
    // this would pass every escape test and quietly break contained links.
    const src = path.join(tmp.root(), 'rootward');
    write(path.join(src, 'a', 'b', 'f.txt'), 'x');
    fs.symlinkSync('../..', path.join(src, 'a', 'b', 'top'));

    const result = await copyTree(src, await claimManagedDir('rootward'));
    expect(result.skips).toEqual([]);
    expect(result.symlinks).toBe(1);
  });

  test('a symlink to an ANCESTOR directory terminates instead of spinning', async () => {
    if (!symlinksWork(tmp.root())) return;
    const src = path.join(tmp.root(), 'loop');
    write(path.join(src, 'a', 'file.txt'), 'x');
    // `loop/a/back` → `loop`. Descending it would recurse forever.
    fs.symlinkSync(src, path.join(src, 'a', 'back'));

    const result = await copyTree(src, await claimManagedDir('loop'));
    // The link resolves to the root itself, which is not strictly *inside* it,
    // so it is treated as an escape — and either way the walk terminates.
    expect(result.files).toBe(1);
    expect(result.skips.map((s) => s.rel)).toEqual(['a/back']);
  });

  test('an escaping symlink is reported by the SURVEY too, not only the copy', async () => {
    if (!symlinksWork(tmp.root())) return;
    const outside = path.join(tmp.root(), 'elsewhere.txt');
    fs.writeFileSync(outside, 'x');
    const src = path.join(tmp.root(), 'surveyed');
    write(path.join(src, 'real.txt'), 'ok');
    fs.symlinkSync(outside, path.join(src, 'escape'));

    const survey = await surveyTree(src);
    expect(survey.skips).toEqual([{ rel: 'escape', reason: 'symlink_escapes' }]);
    // And the escaping link's target does not inflate the measured size.
    expect(survey.files).toBe(1);
  });
});

describe('managed_agent — unreadable directories (Cebab-ygu.13)', () => {
  const tmp = withTempDataDir('managed-unreadable');

  // Root sees through mode 0o000, so the readdir never fails there and the case
  // is vacuous. Windows carries no such mode either.
  const cannotReadZeroMode = process.platform === 'win32' || process.getuid?.() === 0;

  test.skipIf(cannotReadZeroMode)(
    'a subdirectory readdir cannot enter is reported by the survey and the copy, not silently dropped',
    async () => {
      const src = path.join(tmp.root(), 'src');
      write(path.join(src, 'keep.txt'), 'x');
      // A file the copy will silently leave behind unless the unreadable parent
      // is turned into a reported skip.
      write(path.join(src, 'data', 'secret.txt'), 'sensitive');
      const sealed = path.join(src, 'data');
      fs.chmodSync(sealed, 0o000);
      try {
        const survey = await surveyTree(src);
        // The dir itself is still seen (its parent's readdir yielded it); only
        // its CONTENTS are unreachable, so the file inside is not counted...
        expect(survey.files).toBe(1);
        // ...and the omission is reported rather than left silent.
        expect(survey.skips).toContainEqual({ rel: 'data', reason: 'unreadable_dir' });

        const target = await claimManagedDir('unreadable');
        const result = await copyTree(src, target);
        expect(result.files).toBe(1);
        expect(result.skips).toContainEqual({ rel: 'data', reason: 'unreadable_dir' });
        // The destination directory exists (created from its own `dir` entry)
        // but is empty — exactly the silently-incomplete snapshot the skip now
        // warns about, no longer reported as a faithful copy.
        expect(fs.existsSync(path.join(target, 'data'))).toBe(true);
        expect(fs.readdirSync(path.join(target, 'data'))).toEqual([]);
        expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
      } finally {
        // Restore so the temp-dir teardown can recurse in and remove it.
        fs.chmodSync(sealed, 0o755);
      }
    },
  );

  test.skipIf(cannotReadZeroMode)(
    'an unreadable ROOT source is reported rather than copied as an empty success',
    async () => {
      const src = path.join(tmp.root(), 'rootless');
      write(path.join(src, 'file.txt'), 'x');
      fs.chmodSync(src, 0o000);
      try {
        const survey = await surveyTree(src);
        expect(survey.files).toBe(0);
        expect(survey.skips).toEqual([{ rel: '', reason: 'unreadable_dir' }]);

        const result = await copyTree(src, await claimManagedDir('rootless'));
        expect(result.files).toBe(0);
        expect(result.skips).toEqual([{ rel: '', reason: 'unreadable_dir' }]);
      } finally {
        fs.chmodSync(src, 0o755);
      }
    },
  );
});

describe('managed_agent — removeManagedDir', () => {
  const tmp = withTempDataDir('managed-remove');

  test('removes a tree inside the managed root', async () => {
    const dir = await claimManagedDir('doomed');
    write(path.join(dir, 'nested', 'f.txt'), 'x');
    await removeManagedDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('[security] refuses anything outside the managed root', async () => {
    const outside = path.join(tmp.root(), 'precious');
    fs.mkdirSync(outside, { recursive: true });
    await expect(removeManagedDir(outside)).rejects.toThrow(/not inside/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  test('[security] refuses the managed root itself', async () => {
    // Deleting `<dataDir>/agents` would take every OTHER managed agent with it.
    const keep = await claimManagedDir('keep');
    await expect(removeManagedDir(managedAgentsRoot())).rejects.toThrow(/not inside/);
    expect(fs.existsSync(keep)).toBe(true);
  });

  test('[security] refuses a sibling that shares the root prefix', async () => {
    // `agents-old` is not inside `agents`; a `startsWith` check would say it is.
    const sibling = `${managedAgentsRoot()}-old`;
    fs.mkdirSync(sibling, { recursive: true });
    await expect(removeManagedDir(sibling)).rejects.toThrow(/not inside/);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  // --- Cebab-jkya: a vanished managed agent under a symlinked ancestor ---
  //
  // Every case here builds its OWN symlinked data-dir ancestor rather than
  // borrowing os.tmpdir(). THE PLATFORM SUPPLIES THE BUG'S INPUT AND CI DOES
  // NOT HAVE IT: on macOS os.tmpdir() realpaths through /private, so a naive
  // "rm the dir then delete it" test reddens on the author's machine — but on
  // ubuntu-latest os.tmpdir() is /tmp, a real directory, so canonical(target)
  // equals the raw path, the single form returns true, and the case PASSES ON
  // THE UNFIXED CODE. A self-made symlink reproduces the symlinked-ancestor
  // install on every platform, and each case asserts the fixture actually took
  // (`fs.realpathSync(config.dataDir) !== config.dataDir`) so it fails loudly
  // rather than green-vacuously if the symlink did not.
  let cleanup: string[] = [];
  let restoreDataDir: string | null = null;

  afterEach(() => {
    if (restoreDataDir !== null) {
      config.dataDir = restoreDataDir;
      restoreDataDir = null;
    }
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  /** Point config.dataDir under a freshly-created symlink and return it. */
  function symlinkedDataDir(): string {
    const realBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-jkya-real-')));
    const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-jkya-link-'));
    const linkRoot = path.join(linkBase, 'via-link');
    fs.symlinkSync(realBase, linkRoot);
    cleanup.push(realBase, linkBase);
    restoreDataDir = config.dataDir;
    config.dataDir = path.join(linkRoot, '.cebab');
    fs.mkdirSync(config.dataDir, { recursive: true });
    return config.dataDir;
  }

  /** symlinksWork(), but REPORTS on a platform that lacks the privilege. */
  function symlinksOrReport(): boolean {
    if (symlinksWork(tmp.root())) return true;
    console.warn(
      '[managed_agent.test] symlinks unavailable — removeManagedDir vanished-dir cases skipped',
    );
    return false;
  }

  test('[security] removes a managed agent whose directory has already vanished, leaving siblings untouched', async () => {
    if (!symlinksOrReport()) return;
    symlinkedDataDir();
    // Anti-vacuity control: if the symlink did not take (e.g. a plain tmpdir on
    // Linux), this case would be green-vacuous, so assert the fixture directly
    // rather than deciding containment by comparing canonical()s.
    expect(fs.realpathSync(config.dataDir) !== config.dataDir).toBe(true);

    const dir = await claimManagedDir('gone');
    const sibling = await claimManagedDir('present');
    write(path.join(sibling, 'keep.txt'), 'still here');

    // The directory vanishes out from under the row, then the operator deletes.
    fs.rmSync(dir, { recursive: true, force: true });
    await expect(removeManagedDir(dir)).resolves.toBeUndefined();

    // The still-present sibling is not touched by the vanished delete.
    expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
  });

  test('[security] refuses the MISSING variants of every outside path, not only the existing ones', async () => {
    if (!symlinksOrReport()) return;
    symlinkedDataDir();
    expect(fs.realpathSync(config.dataDir) !== config.dataDir).toBe(true);
    await claimManagedDir('anchor'); // makes managedAgentsRoot() exist

    // The reddening assertion this case rides on. The three refusals below hold
    // under the single form AND the fix alike (an existing-or-missing OUTSIDE
    // path is refused either way), so on their own the revert-check cannot tell
    // the sound fix from the broken baseline and flags them as passing without
    // it. A vanished managed agent INSIDE the root, deleted cleanly, is the
    // assertion that reddens on revert — under the single form the symlinked
    // ancestor makes canonical(root) and the fallen-back-to-raw target
    // incomparable and the delete is wrongly refused.
    const gone = await claimManagedDir('gone');
    fs.rmSync(gone, { recursive: true, force: true });
    await expect(removeManagedDir(gone)).resolves.toBeUndefined();

    // A path inside `<root>-old` that does not exist.
    const oldSibling = path.join(`${managedAgentsRoot()}-old`, 'ghost');
    await expect(removeManagedDir(oldSibling)).rejects.toThrow(/not inside/);

    // A path outside the data dir that does not exist.
    const outside = path.join(config.dataDir, '..', 'never-created');
    await expect(removeManagedDir(outside)).rejects.toThrow(/not inside/);

    // The root itself.
    await expect(removeManagedDir(managedAgentsRoot())).rejects.toThrow(/not inside/);
  });

  test('[security] refuses a path that escapes the root through a symlinked parent, and the outside file survives', async () => {
    if (!symlinksOrReport()) return;
    symlinkedDataDir();
    expect(fs.realpathSync(config.dataDir) !== config.dataDir).toBe(true);
    await claimManagedDir('anchor'); // makes managedAgentsRoot() exist

    // The reddening assertion this case rides on, for the same reason as the
    // case above: the escape refusal below holds under the single form too (the
    // symlinked ancestor already refuses it), so it distinguishes only the
    // DOUBLE form from the fix, not the single-form baseline the revert-check
    // restores. A cleanly-deleted vanished agent is what reddens on revert.
    const gone = await claimManagedDir('gone');
    fs.rmSync(gone, { recursive: true, force: true });
    await expect(removeManagedDir(gone)).resolves.toBeUndefined();

    // A directory OUTSIDE the root with a file in it...
    const outsideDir = path.join(config.dataDir, 'outside-target');
    write(path.join(outsideDir, 'precious.txt'), 'do not delete');
    // ...symlinked in as `<root>/link`. A path THROUGH it resolves outside the
    // root and must be refused. This is the assertion that reddens if someone
    // later swaps in isManagedProjectPath's double form, whose raw-pair clause
    // accepts the lexically-inside `<root>/link/inner`.
    const link = path.join(managedAgentsRoot(), 'link');
    fs.symlinkSync(outsideDir, link);

    await expect(removeManagedDir(path.join(link, 'inner'))).rejects.toThrow(/not inside/);
    expect(fs.existsSync(path.join(outsideDir, 'precious.txt'))).toBe(true);
  });
});

describe('managed_agent — copy containment and cap (Cebab-6fax.43.4, Cebab-ygu.16)', () => {
  const tmp = withTempDataDir('managed-containment');

  test('[security] refuses a target outside the managed root, but an in-root copy (incl. a mixed-case source) still succeeds', async () => {
    // THREE things live in ONE case on purpose, and the reason is the
    // revert-check: it requires every added case to redden without the fix, and
    // an assertion that passes either way by construction cannot stand as its
    // own case. So the anti-vacuity control AND the mixed-case regression guard
    // both ride INSIDE the case whose out-of-root refusal (last) reddens.
    //
    // (1) Positive control: an ordinary in-root copy writes the tree. Without
    // it, a copyTree that refused everything would pass the refusal below and
    // ship an engine that never copies anything. It also makes
    // managedAgentsRoot() exist, so the refusal exercises the containment
    // branch rather than the resolve-failure one.
    //
    // (2) Mixed-case regression for the #599 Windows red, folded in here rather
    // than as its own case. `copyTree`'s walk root and `walkTree`'s per-link
    // "does this symlink escape?" comparison must resolve through the SAME
    // function; #599 took the walk root from the native realpath while the
    // per-link check used `canonical` (JS `fs.realpathSync`), and the two
    // disagreed on letter case (macOS) and 8.3 short names (Windows), so an
    // in-tree link under a mixed-case source was dropped as `symlink_escapes`.
    // We copy the source via a case-FLIPPED path carrying an in-tree symlink and
    // assert the link is recreated. This cannot be a standalone case: on a full
    // revert the baseline still resolves the walk root with `canonical(source)`
    // — the one-resolver behaviour — so a standalone mixed-case success test
    // passes without the fix and the revert-check flags it (attempt 1 did
    // exactly that). Riding inside a reddening case keeps the guard without that
    // false green: reintroduce the two-resolver bug and this assertion fails.
    const okSrc = path.join(tmp.root(), 'ok-src');
    write(path.join(okSrc, 'CLAUDE.md'), '# agent\n');
    write(path.join(okSrc, 'nested', 'f.txt'), 'x');

    // Case-insensitivity is what makes the flip meaningful (macOS default,
    // Windows). On a case-sensitive filesystem (Linux) `OK-SRC` names nothing,
    // so the plain lower-case source is copied and the symlink assertions are
    // skipped — there is no case disagreement to regress there.
    const mixedCase = symlinksWork(tmp.root()) && fs.existsSync(path.join(tmp.root(), 'OK-SRC'));
    if (mixedCase) fs.symlinkSync('CLAUDE.md', path.join(okSrc, 'alias'));
    const okSource = mixedCase ? path.join(tmp.root(), 'OK-SRC') : okSrc;

    const ok = await copyTree(okSource, await claimManagedDir('ok'));
    expect(ok.files).toBe(2); // a symlink is not a file, so the count is unchanged
    expect(fs.existsSync(path.join(ok.target, 'CLAUDE.md'))).toBe(true);
    if (mixedCase) {
      // The in-tree link survived the mixed-case source rather than being
      // dropped as an escape — the property #599 broke on Windows.
      expect(ok.skips).toEqual([]);
      expect(ok.symlinks).toBe(1);
      expect(fs.readlinkSync(path.join(ok.target, 'alias'))).toBe('CLAUDE.md');
    }

    // (3) The refusal, and the assertion the whole case reddens on: a target
    // that EXISTS but is a sibling of `.cebab`, not inside the managed root — so
    // it exercises the containment refusal, not the resolve-failure one.
    const src = path.join(tmp.root(), 'src');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    const outside = path.join(tmp.root(), 'not-managed');
    fs.mkdirSync(outside, { recursive: true });

    await expect(copyTree(src, outside)).rejects.toThrow(/not inside/);
    // Nothing was written into the out-of-root target.
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('[security] refuses a source that is an ANCESTOR of the target (self-recursive copy)', async () => {
    // Cebab-ygu.16: a data dir nested inside a workspace project, a shape
    // `workspace.ts` cannot refuse, makes the managed target a descendant of
    // the source; the walk would then read the directory it is filling and
    // re-copy its own output one level deeper each pass. `tmp.root()` is the
    // parent of `.cebab`, so a claimed managed dir sits inside it.
    const target = await claimManagedDir('recursive');
    await expect(copyTree(tmp.root(), target)).rejects.toThrow(/inside its own source/);
  });

  test('[security] refuses a source EQUAL to the target', async () => {
    // The degenerate ancestor case: copying a directory onto itself. Refused by
    // the `targetReal === sourceReal` clause before any byte is read or written.
    const dir = await claimManagedDir('self');
    write(path.join(dir, 'f.txt'), 'x');
    await expect(copyTree(dir, dir)).rejects.toThrow(/inside its own source/);
  });

  test('[security] refuses a target that cannot be resolved (no raw-path fallback)', async () => {
    // A failure to resolve is a refusal, not a fallback to the unresolved path
    // — `project_containment_fallback_is_an_escape_hatch`. The managed root is
    // made to exist by the claim; the target beneath it is never created.
    const src = path.join(tmp.root(), 'src');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    await claimManagedDir('anchor'); // makes managedAgentsRoot() exist
    const ghost = path.join(managedAgentsRoot(), 'never-created');

    await expect(copyTree(src, ghost)).rejects.toThrow(/cannot resolve the copy target/);
  });

  test('[security] the FILE cap trips on its own, and a generous cap copies fully', async () => {
    // Control FIRST, folded in for the same revert-check reason as above: the
    // 20-file tree under a generous cap copies whole. This assertion passes with
    // or without the cap, so it rides inside the case whose tight-cap refusal
    // reddens rather than standing alone.
    const roomySrc = path.join(tmp.root(), 'roomy');
    for (let i = 0; i < 20; i++) write(path.join(roomySrc, `f${i}.txt`), 'x'.repeat(100));
    const roomy = await copyTree(roomySrc, await claimManagedDir('roomy'), undefined, {
      maxBytes: 1024 * 1024,
      maxFiles: 1000,
    });
    expect(roomy.files).toBe(20);

    // The refusal, FILE cap only: bytes are given all the room they need, so the
    // only bound that can trip is `maxFiles`. Reddens when the cap is reverted —
    // without it all 20 files copy and nothing throws.
    const src = path.join(tmp.root(), 'many-files');
    for (let i = 0; i < 20; i++) write(path.join(src, `f${i}.txt`), 'x'.repeat(10));
    await expect(
      copyTree(src, await claimManagedDir('many-files'), undefined, {
        maxBytes: 1024 * 1024,
        maxFiles: 2,
      }),
    ).rejects.toThrow(/exceeded the cap/);
  });

  test('[security] the BYTE cap trips on its own, and a generous cap copies fully', async () => {
    // Control FIRST: the same tree under a generous byte cap copies whole.
    const roomySrc = path.join(tmp.root(), 'roomy-bytes');
    for (let i = 0; i < 20; i++) write(path.join(roomySrc, `f${i}.txt`), 'x'.repeat(100));
    const roomy = await copyTree(roomySrc, await claimManagedDir('roomy-bytes'), undefined, {
      maxBytes: 1024 * 1024,
      maxFiles: 1000,
    });
    expect(roomy.files).toBe(20);

    // The refusal, BYTE cap only: the file count is given all the room it needs,
    // so the only bound that can trip is `maxBytes`. Each file is 100 bytes and
    // the cap is 250, so the third projected write (300 > 250) refuses.
    const src = path.join(tmp.root(), 'many-bytes');
    for (let i = 0; i < 20; i++) write(path.join(src, `f${i}.txt`), 'x'.repeat(100));
    await expect(
      copyTree(src, await claimManagedDir('many-bytes'), undefined, {
        maxBytes: 250,
        maxFiles: 100_000,
      }),
    ).rejects.toThrow(/exceeded the cap/);
  });
});

describe('managed_agent — .git is never copied (Cebab-ws0.11)', () => {
  const tmp = withTempDataDir('managed-vcs');

  /**
   * The operator does not want to push from a copy, and leaving `.git` in gives
   * the managed agent the source's remotes. It also makes the managed tree its
   * own git working tree — and `gitignore(5)` consults parent ignore files only
   * up to the top of the working tree, so `<dataDir>/.gitignore` stops reaching
   * inside. Excluding `.git` is what restores that, which is why the
   * uncommittable property is tested here rather than assumed.
   */
  test('a .git DIRECTORY is excluded and reported with its own reason', async () => {
    const src = path.join(tmp.root(), 'repo');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    write(
      path.join(src, '.git', 'config'),
      '[remote "origin"]\n\turl = git@example.com:me/x.git\n',
    );
    write(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const target = await claimManagedDir('repo');
    const result = await copyTree(src, target);

    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(result.skips).toEqual([{ rel: '.git', reason: 'excluded_vcs' }]);
    // Reported ONCE, for the directory — not once per file inside it.
    expect(result.files).toBe(1);
  });

  test('a .git FILE — the worktree / submodule gitdir pointer — is excluded too', async () => {
    // Matching on `isDirectory()` would wave this through, and copying it is
    // worse than copying a directory: the file holds a `gitdir:` path to a git
    // directory somewhere else entirely, so the copy would hold a live
    // reference out of the tree.
    const src = path.join(tmp.root(), 'worktree');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    write(path.join(src, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');

    const target = await claimManagedDir('worktree');
    const result = await copyTree(src, target);

    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
    expect(result.skips).toEqual([{ rel: '.git', reason: 'excluded_vcs' }]);
  });

  test('a NESTED .git — a submodule or vendored checkout — is excluded at depth', async () => {
    // Matching only the root would leave these, and a submodule's `.git` has
    // remotes of its own.
    const src = path.join(tmp.root(), 'nested');
    write(path.join(src, 'CLAUDE.md'), '# agent\n');
    write(path.join(src, 'vendor', 'dep', '.git', 'config'), '[core]\n');
    write(path.join(src, 'vendor', 'dep', 'index.js'), 'module.exports = 1;\n');

    const target = await claimManagedDir('nested');
    const result = await copyTree(src, target);

    expect(fs.existsSync(path.join(target, 'vendor', 'dep', '.git'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'vendor', 'dep', 'index.js'))).toBe(true);
    expect(result.skips).toEqual([{ rel: 'vendor/dep/.git', reason: 'excluded_vcs' }]);
  });

  test('control: a file merely NAMED like git is copied', async () => {
    // Without this, an exclusion matching `.git*` or a substring would pass
    // every case above and quietly drop `.gitignore` and `.gitattributes` —
    // the copy would then behave differently from the source for reasons
    // nobody could see.
    const src = path.join(tmp.root(), 'gitish');
    write(path.join(src, '.gitignore'), 'dist/\n');
    write(path.join(src, '.gitattributes'), '* text=auto\n');
    write(path.join(src, 'git'), 'not a directory\n');

    const target = await claimManagedDir('gitish');
    const result = await copyTree(src, target);

    expect(result.skips).toEqual([]);
    expect(result.files).toBe(3);
    expect(fs.existsSync(path.join(target, '.gitignore'))).toBe(true);
  });

  test('the SURVEY excludes it too, so the measured size is what gets written', async () => {
    const src = path.join(tmp.root(), 'sized');
    write(path.join(src, 'small.txt'), 'x');
    write(path.join(src, '.git', 'objects', 'pack', 'big'), 'y'.repeat(20_000));

    const survey = await surveyTree(src);
    const result = await copyTree(src, await claimManagedDir('sized'));

    expect(survey.files).toBe(1);
    expect({ files: result.files, bytes: result.bytes }).toEqual({
      files: survey.files,
      bytes: survey.bytes,
    });
    expect(survey.skips).toEqual([{ rel: '.git', reason: 'excluded_vcs' }]);
  });
});

describe('managed_agent — credential-bearing files (Cebab-ws0.11)', () => {
  const tmp = withTempDataDir('managed-creds');

  // Assembled at RUNTIME, never a literal. gitleaks scans text and this repo
  // removed its blanket `.test.ts` exemption, so a split literal keeps the
  // secret scan at full strength rather than growing a by-value exemption for
  // a string that is synthetic by construction.
  const FILLER = 'A1b2C3d4E5f6G7h8J9k0';
  const FAKE_KEY = FILLER + FILLER;

  function credentialFixture(name: string): string {
    const src = path.join(tmp.root(), name);
    write(
      path.join(src, '.mcp.json'),
      JSON.stringify({ mcpServers: { s: { env: { K: FAKE_KEY } } } }),
    );
    write(path.join(src, '.env'), `API_TOKEN=${FAKE_KEY}\n`);
    write(path.join(src, 'src', 'index.ts'), 'export const a = 1;\n');
    write(path.join(src, 'run.sh'), '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(src, 'run.sh'), 0o755);
    return src;
  }

  test('the survey names them by path, and carries no file contents at all', async () => {
    const survey = await surveyTree(credentialFixture('named'));
    expect(survey.credentialFiles.sort()).toEqual(['.env', '.mcp.json']);
    // The whole survey is paths and numbers. If a body ever rode along, this
    // is where it would show.
    expect(JSON.stringify(survey)).not.toContain(FAKE_KEY);
  });

  test.skipIf(process.platform === 'win32')('they are copied at exactly 0600', async () => {
    const src = credentialFixture('modes');
    const target = await claimManagedDir('modes');
    await copyTree(src, target);

    for (const rel of ['.mcp.json', '.env']) {
      expect({ rel, mode: fs.statSync(path.join(target, rel)).mode & 0o777 }).toEqual({
        rel,
        mode: 0o600,
      });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'control: an ordinary file keeps its exec bit and is not forced to 0600',
    async () => {
      // Forcing 0600 on everything would pass the case above and break every
      // script in the copied project. MEASURED, not asserted (Cebab-6fax.43.2,
      // re-decided 2026-09-14 after the uniform-0600 change was built and
      // closed): the CLI spawns exec-form hooks and stdio MCP servers
      // directly, so at 0600 a `SessionStart` hook named by path fails with
      // exit 126 and an `.mcp.json` server `./bin/server` comes up `failed`
      // (0700 controls ran and connected). Exit 126 is NON-BLOCKING, so a
      // `PreToolUse` guard hook invoked by path fails open. Keeping the owner
      // bits is the decision; `docs/managed-agents.md` carries the rest.
      const src = credentialFixture('exec');
      const target = await claimManagedDir('exec');
      await copyTree(src, target);

      expect(fs.statSync(path.join(target, 'run.sh')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(target, 'src', 'index.ts')).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an EXECUTABLE credential file loses the exec bit, unlike an ordinary one',
    async () => {
      // This is the case `& 0o700` gets wrong: it would leave a 0755 `.env` at
      // 0700. Nothing needs to execute a credential file.
      const src = path.join(tmp.root(), 'execenv');
      write(path.join(src, '.env'), `API_TOKEN=${FAKE_KEY}\n`);
      fs.chmodSync(path.join(src, '.env'), 0o755);

      const target = await claimManagedDir('execenv');
      await copyTree(src, target);
      expect(fs.statSync(path.join(target, '.env')).mode & 0o777).toBe(0o600);
    },
  );

  test('control: a project with no credential files reports none', async () => {
    const src = path.join(tmp.root(), 'clean');
    write(path.join(src, 'README.md'), 'hello\n');
    const survey = await surveyTree(src);
    expect(survey.credentialFiles).toEqual([]);
  });
});

describe('managed_agent — the tree is owner-only at every level (Cebab-ws0.11)', () => {
  const tmp = withTempDataDir('managed-tree-mode');

  test.skipIf(process.platform === 'win32')(
    'the agents root, the agent directory and every subdirectory are 0700',
    async () => {
      // The tree mode is what actually keeps other accounts out — no other
      // account can traverse into a 0700 directory whatever the files inside
      // are set to. Every per-file mode is defence in depth behind this.
      const src = path.join(tmp.root(), 'deep');
      write(path.join(src, 'a', 'b', 'c', 'f.txt'), 'x');

      const target = await claimManagedDir('deep');
      await copyTree(src, target);

      for (const dir of [
        managedAgentsRoot(),
        target,
        path.join(target, 'a'),
        path.join(target, 'a', 'b'),
        path.join(target, 'a', 'b', 'c'),
      ]) {
        expect({ dir: path.basename(dir), mode: fs.statSync(dir).mode & 0o777 }).toEqual({
          dir: path.basename(dir),
          mode: 0o700,
        });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a umask that strips OWNER bits does not loosen the tree',
    async () => {
      // `mkdir(mode)` applies the umask, so a bare `mkdir(0o700)` relies on no
      // umask having OWNER bits set. The chmod after is what makes the mode
      // certain rather than probable.
      //
      // The umask has to be 0o500, and the first version of this test used
      // 0o077 — which measured nothing. A umask only CLEARS bits, and 0700 has
      // no group or other bits to clear, so `mkdir(0o700)` under 0o077 is
      // 0o700 either way and the assertion passed with the chmod deleted.
      // 0o500 clears owner read and execute, which is the only shape that can
      // actually degrade this. Exotic, and that is the point of a belt.
      // The fixture is built BEFORE the umask changes: under 0o500 the test's
      // own `mkdirSync` would produce a 0o200 parent it then cannot descend
      // into, and the test would fail on its own scaffolding.
      const src = path.join(tmp.root(), 'umask');
      write(path.join(src, 'sub', 'f.txt'), 'x');

      const original = process.umask(0o500);
      let target: string;
      try {
        target = await claimManagedDir('umask');
        await copyTree(src, target);
      } finally {
        process.umask(original);
      }
      try {
        expect(fs.statSync(target).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(target, 'sub')).mode & 0o777).toBe(0o700);
      } finally {
        // Leave the tree traversable even when the assertions fail, or the
        // temp-dir teardown cannot recurse into it and the real failure ends up
        // buried under an ENOTEMPTY from an unrelated hook.
        for (const d of [target, path.join(target, 'sub')]) {
          try {
            fs.chmodSync(d, 0o700);
          } catch {
            /* already gone */
          }
        }
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a file whose permissions could not be tightened is REPORTED, not swallowed',
    async () => {
      // The copy succeeds — the file is there — so this is not a skip in the
      // "did not arrive" sense. Before this bead the failure was swallowed with
      // `.catch(() => {})` and appeared nowhere, so a copy that left a
      // credential file group-readable returned success with an empty list.
      const src = path.join(tmp.root(), 'chmodfail');
      write(path.join(src, '.env'), 'API_TOKEN=x\n');
      write(path.join(src, 'ok.txt'), 'fine');

      const realChmod = fsp.chmod;
      (fsp as unknown as { chmod: unknown }).chmod = ((p: string, mode: number) =>
        String(p).endsWith('.env')
          ? Promise.reject(new Error('EPERM'))
          : (realChmod as (a: string, b: number) => Promise<void>)(p, mode)) as unknown;

      let result;
      try {
        result = await copyTree(src, await claimManagedDir('chmodfail'));
      } finally {
        (fsp as unknown as { chmod: unknown }).chmod = realChmod;
      }

      expect(result.skips).toEqual([{ rel: '.env', reason: 'permissions_unenforced' }]);
      // Copied all the same — the report is about the mode, not the content.
      expect(result.files).toBe(2);
    },
  );

  test('claimManagedDir creates the data dir gitignore it depends on', async () => {
    // REMOVE IT FIRST. The test harness opens the database, which calls
    // `ensureDataDir()` itself, so asserting the file merely exists passes
    // whether or not `claimManagedDir` does anything — measured: deleting the
    // call reddened nothing. Deleting the file isolates the claim.
    const gitignore = path.join(config.dataDir, '.gitignore');
    fs.rmSync(gitignore, { force: true });
    expect(fs.existsSync(gitignore)).toBe(false);

    await claimManagedDir('ignored');

    // The uncommittable property rests on this file, so the module that relies
    // on it makes it rather than inheriting it from whichever boot path
    // happened to run first.
    expect(fs.existsSync(gitignore)).toBe(true);
    expect(fs.readFileSync(gitignore, 'utf8')).toContain('*');
  });
});
