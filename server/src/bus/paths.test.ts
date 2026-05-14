import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import {
  busInboxDir,
  busLogPath,
  busRoot,
  computeSessionPaths,
  isValidAgentName,
  isValidBusRecipient,
  legacyGlobalSessionPaths,
  sessionPathsFromFolder,
} from './paths.js';

// `config.dataDir` overrides are only needed for the legacy-fallback test
// — the new SessionPaths helpers are pure path math and don't read it.
// Set it anyway so every test gets a stable tmp root.

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
  test('folder is `<workspace>/.cebab-session-<id>` (dot-prefixed hidden)', () => {
    const workspace = '/Users/test/agents';
    const paths = computeSessionPaths('abc-123', workspace);
    expect(paths.folder).toBe('/Users/test/agents/.cebab-session-abc-123');
  });

  test('all sub-paths nest correctly under folder', () => {
    const paths = computeSessionPaths('s1', '/w');
    expect(paths.orchestratorWorkspace).toBe('/w/.cebab-session-s1/orchestrator');
    expect(paths.busInbox('reviewer')).toBe('/w/.cebab-session-s1/inboxes/reviewer');
    expect(paths.busArchive('reviewer')).toBe('/w/.cebab-session-s1/archive/reviewer');
    expect(paths.busLog).toBe('/w/.cebab-session-s1/bus.log');
    expect(paths.iterationDir('001')).toBe('/w/.cebab-session-s1/iterations/001');
    expect(paths.iterationDir('001', 'reviewer')).toBe(
      '/w/.cebab-session-s1/iterations/001/reviewer',
    );
  });

  test('does no filesystem IO — purely path math', () => {
    // computeSessionPaths should be safe to call with a non-existent
    // workspace; the returned paths are just strings until something
    // actually writes through them. Confirms no implicit mkdir.
    const paths = computeSessionPaths('s1', '/definitely-does-not-exist');
    expect(fs.existsSync(paths.folder)).toBe(false);
  });
});

describe('sessionPathsFromFolder', () => {
  test('rebuilds the same paths object given just the folder', () => {
    const folder = '/Users/test/agents/.cebab-session-xyz';
    const fromFolder = sessionPathsFromFolder(folder);
    const fromCompute = computeSessionPaths('xyz', '/Users/test/agents');
    // The two should produce identical paths — sessionPathsFromFolder is
    // the resume-time inverse of computeSessionPaths.
    expect(fromFolder.folder).toBe(fromCompute.folder);
    expect(fromFolder.orchestratorWorkspace).toBe(fromCompute.orchestratorWorkspace);
    expect(fromFolder.busInbox('r')).toBe(fromCompute.busInbox('r'));
    expect(fromFolder.busArchive('r')).toBe(fromCompute.busArchive('r'));
    expect(fromFolder.busLog).toBe(fromCompute.busLog);
    expect(fromFolder.iterationDir('1', 'r')).toBe(fromCompute.iterationDir('1', 'r'));
  });
});

describe('legacyGlobalSessionPaths', () => {
  test('points at the pre-007 `~/.cebab/bus/` layout', () => {
    // Used by resume for sessions whose DB row has session_folder=NULL
    // (predate migration 007). All sub-paths resolve to the legacy
    // global locations.
    const paths = legacyGlobalSessionPaths();
    expect(paths.folder).toBe(busRoot());
    expect(paths.busInbox('reviewer')).toBe(busInboxDir('reviewer'));
    expect(paths.busLog).toBe(busLogPath());
  });
});

describe('isValidAgentName / isValidBusRecipient', () => {
  test.each([['reviewer'], ['my-agent'], ['a1b2c3'], ['x']])('accepts canonical slug %j', (s) => {
    expect(isValidAgentName(s)).toBe(true);
    expect(isValidBusRecipient(s)).toBe(true);
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

  test('isValidBusRecipient accepts the protocol sentinels', () => {
    // user and _sink are NOT valid agent slugs (underscore disallowed),
    // but they're legal recipients in the bus protocol.
    expect(isValidAgentName('user')).toBe(true); // happens to look like a slug
    expect(isValidAgentName('_sink')).toBe(false);
    expect(isValidBusRecipient('user')).toBe(true);
    expect(isValidBusRecipient('_sink')).toBe(true);
  });

  test('isValidBusRecipient rejects path traversal and empty input', () => {
    // Same exclusions as isValidAgentName, plus the sentinels are the
    // only underscore-bearing strings accepted.
    expect(isValidBusRecipient('')).toBe(false);
    expect(isValidBusRecipient('../etc')).toBe(false);
    expect(isValidBusRecipient('reviewer/../etc')).toBe(false);
    expect(isValidBusRecipient('_other_sentinel')).toBe(false);
  });
});
