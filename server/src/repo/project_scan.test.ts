import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { scanProject, scanProjects } from './project_scan.js';
import { setProjectTrusted, upsertProject, type ProjectRow } from './projects.js';

/**
 * Cebab-ws0.6 — the file-scan tier.
 *
 * Every case here turns on one distinction: DECLARED on disk vs LOADED by this
 * project's current scope set. That is the whole reason the scan exists — an
 * untrusted project declaring an MCP server in `.mcp.json` was, before this,
 * indistinguishable from a project declaring nothing at all.
 *
 * HOME is redirected for every test, and there is a guard assertion that the
 * redirect took. Without it the user-scope layer reads the developer's real
 * `~/.claude/settings.json` and every count below becomes a property of whose
 * machine ran the suite — passing on CI, failing locally, or the reverse.
 */

let tmpRoot: string;
let originalDataDir: string;

const HOME_VARS = ['HOME', 'USERPROFILE'] as const;
let originalHome: Partial<Record<(typeof HOME_VARS)[number], string | undefined>> = {};

function redirectHome(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  originalHome = {};
  for (const v of HOME_VARS) {
    originalHome[v] = process.env[v];
    process.env[v] = dir;
  }
}

function restoreHome(): void {
  for (const v of HOME_VARS) {
    const prev = originalHome[v];
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
}

/** Windows temp dirs come back as 8.3 short names from one API and long from another. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return path.resolve(real(a)) === path.resolve(real(b));
}

/** Create a project directory + DB row. Untrusted unless told otherwise. */
function makeProject(name: string, trusted = false): ProjectRow {
  const projectPath = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
  const row = upsertProject(name, projectPath);
  if (trusted) setProjectTrusted(row.id, true);
  // Re-read so `trusted` reflects the write.
  return { ...row, trusted: trusted ? 1 : 0 };
}

function write(p: string, body: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-pscan-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  redirectHome(path.join(tmpRoot, 'home'));
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  restoreHome();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('project_scan — the isolation this file depends on', () => {
  test('the HOME redirect actually took, on this platform', () => {
    // The guard, not a formality: `os.homedir()` reads $HOME on POSIX and
    // %USERPROFILE% on Windows, and setting only the first redirects nothing
    // on the Windows runner. Every count assertion below is meaningless if
    // this fails, so it fails loudly and first.
    expect(samePath(os.homedir(), path.join(tmpRoot, 'home'))).toBe(true);
  });

  test('the user-scope settings layer follows the redirected home', () => {
    // Not a formality either. `~/.claude/settings.json` used to be resolved
    // into a module-level const at import, before any test could point HOME
    // somewhere empty — so this one layer silently read the DEVELOPER'S real
    // settings while every sibling reader followed the redirect. The counts in
    // this file would then have been a property of whose machine ran them,
    // and the file would still have looked green on a machine with an empty
    // `~/.claude/settings.json`. Asserting a fixture is READ is the only
    // version of this that fails the same way everywhere.
    write(path.join(os.homedir(), '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/bin/echo user' }] }] },
    });
    const scan = scanProject(makeProject('userlayer'));
    expect(scan.hooks).toEqual({ declared: 1, loaded: 1, hasLocalScope: false });
  });

  test('a project with nothing on disk declares nothing, and is not degraded', () => {
    // The control for every case below. If this ever stops being empty, the
    // isolation has broken and the other assertions are measuring the
    // developer's machine.
    const scan = scanProject(makeProject('bare'));
    expect(scan.mcpServers).toEqual([]);
    expect(scan.hooks).toEqual({ declared: 0, loaded: 0, hasLocalScope: false });
    expect(scan.envInjections).toEqual({ declared: 0, loaded: 0 });
    expect(scan.degraded).toBe(false);
  });
});

describe('project_scan — declared vs loaded (Cebab-ws0.6)', () => {
  test('an UNTRUSTED project reports its .mcp.json server, marked as not loading', () => {
    // The case the epic was reported for. `readMcpJsonServers` returns [] when
    // the scope set excludes 'project', so before this the declaration was not
    // merely inactive — it was invisible.
    const row = makeProject('untrusted');
    write(path.join(row.path, '.mcp.json'), { mcpServers: { reporter: { command: 'npx' } } });

    const scan = scanProject(row);
    expect(scan.scopesLoaded).toEqual(['user']);
    expect(scan.mcpServers).toEqual([
      { name: 'reporter', loads: false, originPath: path.join(row.path, '.mcp.json') },
    ]);
  });

  test('the same declaration on a TRUSTED project loads', () => {
    const row = makeProject('trusted', true);
    write(path.join(row.path, '.mcp.json'), { mcpServers: { reporter: { command: 'npx' } } });

    const scan = scanProject(row);
    expect(scan.scopesLoaded).toEqual(['user', 'project', 'local']);
    expect(scan.mcpServers.map((s) => [s.name, s.loads])).toEqual([['reporter', true]]);
  });

  test('a ~/.claude.json top-level server loads even on an untrusted project', () => {
    // The one thing Trust demonstrably does NOT stop. Painting this as inert
    // would be wrong in the dangerous direction.
    const row = makeProject('homeserver');
    write(path.join(os.homedir(), '.claude.json'), {
      mcpServers: { fromHome: { command: 'npx' } },
    });

    const scan = scanProject(row);
    expect(scan.mcpServers.map((s) => [s.name, s.loads])).toEqual([['fromHome', true]]);
  });

  test('a ~/.claude.json per-project server does NOT load on an untrusted project', () => {
    const row = makeProject('homeproj');
    write(path.join(os.homedir(), '.claude.json'), {
      projects: {
        [fs.realpathSync(path.join(tmpRoot, 'homeproj'))]: {
          mcpServers: { perProject: { command: 'npx' } },
        },
      },
    });

    const scan = scanProject(row);
    expect(scan.mcpServers.map((s) => [s.name, s.loads])).toEqual([['perProject', false]]);
  });

  test('hooks split declared vs loaded, and a local-scope hook is flagged', () => {
    const row = makeProject('hooky');
    write(path.join(row.path, '.claude', 'settings.json'), {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/bin/echo project' }] }] },
    });
    write(path.join(row.path, '.claude', 'settings.local.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/bin/echo local' }] }] },
    });

    const untrusted = scanProject(row);
    expect(untrusted.hooks).toEqual({ declared: 2, loaded: 0, hasLocalScope: true });

    setProjectTrusted(row.id, true);
    const trusted = scanProject({ ...row, trusted: 1 });
    expect(trusted.hooks).toEqual({ declared: 2, loaded: 2, hasLocalScope: true });
  });

  test('env injections are counted, declared vs loaded', () => {
    const row = makeProject('envy');
    write(path.join(row.path, '.claude', 'settings.json'), {
      env: { ANTHROPIC_API_KEY: 'irrelevant-here', SOME_OTHER: 'x' },
    });

    const untrusted = scanProject(row);
    expect(untrusted.envInjections.declared).toBeGreaterThan(0);
    expect(untrusted.envInjections.loaded).toBe(0);

    const trusted = scanProject({ ...row, trusted: 1 });
    expect(trusted.envInjections.loaded).toBe(trusted.envInjections.declared);
  });
});

describe('project_scan — degradation', () => {
  test('an unreadable settings file degrades that project and no other', () => {
    const broken = makeProject('broken');
    const healthy = makeProject('healthy');
    // A DIRECTORY where a settings file belongs: `readTextBounded` refuses
    // non-regular files, so the reader returns null exactly as it would for an
    // absent file — which is what makes "declares nothing" a lie here.
    fs.mkdirSync(path.join(broken.path, '.claude', 'settings.json'), { recursive: true });

    const scans = scanProjects([broken, healthy]);
    expect(scans.map((s) => [s.projectId, s.degraded])).toEqual([
      [broken.id, true],
      [healthy.id, false],
    ]);
  });

  test('malformed JSON in a settings file degrades, rather than reading as empty', () => {
    const row = makeProject('malformed');
    write(path.join(row.path, '.claude', 'settings.json'), '{ this is not json');
    expect(scanProject(row).degraded).toBe(true);
  });

  test('a malformed .mcp.json degrades even though the reader returns no servers', () => {
    // The reader collapses absent / refused / malformed / valid-but-empty into
    // the same `[]`. Without the extra probe this project would claim to
    // declare nothing.
    const row = makeProject('badmcp');
    write(path.join(row.path, '.mcp.json'), '{ nope');
    const scan = scanProject(row);
    expect(scan.mcpServers).toEqual([]);
    expect(scan.degraded).toBe(true);
  });

  test('a VALID .mcp.json declaring no servers is not degraded', () => {
    // The negative control for the case above: if this reddens, the probe is
    // reporting every empty file as broken and `degraded` means nothing.
    const row = makeProject('emptymcp');
    write(path.join(row.path, '.mcp.json'), { mcpServers: {} });
    const scan = scanProject(row);
    expect(scan.mcpServers).toEqual([]);
    expect(scan.degraded).toBe(false);
  });
});

describe('project_scan — the pass', () => {
  test('one timestamp for the whole pass, one scan per row, matched by id', () => {
    const rows = [makeProject('a'), makeProject('b'), makeProject('c')];
    const scans = scanProjects(rows);
    expect(scans.map((s) => s.projectId)).toEqual(rows.map((r) => r.id));
    expect(new Set(scans.map((s) => s.scannedAt)).size).toBe(1);
  });

  test('the pass issues ZERO database statements', () => {
    // The sharpest of the three exclusions this tier is built on, and the only
    // one whose cost is unbounded. `tallyToolUsage` walks every event row of
    // every session of the project; `enrichWithTrustState` runs three queries
    // per declared MCP server; `getProject` is a point read. All three are
    // database work, so "zero statements" excludes the whole family at once —
    // and, unlike a read count or a timer, it cannot be satisfied by a project
    // that merely happens to have a short history.
    //
    // The failure this exists to catch is a future edit reaching for
    // `resolveProjectAuthority` because it answers a superset of the question.
    // It does, at a cost that scales with how long the operator has used the
    // project, on a path that runs at every app start and every trust toggle.
    const rows = [makeProject('q1'), makeProject('q2')];
    const db = getDb() as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(db);
    let statements = 0;
    db.prepare = (sql: string) => {
      statements += 1;
      return original(sql);
    };
    try {
      scanProjects(rows);
    } finally {
      db.prepare = original;
    }
    expect(statements).toBe(0);
  });

  test('file reads stay bounded per project — they do not scale with anything else', () => {
    // MEASURED on this design: 21 projects, a 124 KB `~/.claude.json`, half of
    // them declaring an MCP server and a hook = 131 opens, 6.24 per project,
    // 3.98 ms for the whole pass. That number is why the obvious optimisation
    // (read the two home-directory files once per pass and share them) was NOT
    // built: it would mean changing reader signatures inside a
    // security-sensitive module to save single-digit milliseconds.
    //
    // The ceiling is the worst case per project — user + project + local
    // settings, `.mcp.json` and its unreadable-probe, and `~/.claude.json`
    // twice (once for what loads, once for what is declared) — plus headroom.
    // What reddens it: a per-project binary hash, an extra declaration file,
    // or the shared-read refactor silently reverting.
    const rows = Array.from({ length: 6 }, (_, i) => makeProject(`budget${i}`));
    for (const row of rows) {
      write(path.join(row.path, '.mcp.json'), { mcpServers: { s: { command: 'npx' } } });
    }
    const originalOpen = fs.openSync;
    let opens = 0;
    (fs as unknown as { openSync: unknown }).openSync = (...args: unknown[]) => {
      opens += 1;
      return (originalOpen as unknown as (...a: unknown[]) => number)(...args);
    };
    try {
      scanProjects(rows);
    } finally {
      (fs as unknown as { openSync: unknown }).openSync = originalOpen;
    }
    expect(opens).toBeLessThanOrEqual(8 * rows.length);
    // Anti-vacuity: if the scan somehow read nothing at all, the ceiling above
    // would pass while measuring an empty pass.
    expect(opens).toBeGreaterThanOrEqual(rows.length);
  });

  test('[security] scanProjects is synchronous, so it cannot await a spawn', () => {
    // The mechanical form of "the file-scan tier spawns nothing". An import
    // list cannot prove it — this module reaches the SDK transitively, as
    // `project_authority.ts` does. A synchronous return value can: every spawn
    // path in this codebase is async, so a function that has already returned
    // a plain array never waited on one.
    const out: unknown = scanProjects([makeProject('sync')]);
    expect(Array.isArray(out)).toBe(true);
    expect(typeof (out as { then?: unknown }).then).toBe('undefined');
  });
});
