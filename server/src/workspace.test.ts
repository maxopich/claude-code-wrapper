/**
 * Register H12 — what may become a workspace root.
 *
 * `setWorkspaceRoot` had no coverage at all, which is how it kept accepting
 * `/`. The stored root drives `syncWorkspaceProjects`, and that `upsertProject`s
 * every non-dot subdirectory — so the accepted value decides which directories
 * become agent projects, each one a `cwd` a session can be pointed at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { resolveWorkspaceRoot, setWorkspaceRoot } from './workspace.js';

withTempDataDir('cebab-workspace-');

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ws-root-'));
});

describe('setWorkspaceRoot accepts a real directory', () => {
  test('an existing directory is resolved and stored', () => {
    const nested = path.join(scratch, 'agents');
    fs.mkdirSync(nested);
    expect(setWorkspaceRoot(nested)).toBe(path.resolve(nested));
    expect(resolveWorkspaceRoot()).toBe(path.resolve(nested));
  });

  test('a deep path under home is fine — only the bare home directory is refused', () => {
    // The guard must not turn into "nothing under ~", which would reject the
    // documented `~/agents` shape it exists to protect.
    const under = path.join(scratch, 'code', 'agents');
    fs.mkdirSync(under, { recursive: true });
    expect(() => setWorkspaceRoot(under)).not.toThrow();
  });
});

describe('setWorkspaceRoot refuses what it cannot mean', () => {
  test('a missing path and a file are both refused', () => {
    expect(() => setWorkspaceRoot(path.join(scratch, 'nope'))).toThrow(/directory not found/);
    const file = path.join(scratch, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => setWorkspaceRoot(file)).toThrow(/not a directory/);
  });

  test('[security] a non-string is refused by type, not by a TypeError deep inside', () => {
    // This used to reach `expandHome`, where `p.startsWith('~')` threw — and
    // the WS handler reported that to the operator as the claude process
    // having crashed.
    for (const bad of [123, null, undefined, {}, [], true]) {
      expect(() => setWorkspaceRoot(bad as unknown as string), String(bad)).toThrow(
        /must be a string/,
      );
    }
    expect(() => setWorkspaceRoot('   ')).toThrow(/must not be empty/);
  });

  test('[security] the filesystem root is refused', () => {
    const root = path.parse(process.cwd()).root;
    expect(() => setWorkspaceRoot(root)).toThrow(/filesystem root/);
  });

  test('[security] the home directory itself is refused', () => {
    expect(() => setWorkspaceRoot(os.homedir())).toThrow(/home directory/);
    // `~` expands to the same place, and must be refused by the same rule
    // rather than sneaking past because the string differs.
    expect(() => setWorkspaceRoot('~')).toThrow(/home directory/);
  });

  test('[security] a refused root is not persisted', () => {
    const ok = path.join(scratch, 'agents');
    fs.mkdirSync(ok);
    setWorkspaceRoot(ok);
    expect(() => setWorkspaceRoot(os.homedir())).toThrow();
    // The throw must leave the previous good value in place — a half-applied
    // change here would silently repoint every future session's project scan.
    expect(resolveWorkspaceRoot()).toBe(path.resolve(ok));
  });

  test('[security] a symlink to home is refused as home', () => {
    // The refusals compare canonical paths, so an indirection cannot walk
    // past them. Skipped where symlink creation needs privileges (Windows
    // without Developer Mode).
    const link = path.join(scratch, 'home-link');
    try {
      fs.symlinkSync(os.homedir(), link, 'dir');
    } catch {
      return;
    }
    expect(() => setWorkspaceRoot(link)).toThrow(/home directory/);
  });
});
