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
import { findProjectByPath, listProjects, upsertProject } from './repo/projects.js';
import { getDb } from './db.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { config } from './config.js';
import {
  isInside,
  resolveWorkspaceRoot,
  setWorkspaceRoot,
  syncWorkspaceProjects,
} from './workspace.js';

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

/**
 * Register D16 — a duplicate basename must not take the scan down with it.
 *
 * `upsertProject` looks up by `path` but `projects.name` is UNIQUE, so two
 * directories sharing a basename under DIFFERENT roots collided on INSERT.
 * The throw was not a one-time abort: `syncWorkspaceProjects` runs on every
 * `list_projects`, so it re-hit the same row on every sidebar refresh and the
 * operator got a permanently empty sidebar. The trigger is a supported action
 * — repointing the workspace root, whose old rows keep their names.
 */
describe('syncWorkspaceProjects survives a colliding basename', () => {
  test('a repointed root with a colliding basename still registers the project', async () => {
    const oldPath = path.join(scratch, 'old-root', 'Cebab');
    upsertProject('Cebab', oldPath); // the row the previous root left behind

    const newRoot = path.join(scratch, 'new-root');
    fs.mkdirSync(path.join(newRoot, 'Cebab'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();

    const fresh = findProjectByPath(path.join(newRoot, 'Cebab'));
    expect(fresh, 'the colliding directory must still become a project').toBeDefined();
    expect(fresh!.name).toBe('Cebab (2)');
    expect(listProjects().map((p) => p.name)).toContain('Cebab (2)');
  });

  test('the disambiguated name is stable across rescans', async () => {
    const oldPath = path.join(scratch, 'old-root', 'Cebab');
    upsertProject('Cebab', oldPath);

    const newRoot = path.join(scratch, 'new-root');
    fs.mkdirSync(path.join(newRoot, 'Cebab'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();
    await syncWorkspaceProjects();
    await syncWorkspaceProjects();

    // Path lookup runs before the insert, so a rescan finds the row and never
    // re-derives its name — no `Cebab (3)`, no second row.
    expect(findProjectByPath(path.join(newRoot, 'Cebab'))!.name).toBe('Cebab (2)');
    expect(listProjects().filter((p) => p.name.startsWith('Cebab'))).toHaveLength(1);
  });

  test('the collision does not stop the rest of the scan', async () => {
    const goneRoot = path.join(scratch, 'old-root');
    upsertProject('Cebab', path.join(goneRoot, 'Cebab'));
    upsertProject('Vanished', path.join(goneRoot, 'Vanished'));

    const newRoot = path.join(scratch, 'new-root');
    // `Alpha` sorts before `Cebab`, `Zulu` after — so a scan that aborts on
    // the collision is distinguishable from one that never started.
    for (const d of ['Alpha', 'Cebab', 'Zulu']) {
      fs.mkdirSync(path.join(newRoot, d), { recursive: true });
    }
    setWorkspaceRoot(newRoot);

    const rows = await syncWorkspaceProjects();

    const names = rows.map((p) => p.name).sort();
    expect(names).toEqual(['Alpha', 'Cebab (2)', 'Zulu']);
    // `markProjectsMissingByPaths` runs AFTER the loop, so this also proves
    // the loop completed rather than throwing partway.
    expect(findProjectByPath(path.join(goneRoot, 'Vanished'))!.missing).toBe(1);
  });

  test('a non-colliding basename is untouched by the disambiguation path', async () => {
    const newRoot = path.join(scratch, 'plain-root');
    fs.mkdirSync(path.join(newRoot, 'Solo'), { recursive: true });
    setWorkspaceRoot(newRoot);

    await syncWorkspaceProjects();

    // Control: the fix must not append a suffix to every project.
    expect(findProjectByPath(path.join(newRoot, 'Solo'))!.name).toBe('Solo');
  });
});

/**
 * Cebab-ws0.8 — "on the side panel, the user should see only the workspace."
 *
 * Since ws0.8 the data dir also holds `sessions/`, one subtree per multi-agent
 * session. Pointing the workspace at `~/.cebab` was accepted BEFORE this change
 * too — it would have turned `logs`, `bus` and `orchestrator` into agent
 * projects, each one a cwd a session could be pointed at. The move makes that
 * pre-existing hole sharper, so it gets closed here.
 */
describe('the data dir may not become the workspace (ws0.8)', () => {
  test('the data dir itself is refused, and the message says why', () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    expect(() => setWorkspaceRoot(config.dataDir)).toThrow(/data directory/i);
  });

  test('a directory inside the data dir is refused', () => {
    const inside = path.join(config.dataDir, 'sessions');
    fs.mkdirSync(inside, { recursive: true });
    expect(() => setWorkspaceRoot(inside)).toThrow(/data directory/i);
  });

  /**
   * THE negative. A `startsWith` implementation passes every other case in this
   * describe, and would refuse a perfectly ordinary sibling directory whose name
   * merely begins with the data dir's — leaving an operator unable to use their
   * own folder with an error blaming Cebab's.
   */
  test('a SIBLING whose name merely starts the same is accepted', () => {
    const sibling = `${config.dataDir}-projects`;
    fs.mkdirSync(sibling, { recursive: true });
    expect(() => setWorkspaceRoot(sibling)).not.toThrow();
  });

  test('control: an ordinary directory is still accepted', () => {
    // Green before AND after. Labelled so it is not mistaken for coverage.
    const ordinary = path.join(scratch, 'agents-ok');
    fs.mkdirSync(ordinary, { recursive: true });
    expect(() => setWorkspaceRoot(ordinary)).not.toThrow();
  });

  test('a non-dot data dir nested in the workspace is not scanned as a project', async () => {
    // The case `setWorkspaceRoot` cannot catch: the data dir is fixed at process
    // start, so the workspace can be re-pointed to swallow it afterwards. The
    // dot filter misses it too, because the name has no dot.
    const root = path.join(scratch, 'ws-nested');
    fs.mkdirSync(path.join(root, 'RealAgent'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cebab-data', 'sessions'), { recursive: true });
    config.dataDir = path.join(root, 'cebab-data');
    setWorkspaceRoot(root);

    await syncWorkspaceProjects();
    const names = listProjects().map((p) => p.name);
    expect(names).toContain('RealAgent');
    expect(names).not.toContain('cebab-data');
  });

  test('a sibling non-dot directory IS still scanned', async () => {
    // Pairs with the case above: without this, a filter that dropped every
    // non-dot directory would pass it.
    const root = path.join(scratch, 'ws-sibling');
    fs.mkdirSync(path.join(root, 'cebab-data-notes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cebab-data'), { recursive: true });
    config.dataDir = path.join(root, 'cebab-data');
    setWorkspaceRoot(root);

    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.name)).toContain('cebab-data-notes');
  });
});

/**
 * `isInside` on BOTH platform flavours.
 *
 * The operator runs Windows and CI runs Linux and Windows, but a developer
 * running these on macOS would otherwise never exercise the win32 branch at
 * all. Driving `path.win32` explicitly is what makes the Windows behaviour
 * testable from any host — the alternative is a guard whose Windows semantics
 * are only ever checked by the one CI leg that happens to run there.
 */
describe('isInside — the containment predicate (ws0.8)', () => {
  for (const [label, impl, root, inside, sibling, outside] of [
    [
      'posix',
      path.posix,
      '/home/u/.cebab',
      '/home/u/.cebab/sessions/a',
      '/home/u/.cebabX',
      '/home/u/agents',
    ],
    [
      'win32',
      path.win32,
      'C:\\Users\\u\\.cebab',
      'C:\\Users\\u\\.cebab\\sessions\\a',
      'C:\\Users\\u\\.cebabX',
      'C:\\Users\\u\\agents',
    ],
  ] as const) {
    describe(label, () => {
      test('a real child is inside', () => {
        expect(isInside(root, inside, impl)).toBe(true);
      });

      test('a prefix-sharing SIBLING is not inside — the startsWith trap', () => {
        expect(isInside(root, sibling, impl)).toBe(false);
      });

      test('an unrelated path is not inside', () => {
        expect(isInside(root, outside, impl)).toBe(false);
      });

      test('a path is not inside itself', () => {
        expect(isInside(root, root, impl)).toBe(false);
      });

      test('the parent is not inside its own child', () => {
        expect(isInside(inside, root, impl)).toBe(false);
      });
    });
  }

  test('a directory literally named `..foo` is inside, not an escape', () => {
    // A bare `rel.startsWith('..')` rejects this. Naming `path.sep` in the
    // predicate is what keeps it legal.
    expect(isInside(path.posix.join('/a'), path.posix.join('/a', '..foo'), path.posix)).toBe(true);
  });
});

describe('managed agents survive the missing-sweep (ws0.9)', () => {
  /**
   * The way this feature ships broken. `syncWorkspaceProjects` soft-deletes any
   * row whose path the workspace scan did not see, and a managed agent's path
   * — inside Cebab's data dir — is never in that scan. Without the exemption
   * every managed agent is marked missing on the very next `list_projects`,
   * which fires on every sidebar refresh. Silently, and for all of them at once.
   *
   * Both directions are tested because each failure looks like the feature
   * working: forget the exemption and managed agents vanish; write it as a
   * blanket "skip managed rows" and a managed agent whose directory the
   * operator deleted lingers forever as a project pointing at nothing.
   */
  function managedProject(name: string): { id: number; dir: string } {
    const dir = path.join(config.dataDir, 'agents', name);
    fs.mkdirSync(dir, { recursive: true });
    const row = upsertProject(name, dir);
    getDb()
      .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = 1 WHERE id = ?')
      .run('/somewhere', row.id);
    return { id: row.id, dir };
  }

  beforeEach(() => {
    const wsRoot = path.join(scratch, 'agents');
    fs.mkdirSync(wsRoot, { recursive: true });
    setWorkspaceRoot(wsRoot);
  });

  test('a managed agent is NOT marked missing by a workspace scan', async () => {
    const managed = managedProject('kept');
    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).toContain(managed.id);
  });

  test('it survives repeated scans, not just the first', async () => {
    // The sweep runs on every sidebar refresh; a one-shot exemption would pass
    // the case above and fail the operator on their second click.
    const managed = managedProject('persistent');
    for (let i = 0; i < 3; i++) await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).toContain(managed.id);
  });

  test('a managed agent whose directory was deleted by hand IS marked missing', async () => {
    const managed = managedProject('deleted');
    fs.rmSync(managed.dir, { recursive: true, force: true });
    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).not.toContain(managed.id);
  });

  test('[security] a hand-edited provenance column buys a workspace project no exemption', async () => {
    // The row is OUTSIDE the workspace root and its directory still EXISTS —
    // the ordinary state of a project left behind when the operator repoints
    // the workspace. The sweep must reach it.
    //
    // Both halves matter. Deleting the directory instead would let this pass
    // even if the exemption were keyed on the column, because the existence
    // check would sweep it anyway; that version of this test was written first
    // and did not redden when the predicate was mutated to read the column.
    const stale = path.join(scratch, 'elsewhere', 'left-behind');
    fs.mkdirSync(stale, { recursive: true });
    const row = upsertProject('left-behind', stale);
    getDb()
      .prepare('UPDATE projects SET managed_source_path = ?, managed_copied_at = 1 WHERE id = ?')
      .run('/pretend', row.id);

    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).not.toContain(row.id);
  });

  test('a real managed agent in the same position is NOT swept', async () => {
    // The positive control for the case above, and the pair that pins WHICH
    // question the exemption asks. Both rows sit outside the workspace scan
    // with a live directory and a populated provenance column; the only thing
    // separating them is where the directory is.
    const managed = managedProject('genuine');
    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).toContain(managed.id);
  });

  test('control: an ordinary workspace project still goes missing when deleted', async () => {
    // Anti-vacuity for the two negatives above — an exemption wide enough to
    // cover everything would make them pass by never sweeping at all.
    const dir = path.join(scratch, 'agents', 'ordinary');
    fs.mkdirSync(dir, { recursive: true });
    await syncWorkspaceProjects();
    const row = findProjectByPath(dir)!;
    expect(listProjects().map((p) => p.id)).toContain(row.id);

    fs.rmSync(dir, { recursive: true, force: true });
    await syncWorkspaceProjects();
    expect(listProjects().map((p) => p.id)).not.toContain(row.id);
  });

  test('a managed agent appears exactly once, not also as a workspace project', async () => {
    // The bead's "not double-listed" criterion. Today the data dir sits outside
    // the workspace so the scan cannot reach it, and what this really pins is
    // that the exemption adds the row back once rather than twice.
    managedProject('inner');
    await syncWorkspaceProjects();
    expect(listProjects().filter((p) => p.name === 'inner')).toHaveLength(1);
  });
});
