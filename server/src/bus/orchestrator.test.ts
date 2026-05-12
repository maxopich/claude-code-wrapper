import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  DEFAULT_HOP_BUDGET,
  ORCHESTRATOR_AGENT_NAME,
  ensureOrchestratorWorkspace,
} from './orchestrator.js';
import {
  busBinDir,
  orchestratorWorkspaceDir,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
} from './paths.js';

// Same isolation scaffolding as install.test.ts — each test gets its own
// tmp ~/.cebab so writes don't leak across tests or out to the real home.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orchestrator-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  // ensureOrchestratorWorkspace doesn't actually need the DB — but other
  // bus modules it imports do, and getDb is the only way to apply
  // migration 005 against this fresh tmp dir.
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureOrchestratorWorkspace — first run', () => {
  test('creates workspace dir, CLAUDE.md, comm.md, settings.json, and bus state dirs', () => {
    const result = ensureOrchestratorWorkspace();

    // All three rendered files report 'created' on first run.
    expect(result.claudeMd).toBe('created');
    expect(result.commMd).toBe('created');
    expect(result.settingsJson).toBe('created');

    // Workspace dir exists at the canonical path.
    const wsDir = orchestratorWorkspaceDir();
    expect(result.workspaceDir).toBe(wsDir);
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.claude'))).toBe(true);

    // The three workspace files exist. comm.md lives INSIDE the
    // workspace's `.cebab/` so the @import line in CLAUDE.md is
    // workspace-relative (no external-import trust modal at TUI start).
    expect(fs.existsSync(path.join(wsDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(projectCommMdPath(wsDir))).toBe(true);
    expect(fs.existsSync(projectCebabDir(wsDir))).toBe(true);

    // Bus bootstrap ran (scripts copied into bin/).
    expect(fs.existsSync(path.join(busBinDir(), 'bus-send-msg.sh'))).toBe(true);
  });

  test('CLAUDE.md substitutes the comm.md path placeholder as a project-relative path', () => {
    ensureOrchestratorWorkspace();

    const claudeMd = fs.readFileSync(path.join(orchestratorWorkspaceDir(), 'CLAUDE.md'), 'utf8');
    // Placeholder must be gone.
    expect(claudeMd).not.toContain('{{BUS_COMM_PATH}}');
    // The @import line is workspace-relative (`.cebab/comm.md`), NOT an
    // absolute external path — that's what avoids claude-code's
    // external-import trust modal at TUI startup.
    expect(claudeMd).toContain(`@${PROJECT_COMM_MD_REL}`);
    expect(claudeMd).not.toMatch(/@\/.*\.cebab\/bus\/agents\//);
  });

  test('CLAUDE.md keeps the static prose (identity + lifecycle + budget)', () => {
    ensureOrchestratorWorkspace();
    const claudeMd = fs.readFileSync(path.join(orchestratorWorkspaceDir(), 'CLAUDE.md'), 'utf8');
    // Cheap canaries that the template wasn't accidentally truncated by the
    // placeholder substitution.
    expect(claudeMd).toContain('# Orchestrator');
    expect(claudeMd).toContain('Your bus agent name is `orchestrator`');
    expect(claudeMd).toContain('Intro phase');
    // The hop budget is exposed as a constant — keep the doc consistent.
    expect(claudeMd).toContain(`${DEFAULT_HOP_BUDGET} hops`);
  });

  test('comm.md is rendered for agent name `orchestrator`', () => {
    ensureOrchestratorWorkspace();
    const comm = fs.readFileSync(projectCommMdPath(orchestratorWorkspaceDir()), 'utf8');
    // renderCommMd embeds the agent name into a fenced heading.
    expect(comm).toContain('agent: `orchestrator`');
  });

  test('settings.json declares BUS_AGENT_NAME, bus-script perms, and Stop hook', () => {
    ensureOrchestratorWorkspace();
    const settings = JSON.parse(
      fs.readFileSync(path.join(orchestratorWorkspaceDir(), '.claude', 'settings.json'), 'utf8'),
    );

    expect(settings.env.BUS_AGENT_NAME).toBe(ORCHESTRATOR_AGENT_NAME);

    // permissions.allow whitelists exactly our three bus scripts (no
    // blanket bash, no anything-else).
    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bus-send-msg.sh'),
        expect.stringContaining('bus-check-inbox.sh'),
        expect.stringContaining('bus-status.sh'),
      ]),
    );
    expect(settings.permissions.allow).toHaveLength(3);

    // The Stop hook runs bus-check-inbox.sh for our own agent name, so
    // the orchestrator's own inbox drains at the end of every turn.
    expect(settings.hooks.Stop).toHaveLength(1);
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain('bus-check-inbox.sh');
    expect(cmd).toContain(ORCHESTRATOR_AGENT_NAME);
  });
});

describe('ensureOrchestratorWorkspace — per-session targetDir', () => {
  test('writes the orchestrator workspace inside a custom target dir', () => {
    // Post-007 callers pass a per-session orchestrator workspace path
    // (typically `<sessionFolder>/orchestrator/`). Verify the function
    // honors it instead of using the global default.
    const customDir = path.join(tmpRoot, 'session-folder', 'orchestrator');
    const result = ensureOrchestratorWorkspace(customDir);
    expect(result.workspaceDir).toBe(customDir);
    expect(fs.existsSync(path.join(customDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(customDir, '.claude', 'settings.json'))).toBe(true);
    // The legacy global workspace was NOT created — only `customDir`.
    expect(fs.existsSync(path.join(orchestratorWorkspaceDir(), 'CLAUDE.md'))).toBe(false);
  });

  test('comm.md lives INSIDE the per-session target dir (project-relative import)', () => {
    // comm.md is `@import`ed from CLAUDE.md via a workspace-relative
    // path (`.cebab/comm.md`) to avoid claude-code's external-import
    // trust modal. Confirm the per-session call writes it inside
    // `<customDir>/.cebab/comm.md`, NOT at the stable global path.
    const customDir = path.join(tmpRoot, 'session-X', 'orchestrator');
    ensureOrchestratorWorkspace(customDir);
    expect(fs.existsSync(projectCommMdPath(customDir))).toBe(true);
    // The legacy global agents/orchestrator/comm.md is NOT created —
    // each session owns its own workspace-local copy.
    expect(
      fs.existsSync(path.join(tmpRoot, '.cebab', 'bus', 'agents', 'orchestrator', 'comm.md')),
    ).toBe(false);
  });
});

describe('ensureOrchestratorWorkspace — idempotency and refresh', () => {
  test('second call returns "unchanged" for all rendered files', () => {
    ensureOrchestratorWorkspace();
    const second = ensureOrchestratorWorkspace();
    expect(second.claudeMd).toBe('unchanged');
    expect(second.commMd).toBe('unchanged');
    expect(second.settingsJson).toBe('unchanged');
  });

  test('overwrites stale CLAUDE.md content on next call', () => {
    ensureOrchestratorWorkspace();
    const claudeMdPath = path.join(orchestratorWorkspaceDir(), 'CLAUDE.md');

    // Simulate a stale or operator-tampered CLAUDE.md. Cebab owns this
    // workspace, so the canonical content wins on the next call.
    fs.writeFileSync(claudeMdPath, 'old garbage content\n');

    const result = ensureOrchestratorWorkspace();
    expect(result.claudeMd).toBe('updated');

    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).not.toBe('old garbage content\n');
    expect(after).toContain('# Orchestrator');
    expect(after).toContain(`@${PROJECT_COMM_MD_REL}`);
  });

  test('overwrites stale settings.json content on next call', () => {
    ensureOrchestratorWorkspace();
    const settingsPath = path.join(orchestratorWorkspaceDir(), '.claude', 'settings.json');

    // Hostile / stale settings.json — Cebab owns it, so we refresh.
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { OPS_INJECTION: 'evil' } }, null, 2));

    const result = ensureOrchestratorWorkspace();
    expect(result.settingsJson).toBe('updated');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.env.OPS_INJECTION).toBeUndefined();
    expect(after.env.BUS_AGENT_NAME).toBe(ORCHESTRATOR_AGENT_NAME);
    expect(after.hooks.Stop).toHaveLength(1);
  });

  test('overwrites stale comm.md content on next call', () => {
    ensureOrchestratorWorkspace();
    const commPath = projectCommMdPath(orchestratorWorkspaceDir());

    fs.writeFileSync(commPath, 'stale comm content\n');

    const result = ensureOrchestratorWorkspace();
    expect(result.commMd).toBe('updated');

    const after = fs.readFileSync(commPath, 'utf8');
    expect(after).toContain('agent: `orchestrator`');
  });
});
