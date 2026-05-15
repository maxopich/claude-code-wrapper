import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  DEFAULT_HOP_BUDGET,
  ORCHESTRATOR_AGENT_NAME,
  createOrchestratorRouter,
  ensureOrchestratorWorkspace,
} from './orchestrator.js';
import {
  computeSessionPaths,
  orchestratorWorkspaceDir,
  PROJECT_COMM_MD_REL,
  projectCebabDir,
  projectCommMdPath,
} from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT, type MultiAgentEndedReason } from './runtime.js';
import {
  createMultiAgentSession,
  listMultiAgentEvents,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';

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
  test('creates workspace dir, CLAUDE.md, comm.md, and the .cebab dir', () => {
    const result = ensureOrchestratorWorkspace();

    // Both rendered files report 'created' on first run. No settings.json
    // is generated anymore — the orchestrator runs settingSources:['user'],
    // so a workspace settings.json would never be read.
    expect(result.claudeMd).toBe('created');
    expect(result.commMd).toBe('created');

    // Workspace dir exists at the canonical path.
    const wsDir = orchestratorWorkspaceDir();
    expect(result.workspaceDir).toBe(wsDir);
    expect(fs.existsSync(wsDir)).toBe(true);

    // The workspace files exist. comm.md lives INSIDE the workspace's
    // `.cebab/` so the @import line in CLAUDE.md is workspace-relative
    // (no external-import trust modal at agent start).
    expect(fs.existsSync(path.join(wsDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(projectCommMdPath(wsDir))).toBe(true);
    expect(fs.existsSync(projectCebabDir(wsDir))).toBe(true);
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
    // The protocol is the in-process bus_send tool — no scripts, no inbox.
    expect(comm).toContain('bus_send');
    expect(comm).not.toContain('bus-send-msg.sh');
  });

  test('no .claude/settings.json is generated (orchestrator uses settingSources:[user])', () => {
    ensureOrchestratorWorkspace();
    expect(fs.existsSync(path.join(orchestratorWorkspaceDir(), '.claude', 'settings.json'))).toBe(
      false,
    );
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
    expect(fs.existsSync(projectCommMdPath(customDir))).toBe(true);
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

// Router regression tests for the round-2 + round-3 security batch. The
// helper builds a real router against the test DB (no tmux, no tailer) so
// we can drive `handleEvent` / `forwardCebabEvent` directly and observe
// the persist + onEvent surface in isolation.
function buildRouter(
  opts: {
    workerNames?: string[];
    lifecycle?: MultiAgentLifecycle;
    onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
  } = {},
) {
  const workerNames = opts.workerNames ?? ['reviewer', 'editor'];
  const lifecycle = opts.lifecycle ?? 'persistent';
  const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
  const iterationId = '001';
  const tmuxSessionName = `cebab-bus-${sessionId}`;
  const paths = computeSessionPaths(sessionId, path.join(tmpRoot, 'workspace'));
  // appendMultiAgentEvent has a foreign-key constraint on multi_agent_sessions;
  // seed the row before any handleEvent / forwardCebabEvent call.
  createMultiAgentSession(
    sessionId,
    'orchestrator',
    tmuxSessionName,
    iterationId,
    paths.folder,
    lifecycle,
  );
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    tmuxSessionName,
    paths,
    lifecycle,
    onEvent,
    onEnded,
    onTeardown: opts.onTeardown,
  });
  return { router, sessionId, onEvent, onEnded };
}

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    ts: Date.now(),
    source: 'reviewer',
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'reply',
    text: 'sample payload',
    ...overrides,
  };
}

describe('createOrchestratorRouter — F2 source allowlist', () => {
  // Regression for the round-2 finding where the orchestrator router lacked
  // a default-deny on unknown sources. A worker setting BUS_AGENT_NAME=ghost
  // (or any other unrecognized slug) could otherwise be routed to its
  // claimed destination since the prior three filters only covered the
  // cebab / user-dest / worker→worker cases.
  test.each([
    { name: 'unknown slug', source: 'ghost', destination: 'reviewer' },
    {
      name: 'unknown slug → orchestrator',
      source: 'attacker',
      destination: ORCHESTRATOR_AGENT_NAME,
    },
    { name: 'unknown slug → user', source: 'spoofer', destination: USER_RECIPIENT },
  ])('drops event with non-participant source ($name)', ({ source, destination }) => {
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source, destination }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('accepts legitimate worker → orchestrator reply (sanity positive)', () => {
    // Catches an over-tightening regression — if the allowlist mistakenly
    // dropped a real worker, this test would fail.
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'real reply' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('drops forged source=cebab from the tailer', () => {
    // F3 disk-side drop. Any cebab-attributed line on disk is a forgery —
    // Cebab routes its own writes in-process via forwardCebabEvent.
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops worker→worker traffic (orchestrator mode is hub-and-spoke)', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source: 'reviewer', destination: 'editor' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('createOrchestratorRouter — F3 forwardCebabEvent round-trip', () => {
  // Regression for the round-2 silent bug: when the disk-side `source=cebab`
  // drop was added without an in-process forwarding helper, every Cebab-
  // originated event (rosters, briefings, sendUserPrompt) was swallowed —
  // never persisted, never reached the WS scrollback. forwardCebabEvent
  // closes the loop; this test pins that contract.
  test('persists + forwards a Cebab event exactly once', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.forwardCebabEvent(
      makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer', kind: 'prompt', text: 'go' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('tailer re-read of the same event is dropped (no double-persist)', () => {
    // Simulates the in-process write (forwardCebabEvent) followed by the
    // tailer observing the same bus.log line on disk and calling
    // handleEvent. The disk-side drop swallows it; total stays at 1.
    const { router, sessionId, onEvent } = buildRouter();
    const ev = makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer', kind: 'prompt' });
    router.forwardCebabEvent(ev);
    router.handleEvent(ev);
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createOrchestratorRouter — registerWorker (mid-run worker add)', () => {
  // Pins the contract that `addWorker` on the session handle relies on:
  // after registerWorker(slug), inbound events from `slug` pass F2's
  // source allowlist (which would otherwise drop them as forgeries).
  test('newly-registered slug passes the F2 source allowlist', () => {
    const { router, sessionId, onEvent } = buildRouter();
    // Before registration: a `newbie` source is dropped as non-participant.
    router.handleEvent(
      makeEvent({ source: 'newbie', destination: ORCHESTRATOR_AGENT_NAME, kind: 'reply' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();

    // After registration: same event is accepted.
    router.registerWorker('newbie');
    router.handleEvent(
      makeEvent({
        source: 'newbie',
        destination: ORCHESTRATOR_AGENT_NAME,
        kind: 'reply',
        text: 'hello',
      }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('is idempotent (re-registering an existing slug is a no-op)', () => {
    const { router } = buildRouter({ workerNames: ['reviewer'] });
    expect(router.getWorkerNames()).toEqual(['reviewer']);
    router.registerWorker('reviewer');
    router.registerWorker('reviewer');
    expect(router.getWorkerNames()).toEqual(['reviewer']);
    router.registerWorker('editor');
    expect(router.getWorkerNames()).toEqual(['reviewer', 'editor']);
  });
});

describe('createOrchestratorRouter — setLifecycle (mid-run lifecycle flip)', () => {
  // The router gates the onTeardown invocation on the CURRENT
  // lifecycleRef + reason !== 'crashed'. setLifecycle must mutate that
  // ref so a session started 'persistent' but flipped to 'temp' mid-run
  // cleans up at end, and vice versa.
  test('persistent → temp: onTeardown runs at teardown', async () => {
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'persistent', onTeardown });
    expect(router.getLifecycle()).toBe('persistent');
    router.setLifecycle('temp');
    expect(router.getLifecycle()).toBe('temp');
    await router.teardown('stopped');
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  test('temp → persistent: onTeardown does NOT run at teardown', async () => {
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'temp', onTeardown });
    router.setLifecycle('persistent');
    await router.teardown('stopped');
    expect(onTeardown).not.toHaveBeenCalled();
  });

  test('onTeardown is skipped on `crashed` even when temp', async () => {
    // Crash means the operator wants to inspect artifacts; lifecycle
    // doesn't matter — never run the rm-rf + uninstall.
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'temp', onTeardown });
    await router.teardown('crashed');
    expect(onTeardown).not.toHaveBeenCalled();
  });
});
