// Cebab-ws0.14: the seed is what keeps the `shouldAutoAllow` change safe.
//
// Letting `mode: 'default'` bind on trusted projects only counts as a
// narrowing if nobody lands in that state by accident. Nobody does, because a
// fresh trusted session still seeds `acceptEdits` — this file is that claim,
// asserted instead of asserted-in-prose. If a future change makes the seed
// `'default'` for trusted projects, every trusted project starts raising
// permission cards on its first turn and these tests are what says so.
import { describe, expect, test } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { createSession, setSessionPermissionMode } from '../repo/sessions.js';
import { upsertProject } from '../repo/projects.js';
import { seedPermissionMode } from './server.js';

describe('seedPermissionMode', () => {
  withTempDataDir('seed-permission-mode');

  test('a fresh TRUSTED session seeds acceptEdits — the no-change guarantee', () => {
    expect(seedPermissionMode(undefined, true)).toBe('acceptEdits');
  });

  test('a fresh UNTRUSTED session seeds default', () => {
    expect(seedPermissionMode(undefined, false)).toBe('default');
  });

  test('a resumed session keeps its stored mode, on either project kind', () => {
    const project = upsertProject('seed-proj', '/tmp/seed-proj');
    createSession('sess-a', project.id);
    setSessionPermissionMode('sess-a', 'default');
    // The row that Cebab-ws0.14 gives teeth to: a TRUSTED session the operator
    // put into ask mode. Before the change this returned 'default' too — and
    // then `shouldAutoAllow` ignored it. The seed was never the broken half.
    expect(seedPermissionMode('sess-a', true)).toBe('default');

    createSession('sess-b', project.id);
    setSessionPermissionMode('sess-b', 'acceptEdits');
    expect(seedPermissionMode('sess-b', false)).toBe('acceptEdits');
  });

  test('a resumed session with no stored mode falls back to the trust-derived value', () => {
    const project = upsertProject('seed-proj-2', '/tmp/seed-proj-2');
    createSession('sess-c', project.id);
    expect(seedPermissionMode('sess-c', true)).toBe('acceptEdits');
    expect(seedPermissionMode('sess-c', false)).toBe('default');
  });

  test('an unknown session id does not throw, and derives from trust', () => {
    expect(seedPermissionMode('no-such-session', true)).toBe('acceptEdits');
    expect(seedPermissionMode('no-such-session', false)).toBe('default');
  });
});
