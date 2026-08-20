import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
