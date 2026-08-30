import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import {
  computeSessionPaths,
  isValidAgentName,
  isValidBusDestination,
  sessionPathsFromFolder,
  sessionsRoot,
} from './paths.js';

// Since Cebab-ws0.8 `computeSessionPaths` DOES read `config.dataDir` — it is
// the root it joins under — so the tmp override below is load-bearing here,
// not just tidiness. `sessionPathsFromFolder` stays pure.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-paths-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
});

afterEach(() => {
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('computeSessionPaths', () => {
  // A1. Cebab-ws0.8: the folder is Cebab's, so it lives in Cebab's data dir.
  test('folder is `<dataDir>/sessions/<id>`', () => {
    const paths = computeSessionPaths('abc-123');
    // Built with path.join so the separator matches the host OS — backslashes
    // on the Windows CI leg.
    expect(paths.folder).toBe(path.join(config.dataDir, 'sessions', 'abc-123'));
    expect(sessionsRoot()).toBe(path.join(config.dataDir, 'sessions'));
  });

  // A1-neg. The assertion above is also satisfied by `<workspace>/sessions/<id>`
  // whenever a test happens to point both roots at the same tmp tree. THIS is
  // the one that says "not in the operator's workspace", which is the whole
  // point of the bead.
  test('the folder is NOT under the workspace root', () => {
    const workspace = path.join(tmpRoot, 'agents');
    const folder = computeSessionPaths('abc-123').folder;
    const rel = path.relative(workspace, folder);
    // Escapes the workspace: either absolute, or climbing out of it.
    expect(rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'))).toBe(false);
  });

  test('reads config.dataDir at CALL time, not at import time', () => {
    // The property is deliberately mutable for test isolation. A module-init
    // capture would keep writing to whatever dir was configured on import —
    // and would pass every other test in this file.
    const before = computeSessionPaths('s1').folder;
    config.dataDir = path.join(tmpRoot, 'moved');
    expect(computeSessionPaths('s1').folder).not.toBe(before);
  });

  test('all sub-paths nest correctly under folder', () => {
    const paths = computeSessionPaths('s1');
    const base = path.join(config.dataDir, 'sessions', 's1');
    expect(paths.orchestratorWorkspace).toBe(path.join(base, 'orchestrator'));
    expect(paths.iterationDir('001')).toBe(path.join(base, 'iterations', '001'));
    expect(paths.iterationDir('001', 'reviewer')).toBe(
      path.join(base, 'iterations', '001', 'reviewer'),
    );
  });

  test('does no filesystem IO — purely path math', () => {
    // The returned paths are just strings until something writes through them.
    // Confirms no implicit mkdir.
    config.dataDir = path.join(tmpRoot, 'definitely-does-not-exist');
    const paths = computeSessionPaths('s1');
    expect(fs.existsSync(paths.folder)).toBe(false);
  });
});

describe('sessionPathsFromFolder', () => {
  /**
   * A2. This replaces the old "the two functions agree" test, which asserted
   * `sessionPathsFromFolder(f)` equals `computeSessionPaths(id)`. Cebab-ws0.8
   * composes the second from the first, so that assertion can no longer fail —
   * it would be a gate that passes because it measures nothing.
   *
   * The invariant's weight moves HERE: a folder persisted before the move must
   * keep resolving to where its artifacts actually are, with `config.dataDir`
   * pointing somewhere else entirely. That is what makes the cutover safe, and
   * it is what reddens if anyone ever "simplifies" this function to recompute
   * from the data dir — the mistake that would orphan every pre-move session.
   */
  test('a legacy workspace folder resolves to its ORIGINAL location', () => {
    const legacy = path.join(tmpRoot, 'agents', '.cebab-session-xyz');
    config.dataDir = path.join(tmpRoot, 'somewhere-else');

    const paths = sessionPathsFromFolder(legacy);
    expect(paths.folder).toBe(legacy);
    expect(paths.orchestratorWorkspace).toBe(path.join(legacy, 'orchestrator'));
    expect(paths.iterationDir('1', 'r')).toBe(path.join(legacy, 'iterations', '1', 'r'));

    // And nothing it returns has been dragged under the current data dir.
    for (const p of [paths.folder, paths.orchestratorWorkspace, paths.iterationDir('1')]) {
      expect(p.startsWith(config.dataDir)).toBe(false);
    }
  });

  test('is the layout definition computeSessionPaths composes with', () => {
    // Not a tautology dressed as an invariant: this pins that a NEW session's
    // sub-layout is byte-identical to what resume rebuilds for it, which is the
    // agreement R-B depends on.
    const fromCompute = computeSessionPaths('xyz');
    const rebuilt = sessionPathsFromFolder(fromCompute.folder);
    expect(rebuilt.orchestratorWorkspace).toBe(fromCompute.orchestratorWorkspace);
    expect(rebuilt.iterationDir('1', 'r')).toBe(fromCompute.iterationDir('1', 'r'));
  });
});

describe('isValidAgentName / isValidBusDestination', () => {
  test.each([['reviewer'], ['my-agent'], ['a1b2c3'], ['x']])('accepts canonical slug %j', (s) => {
    expect(isValidAgentName(s)).toBe(true);
    expect(isValidBusDestination(s)).toBe(true);
  });

  test.each([
    [''],
    ['UPPER'],
    ['has space'],
    ['has_underscore'],
    ['-leading-hyphen'],
    ['trailing-hyphen-'],
    ['double--hyphen'],
    ['has/slash'],
    ['../traversal'],
    ['has\nnewline'],
  ])('rejects %j as an agent name', (s) => {
    expect(isValidAgentName(s)).toBe(false);
  });

  test('isValidBusDestination accepts the protocol sentinels', () => {
    // user and _sink are NOT valid agent slugs (underscore disallowed),
    // but they're legal recipients in the bus protocol.
    expect(isValidAgentName('user')).toBe(true); // happens to look like a slug
    expect(isValidAgentName('_sink')).toBe(false);
    expect(isValidBusDestination('user')).toBe(true);
    expect(isValidBusDestination('_sink')).toBe(true);
  });

  test('isValidBusDestination rejects path traversal and empty input', () => {
    // Same exclusions as isValidAgentName, plus the sentinels are the
    // only underscore-bearing strings accepted.
    expect(isValidBusDestination('')).toBe(false);
    expect(isValidBusDestination('../etc')).toBe(false);
    expect(isValidBusDestination('reviewer/../etc')).toBe(false);
    expect(isValidBusDestination('_other_sentinel')).toBe(false);
  });
});
