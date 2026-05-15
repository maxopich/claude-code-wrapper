import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import { getProjectBusState } from '../repo/multi_agent.js';
import {
  InstallError,
  chooseAgentName,
  installBusForProject,
  uninstallBusForProject,
} from './install.js';
import { isValidAgentName, slugifyAgentName } from './paths.js';

// ---- isolated fs + DB scaffolding ----

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  // Each test gets its own home + .cebab + project trees so writes don't
  // leak across tests or out to the real ~/.cebab.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bus-install-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb(); // make sure the next getDb() opens against the new path
  getDb(); // applies migrations including 005
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProject(name: string, relPath = name): number {
  const projectPath = path.join(tmpRoot, 'workspace', relPath);
  fs.mkdirSync(projectPath, { recursive: true });
  const row = upsertProject(name, projectPath);
  return row.id;
}

// ---- slug + name selection ----

describe('slugifyAgentName / isValidAgentName', () => {
  test('lowercases and replaces non-alphanumerics with single dashes', () => {
    expect(slugifyAgentName('Cebab')).toBe('cebab');
    expect(slugifyAgentName('Hello World')).toBe('hello-world');
    expect(slugifyAgentName('x@y#z')).toBe('x-y-z');
    expect(slugifyAgentName('  spaces  ')).toBe('spaces');
    expect(slugifyAgentName('agentic-grader')).toBe('agentic-grader');
    expect(slugifyAgentName('MyAgent2')).toBe('myagent2');
  });

  test('returns empty string for input with no alphanumerics', () => {
    expect(slugifyAgentName('###')).toBe('');
    expect(slugifyAgentName('   ')).toBe('');
    expect(slugifyAgentName('')).toBe('');
  });

  test('isValidAgentName accepts slugs, rejects junk', () => {
    expect(isValidAgentName('cebab')).toBe(true);
    expect(isValidAgentName('hello-world')).toBe(true);
    expect(isValidAgentName('agent-2')).toBe(true);
    expect(isValidAgentName('')).toBe(false);
    expect(isValidAgentName('-leading')).toBe(false);
    expect(isValidAgentName('trailing-')).toBe(false);
    expect(isValidAgentName('Has-Caps')).toBe(false);
    expect(isValidAgentName('has spaces')).toBe(false);
  });
});

describe('chooseAgentName', () => {
  test('returns the bare slug when free', () => {
    const id = makeProject('Helper');
    expect(chooseAgentName('Helper', id)).toBe('helper');
  });

  test('appends project id when the slug is taken by another project', async () => {
    // Different-case names that slugify to the same value collide on the
    // bus side — this is the realistic collision path chooseAgentName
    // handles. installBusForProject(idA) claims `grader` in the DB.
    const idA = makeProject('Grader', 'graderA');
    const idB = makeProject('GRADER', 'graderB');
    await installBusForProject(idA); // claims `grader`
    expect(chooseAgentName('GRADER', idB)).toBe(`grader-${idB}`);
  });

  test('falls back to agent-<id> when project name has no usable chars', () => {
    const id = makeProject('###', 'weird');
    expect(chooseAgentName('###', id)).toBe(`agent-${id}`);
  });

  test('falls back to <slug>-<id> when the slug is a reserved system name', () => {
    // Reserved set is {orchestrator, user, cebab}. A project named
    // "Orchestrator" must not become agent `orchestrator` — that's the
    // routing agent's reserved name.
    const idA = makeProject('Orchestrator', 'orchA');
    expect(chooseAgentName('Orchestrator', idA)).toBe(`orchestrator-${idA}`);

    const idB = makeProject('User', 'userB');
    expect(chooseAgentName('User', idB)).toBe(`user-${idB}`);

    const idC = makeProject('Cebab', 'cebabC');
    expect(chooseAgentName('Cebab', idC)).toBe(`cebab-${idC}`);
  });
});

// ---- install: pure metadata, zero project mutation ----

describe('installBusForProject — fresh install', () => {
  test('records the DB flag + agent name and does NOT touch the project tree', async () => {
    const id = makeProject('Evaluator');
    const projectPath = path.join(tmpRoot, 'workspace', 'Evaluator');
    const result = await installBusForProject(id);

    expect(result.agentName).toBe('evaluator');
    expect(result.busRow).toBe('inserted');

    // DB state flipped.
    const state = getProjectBusState(id);
    expect(state.installed).toBe(true);
    expect(state.agentName).toBe('evaluator');

    // The security/portability win: Cebab writes NOTHING into the
    // operator's project. No CLAUDE.md @import, no .claude/settings.json,
    // no .cebab/comm.md, no copied scripts. The bus protocol is delivered
    // via the per-turn briefing and the in-process bus_send tool instead.
    expect(fs.readdirSync(projectPath)).toEqual([]);
  });

  test('rejects when project row is missing', async () => {
    await expect(installBusForProject(999)).rejects.toBeInstanceOf(InstallError);
  });

  test('rejects when project directory is gone', async () => {
    const id = makeProject('Evaporated');
    fs.rmSync(path.join(tmpRoot, 'workspace', 'Evaporated'), { recursive: true });
    await expect(installBusForProject(id)).rejects.toThrow(/path no longer exists/);
  });
});

describe('installBusForProject — idempotency', () => {
  test('second install reports busRow:unchanged and still touches nothing', async () => {
    const id = makeProject('Evaluator');
    const projectPath = path.join(tmpRoot, 'workspace', 'Evaluator');
    const first = await installBusForProject(id);
    expect(first.busRow).toBe('inserted');

    const second = await installBusForProject(id);
    expect(second.agentName).toBe('evaluator');
    expect(second.busRow).toBe('unchanged');

    expect(fs.readdirSync(projectPath)).toEqual([]);
  });
});

// ---- uninstall ----

describe('uninstallBusForProject', () => {
  test('clears the DB flag; safe to call twice', async () => {
    const id = makeProject('Reviewer');
    await installBusForProject(id);

    const first = await uninstallBusForProject(id);
    expect(first.agentName).toBe('reviewer');
    expect(first.busRow).toBe('cleared');
    expect(getProjectBusState(id).installed).toBe(false);

    // Second uninstall is a no-op.
    const second = await uninstallBusForProject(id);
    expect(second.busRow).toBe('unchanged');
  });

  test('rejects when project row is missing', async () => {
    await expect(uninstallBusForProject(999)).rejects.toBeInstanceOf(InstallError);
  });

  test('reinstall after uninstall re-applies the same slug', async () => {
    const id = makeProject('Coder');
    await installBusForProject(id);
    await uninstallBusForProject(id);

    const again = await installBusForProject(id);
    expect(again.agentName).toBe('coder');
    expect(again.busRow).toBe('inserted');
    expect(getProjectBusState(id).installed).toBe(true);
  });
});
