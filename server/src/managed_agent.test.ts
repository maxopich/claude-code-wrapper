import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

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
      // script in the copied project.
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
