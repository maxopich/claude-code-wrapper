import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import {
  addParticipant,
  createMultiAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { busIterationDir, sessionPathsFromFolder } from '../bus/paths.js';
import { buildIterationsList } from './server.js';

// Isolate DB writes per-test, mirroring the pattern in
// server/src/repo/multi_agent.test.ts.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ws-server-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildIterationsList artifactsDir resolution', () => {
  test('post-007 row (session_folder set) points at <session_folder>/iterations/<id>/', async () => {
    const projectPath = path.join(tmpRoot, 'workspace', 'reviewer');
    fs.mkdirSync(projectPath, { recursive: true });
    const project = upsertProject('Reviewer', projectPath);
    setProjectBusInstalled(project.id, true, 'reviewer');

    const sessionFolder = path.join(tmpRoot, 'workspace', '.cebab-session-with-folder');
    createMultiAgentSession('with-folder', 'orchestrator', '042', sessionFolder, 'persistent');
    addParticipant('with-folder', project.id, 'worker', null);

    const items = await buildIterationsList();
    expect(items).toHaveLength(1);
    expect(items[0]!.artifactsDir).toBe(sessionPathsFromFolder(sessionFolder).iterationDir('042'));
    // Sanity: must NOT collapse onto the legacy global path.
    expect(items[0]!.artifactsDir).not.toBe(busIterationDir('042'));
  });

  test('pre-007 row (session_folder null) falls back to ~/.cebab/bus/iterations/<id>/', async () => {
    const projectPath = path.join(tmpRoot, 'workspace', 'reviewer');
    fs.mkdirSync(projectPath, { recursive: true });
    const project = upsertProject('Reviewer', projectPath);
    setProjectBusInstalled(project.id, true, 'reviewer');

    createMultiAgentSession('legacy', 'chain', '007');
    addParticipant('legacy', project.id, 'worker', 0);

    const items = await buildIterationsList();
    expect(items).toHaveLength(1);
    expect(items[0]!.artifactsDir).toBe(busIterationDir('007'));
  });

  test('mixed rows resolve independently — each gets its own path', async () => {
    // Two sessions, two distinct session folders + one legacy row.
    // Confirms a single buildIterationsList() call doesn't apply one
    // session's path to another row (the bug was: every row got
    // busIterationDir(id), so two post-007 rows from DIFFERENT session
    // folders both rendered the same legacy global path).
    const projectPath = path.join(tmpRoot, 'workspace', 'reviewer');
    fs.mkdirSync(projectPath, { recursive: true });
    const project = upsertProject('Reviewer', projectPath);
    setProjectBusInstalled(project.id, true, 'reviewer');

    const folderA = path.join(tmpRoot, 'workspace', '.cebab-session-A');
    const folderB = path.join(tmpRoot, 'workspace', '.cebab-session-B');

    // Ensure distinct started_at timestamps so the DESC ordering is
    // deterministic (newest first → C, then B, then A).
    createMultiAgentSession('A', 'chain', '001', folderA, 'persistent');
    addParticipant('A', project.id, 'worker', 0);
    let t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    createMultiAgentSession('B', 'orchestrator', '002', folderB, 'persistent');
    addParticipant('B', project.id, 'worker', null);
    t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    createMultiAgentSession('C', 'chain', '003'); // legacy, session_folder = null
    addParticipant('C', project.id, 'worker', 0);

    const items = await buildIterationsList();
    expect(items).toHaveLength(3);
    const bySessionId = new Map(items.map((i) => [i.sessionId, i.artifactsDir]));
    expect(bySessionId.get('A')).toBe(sessionPathsFromFolder(folderA).iterationDir('001'));
    expect(bySessionId.get('B')).toBe(sessionPathsFromFolder(folderB).iterationDir('002'));
    expect(bySessionId.get('C')).toBe(busIterationDir('003'));
    // The two post-007 rows must NOT share the same path (the bug).
    expect(bySessionId.get('A')).not.toBe(bySessionId.get('B'));
  });
});
