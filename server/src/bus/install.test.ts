import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import {
  InstallError,
  chooseAgentName,
  installBusForProject,
  uninstallBusForProject,
} from './install.js';
import {
  busBinDir,
  busRoot,
  isValidAgentName,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
  slugifyAgentName,
} from './paths.js';

// ---- isolated fs + DB scaffolding ----

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  // Each test gets its own home + .cebab + project trees so writes don't
  // leak across tests or out to the real ~/.cebab.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bus-install-'));
  originalDataDir = config.dataDir;
  // Override config.dataDir to a tmp subdir. The DB / bus paths derive from
  // this on every call, so subsequent reads of config.dbPath / busRoot()
  // pick up the override automatically.
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
  // Create the project's on-disk directory under tmpRoot so install can
  // append to its CLAUDE.md and .claude/settings.json safely.
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
    // Note: 'Cebab' would slugify to a reserved sentinel — see the
    // reserved-name test below. Use any non-reserved name here.
    const id = makeProject('Helper');
    expect(chooseAgentName('Helper', id)).toBe('helper');
  });

  test('appends project id when the slug is taken by another project', async () => {
    // The DB has UNIQUE on projects.name, but different-case names that
    // slugify to the same value collide on the bus side — this is the
    // realistic collision path we want chooseAgentName to handle.
    const idA = makeProject('Grader', 'graderA');
    const idB = makeProject('GRADER', 'graderB');
    await installBusForProject(idA); // claims `grader`
    expect(chooseAgentName('GRADER', idB)).toBe(`grader-${idB}`);
  });

  test('throws agent_name_empty when project name has no usable chars', () => {
    const id = makeProject('###', 'weird');
    // For an all-symbol name, slug is empty so we fall back to agent-<id>.
    // Verify the fallback is what we get rather than a throw.
    expect(chooseAgentName('###', id)).toBe(`agent-${id}`);
  });

  test('falls back to <slug>-<id> when the slug is a reserved system name', () => {
    // Reserved set is {orchestrator, user, cebab}. A project named
    // "Orchestrator" must not be installed as agent `orchestrator` —
    // that's the routing agent's name and shadowing it would scramble
    // PR 5's intercept logic.
    const idA = makeProject('Orchestrator', 'orchA');
    expect(chooseAgentName('Orchestrator', idA)).toBe(`orchestrator-${idA}`);

    const idB = makeProject('User', 'userB');
    expect(chooseAgentName('User', idB)).toBe(`user-${idB}`);

    const idC = makeProject('Cebab', 'cebabC');
    expect(chooseAgentName('Cebab', idC)).toBe(`cebab-${idC}`);
  });
});

// ---- install: first-run side effects ----

describe('installBusForProject — fresh install', () => {
  test('creates bus directory layout, comm.md, CLAUDE.md @import, and settings.json', async () => {
    const id = makeProject('Evaluator');
    const result = await installBusForProject(id);

    expect(result.agentName).toBe('evaluator');
    expect(result.changes.busRow).toBe('inserted');

    // Bus root bootstrap — stable global state only (post-007). The
    // inbox/archive/bus.log live per-session under
    // `<workspace>/.cebab-session-<id>/` and are NOT pre-created here.
    expect(fs.existsSync(busRoot())).toBe(true);
    expect(fs.existsSync(busBinDir())).toBe(true);
    for (const name of ['bus-send-msg.sh', 'bus-check-inbox.sh', 'bus-status.sh']) {
      const p = path.join(busBinDir(), name);
      expect(fs.existsSync(p)).toBe(true);
      // chmod 0755 means owner has +x.
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    }

    // Per-project comm.md lives inside the project's `.cebab/` dir (so
    // the @import line below is project-relative, avoiding claude-code's
    // external-import trust modal).
    const projectPath = path.join(tmpRoot, 'workspace', 'Evaluator');
    expect(fs.existsSync(projectCommMdPath(projectPath))).toBe(true);
    const comm = fs.readFileSync(projectCommMdPath(projectPath), 'utf8');
    expect(comm).toContain('agent: `evaluator`');

    // CLAUDE.md has our project-relative @import line. Also: no absolute
    // path in the line — that would be the legacy external import.
    const claudeMd = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(`@${PROJECT_COMM_MD_REL}`);
    expect(claudeMd).not.toMatch(/@\/.*\.cebab\/bus\/agents\//);

    // settings.json has our env, permissions, and Stop hook.
    const settings = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.env.BUS_AGENT_NAME).toBe('evaluator');
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bus-send-msg.sh'),
        expect.stringContaining('bus-check-inbox.sh'),
        expect.stringContaining('bus-status.sh'),
      ]),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('bus-check-inbox.sh evaluator');
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

// ---- install: idempotency and content preservation ----

describe('installBusForProject — idempotency and non-destruction', () => {
  test('second install reports already-present changes and does not duplicate entries', async () => {
    const id = makeProject('Evaluator');
    await installBusForProject(id);
    const second = await installBusForProject(id);

    expect(second.changes.claudeMd).toBe('already-present');
    expect(second.changes.settingsJson).toBe('already-present');
    expect(second.changes.busRow).toBe('unchanged');

    // No duplicated @import lines. Count via split rather than a
    // dynamically-constructed RegExp — the regex form needs metachar
    // escaping that's easy to get partly-right (incomplete-sanitization).
    const projectPath = path.join(tmpRoot, 'workspace', 'Evaluator');
    const claudeMd = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    const importOccurrences = claudeMd.split(`@${PROJECT_COMM_MD_REL}`).length - 1;
    expect(importOccurrences).toBe(1);

    // No duplicated Stop hooks or permission entries.
    const settings = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    const allowEntries = settings.permissions.allow.filter((p: string) =>
      p.includes('bus-send-msg.sh'),
    );
    expect(allowEntries).toHaveLength(1);
  });

  test('preserves pre-existing CLAUDE.md content verbatim', async () => {
    const id = makeProject('WithMd');
    const projectPath = path.join(tmpRoot, 'workspace', 'WithMd');
    const original = '# Project rules\n\nDo not delete the foo table.\n';
    fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), original);

    await installBusForProject(id);

    const after = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    // Operator content present unchanged.
    expect(after).toContain('# Project rules');
    expect(after).toContain('Do not delete the foo table.');
    // Our import was appended at the end (project-relative), not interspersed.
    expect(after.endsWith(`@${PROJECT_COMM_MD_REL}\n`)).toBe(true);
  });

  test('preserves operator .claude/settings.json content across install + uninstall', async () => {
    const id = makeProject('WithSettings');
    const projectPath = path.join(tmpRoot, 'workspace', 'WithSettings');
    const claudeDir = path.join(projectPath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const operatorSettings = {
      env: { OPERATOR_VAR: 'keep' },
      permissions: {
        allow: ['Bash(echo:*)'],
        deny: ['Bash(rm -rf:*)'],
      },
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/operator-hook.sh' }] },
        ],
      },
      somethingElse: { foo: 'bar' },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(operatorSettings, null, 2),
    );

    await installBusForProject(id);
    let after = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));

    // Operator additions all preserved.
    expect(after.env.OPERATOR_VAR).toBe('keep');
    expect(after.permissions.allow).toContain('Bash(echo:*)');
    expect(after.permissions.deny).toEqual(['Bash(rm -rf:*)']);
    expect(after.somethingElse).toEqual({ foo: 'bar' });
    // Operator Stop hook still present, alongside ours.
    expect(after.hooks.Stop).toHaveLength(2);
    expect(
      after.hooks.Stop.some((e: { hooks: { command: string }[] }) =>
        e.hooks.some((h) => h.command === '/usr/local/bin/operator-hook.sh'),
      ),
    ).toBe(true);

    await uninstallBusForProject(id);
    after = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));

    // After uninstall: every operator addition still present, all of ours gone.
    expect(after.env.OPERATOR_VAR).toBe('keep');
    expect(after.env.BUS_AGENT_NAME).toBeUndefined();
    expect(after.permissions.allow).toEqual(['Bash(echo:*)']);
    expect(after.permissions.deny).toEqual(['Bash(rm -rf:*)']);
    expect(after.somethingElse).toEqual({ foo: 'bar' });
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe('/usr/local/bin/operator-hook.sh');
  });
});

// ---- uninstall ----

describe('uninstallBusForProject', () => {
  test('removes our additions; safe to call twice', async () => {
    const id = makeProject('Reviewer');
    await installBusForProject(id);

    const first = await uninstallBusForProject(id);
    expect(first.agentName).toBe('reviewer');
    expect(first.changes.claudeMd).toBe('removed');
    expect(first.changes.settingsJson).toBe('cleaned');
    expect(first.changes.busRow).toBe('cleared');

    // Second uninstall is a no-op everywhere. After the first uninstall the
    // project row has bus_installed=0 and bus_agent_name=NULL, so we no longer
    // know which entries belong to us — uninstallBusForProject skips the file
    // block entirely. Both file fields stay at their `'absent'` defaults.
    const second = await uninstallBusForProject(id);
    expect(second.changes.claudeMd).toBe('absent');
    expect(second.changes.settingsJson).toBe('absent');
    expect(second.changes.busRow).toBe('unchanged');
  });

  test('reinstall after uninstall works and re-applies the slug', async () => {
    const id = makeProject('Coder');
    await installBusForProject(id);
    await uninstallBusForProject(id);

    const again = await installBusForProject(id);
    expect(again.agentName).toBe('coder');
    expect(again.changes.busRow).toBe('inserted');

    // The CLAUDE.md @import line is present exactly once after the
    // round trip. (Same `split`-based count as the duplicate-prevention
    // test above; avoids the brittle regex-escape pattern that CodeQL
    // flagged as incomplete sanitization.)
    const projectPath = path.join(tmpRoot, 'workspace', 'Coder');
    const claudeMd = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    const importOccurrences = claudeMd.split(`@${PROJECT_COMM_MD_REL}`).length - 1;
    expect(importOccurrences).toBe(1);
  });
});

// ---- migration from legacy install layout (pre external-import fix) ----

describe('installBusForProject — migration from legacy external @import', () => {
  test('re-install over a legacy absolute @import line rewrites it to relative', async () => {
    // Stage a pre-fix install on disk: the project has the legacy
    // absolute @import line in CLAUDE.md, and a comm.md sitting at the
    // old `~/.cebab/bus/agents/<slug>/` global location. This is what a
    // build before the trust-modal fix would have left behind.
    const id = makeProject('Migratee');
    const projectPath = path.join(tmpRoot, 'workspace', 'Migratee');

    // Build the legacy comm.md path by hand — paths.ts no longer exports
    // it, since the new install path is per-project.
    const legacyAgentDir = path.join(busRoot(), 'agents', 'migratee');
    fs.mkdirSync(legacyAgentDir, { recursive: true });
    const legacyComm = path.join(legacyAgentDir, 'comm.md');
    fs.writeFileSync(legacyComm, '# stale legacy content\n');

    // Operator's CLAUDE.md, with the legacy absolute @import line.
    const legacyImportLine = `@${legacyComm}`;
    fs.writeFileSync(
      path.join(projectPath, 'CLAUDE.md'),
      `# Project rules\n\nKeep the data dir tidy.\n\n${legacyImportLine}\n`,
    );

    // Now install — this is the "operator clicked Install again to migrate" path.
    const result = await installBusForProject(id);
    expect(result.agentName).toBe('migratee');

    const claudeMd = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
    // Legacy absolute line is gone.
    expect(claudeMd).not.toContain(legacyImportLine);
    // New project-relative line is in.
    expect(claudeMd).toContain(`@${PROJECT_COMM_MD_REL}`);
    // Operator content untouched.
    expect(claudeMd).toContain('Keep the data dir tidy.');

    // Project-local comm.md exists; legacy global comm.md file got
    // cleaned up so we don't leave duplicate state behind.
    expect(fs.existsSync(projectCommMdPath(projectPath))).toBe(true);
    expect(fs.existsSync(legacyComm)).toBe(false);
  });

  test('uninstall removes the project-local .cebab/ when empty', async () => {
    const id = makeProject('Cleanup');
    const projectPath = path.join(tmpRoot, 'workspace', 'Cleanup');
    await installBusForProject(id);
    // Confirm install state before uninstall.
    expect(fs.existsSync(projectCommMdPath(projectPath))).toBe(true);
    expect(fs.existsSync(projectCebabDir(projectPath))).toBe(true);

    await uninstallBusForProject(id);
    expect(fs.existsSync(projectCommMdPath(projectPath))).toBe(false);
    // .cebab/ was created solely by the install, so it's empty after the
    // unlink — uninstall rmdirs it to leave the project clean.
    expect(fs.existsSync(projectCebabDir(projectPath))).toBe(false);
  });

  test('uninstall keeps an operator-populated .cebab/ alone', async () => {
    // If the operator dropped their own file into `.cebab/` (unrelated
    // to bus), we must not delete it on uninstall — only our own
    // comm.md gets unlinked.
    const id = makeProject('OperatorOwned');
    const projectPath = path.join(tmpRoot, 'workspace', 'OperatorOwned');
    await installBusForProject(id);

    const cebabDir = projectCebabDir(projectPath);
    fs.writeFileSync(path.join(cebabDir, 'operator-notes.md'), 'hi from operator\n');

    await uninstallBusForProject(id);
    // comm.md gone, but operator file intact and the dir survives.
    expect(fs.existsSync(projectCommMdPath(projectPath))).toBe(false);
    expect(fs.existsSync(cebabDir)).toBe(true);
    expect(fs.readFileSync(path.join(cebabDir, 'operator-notes.md'), 'utf8')).toBe(
      'hi from operator\n',
    );
  });
});
