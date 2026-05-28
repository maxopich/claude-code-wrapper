import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { computeWorkspaceDiff, parseGitPorcelain, SAMPLE_CHANGES_CAP } from './workspace_diff.js';

// Cluster D Phase 5b (spec §6.3): coverage for the workspace-diff
// helper consumed by the `reopen_session` probe.
//
// Two layers:
//   1. `parseGitPorcelain` — pure synthetic-input parser; exercises the
//      classification (added vs deleted vs modified) and the sample cap.
//   2. `computeWorkspaceDiff` — integration test that shells out to a
//      real `git` against a tmp repo. Skipped automatically if git isn't
//      on PATH (CI environments that lack it).

describe('parseGitPorcelain', () => {
  test('empty input → clean tree, fullDiffAvailable:true', () => {
    expect(parseGitPorcelain('')).toEqual({
      filesChanged: 0,
      filesAdded: 0,
      filesDeleted: 0,
      sampleChanges: [],
      fullDiffAvailable: true,
    });
  });

  test('untracked file (??) counts as added', () => {
    // `?? new-file.txt\0`
    const out = '?? new-file.txt\0';
    expect(parseGitPorcelain(out)).toEqual({
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
      sampleChanges: ['new-file.txt'],
      fullDiffAvailable: true,
    });
  });

  test('modified-in-worktree ( M) counts as changed-only', () => {
    const out = ' M src/edited.ts\0';
    expect(parseGitPorcelain(out)).toEqual({
      filesChanged: 1,
      filesAdded: 0,
      filesDeleted: 0,
      sampleChanges: ['src/edited.ts'],
      fullDiffAvailable: true,
    });
  });

  test('staged-add (A ) counts as added', () => {
    const out = 'A  staged-new.txt\0';
    expect(parseGitPorcelain(out)).toEqual({
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
      sampleChanges: ['staged-new.txt'],
      fullDiffAvailable: true,
    });
  });

  test('staged-delete (D ) and worktree-delete ( D) both count as deleted', () => {
    const out = 'D  removed-staged.txt\0 D removed-worktree.txt\0';
    expect(parseGitPorcelain(out)).toMatchObject({
      filesChanged: 2,
      filesAdded: 0,
      filesDeleted: 2,
      sampleChanges: ['removed-staged.txt', 'removed-worktree.txt'],
    });
  });

  test('mixed entries — counts roll up correctly', () => {
    // 1 untracked (added), 1 staged-add (added), 1 modified, 1 deleted
    const out = '?? a.txt\0A  b.txt\0 M c.txt\0 D d.txt\0';
    expect(parseGitPorcelain(out)).toEqual({
      filesChanged: 4,
      filesAdded: 2,
      filesDeleted: 1,
      sampleChanges: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
      fullDiffAvailable: true,
    });
  });

  test('sampleChanges is capped at SAMPLE_CHANGES_CAP', () => {
    expect(SAMPLE_CHANGES_CAP).toBe(10);
    const entries: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      entries.push(`?? file-${i}.txt`);
    }
    const out = entries.join('\0') + '\0';
    const result = parseGitPorcelain(out);
    expect(result.filesChanged).toBe(25);
    expect(result.filesAdded).toBe(25);
    expect(result.sampleChanges).toHaveLength(SAMPLE_CHANGES_CAP);
    // First 10 — order-preserving.
    expect(result.sampleChanges[0]).toBe('file-0.txt');
    expect(result.sampleChanges[9]).toBe('file-9.txt');
  });

  test('handles paths with spaces and unicode', () => {
    const out = '?? path with spaces.txt\0 M src/café/main.ts\0';
    const result = parseGitPorcelain(out);
    expect(result.filesChanged).toBe(2);
    expect(result.sampleChanges).toEqual(['path with spaces.txt', 'src/café/main.ts']);
  });

  test('malformed (too-short) entries are skipped without throwing', () => {
    // `??\0` is 2 chars — below our 3-char minimum. Should be ignored.
    const out = '?? real.txt\0??\0';
    expect(parseGitPorcelain(out).filesChanged).toBe(1);
  });

  test('AM (staged-add + worktree-modify) counts as added, not modified twice', () => {
    const out = 'AM file.txt\0';
    expect(parseGitPorcelain(out)).toMatchObject({
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
    });
  });
});

// Integration: only runs if git is available. The test will silently
// pass with no assertions if `git --version` fails (matches the
// helper's own behavior — non-git environments degrade rather than
// error). We DO assert the parsed shape when git IS available, so
// the dev/CI path that has git gets the full coverage.
const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const describeGit = GIT_AVAILABLE ? describe : describe.skip;

describeGit('computeWorkspaceDiff — integration (git available)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-workspace-diff-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('non-git directory → fullDiffAvailable:false, zeroed counts', async () => {
    // No `git init` — git status will fail.
    const result = await computeWorkspaceDiff(tmpRoot);
    expect(result.fullDiffAvailable).toBe(false);
    expect(result.filesChanged).toBe(0);
  });

  test('initialized but empty repo → clean tree, fullDiffAvailable:true', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    // Fresh init has no commits and no files — porcelain output is empty.
    const result = await computeWorkspaceDiff(tmpRoot);
    expect(result).toEqual({
      filesChanged: 0,
      filesAdded: 0,
      filesDeleted: 0,
      sampleChanges: [],
      fullDiffAvailable: true,
    });
  });

  test('dirty repo with untracked + modified + deleted', async () => {
    // Set up: init, commit one file, modify it, add an untracked, delete another.
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.email', 'test@cebab.test'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.name', 'cebab-test'], { cwd: tmpRoot });
    fs.writeFileSync(path.join(tmpRoot, 'kept.txt'), 'original\n');
    fs.writeFileSync(path.join(tmpRoot, 'will-delete.txt'), 'doomed\n');
    execFileSync('git', ['add', '.'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpRoot });

    // Modify, add untracked, delete.
    fs.writeFileSync(path.join(tmpRoot, 'kept.txt'), 'modified\n');
    fs.writeFileSync(path.join(tmpRoot, 'untracked.txt'), 'new\n');
    fs.rmSync(path.join(tmpRoot, 'will-delete.txt'));

    const result = await computeWorkspaceDiff(tmpRoot);
    expect(result.fullDiffAvailable).toBe(true);
    // 1 modified + 1 added + 1 deleted = 3 total
    expect(result.filesChanged).toBe(3);
    expect(result.filesAdded).toBe(1);
    expect(result.filesDeleted).toBe(1);
    // Sample paths include all three (order is git-defined; check set).
    expect(new Set(result.sampleChanges)).toEqual(
      new Set(['kept.txt', 'untracked.txt', 'will-delete.txt']),
    );
  });

  test('respects sample cap on a noisy workspace', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    for (let i = 0; i < 25; i += 1) {
      fs.writeFileSync(path.join(tmpRoot, `f-${i}.txt`), `${i}\n`);
    }
    const result = await computeWorkspaceDiff(tmpRoot);
    expect(result.filesChanged).toBe(25);
    expect(result.sampleChanges).toHaveLength(SAMPLE_CHANGES_CAP);
  });
});
