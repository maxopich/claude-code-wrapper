import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { HookView } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import { listHookTrust, observeProjectHooks, resolveHookScriptSha } from './hook_trust.js';

// F6: the hook TOFU ledger. Hooks are the one authority surface with no gate —
// `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` never reach
// `canUseTool`, so they cannot be approved or denied, and since #260 widened
// bus participants to project + local scopes they execute on every hop.
//
// This module records what will run and reports what changed. The tests below
// pin the two questions that matter: what counts as the SAME hook (identity),
// and what counts as a CHANGE worth waking the operator for.

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-hook-trust-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude', 'hooks'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const ORIGIN = '/somewhere/.claude/settings.json';

/** FIFO / device cases need mkfifo and /dev/zero; skip on Windows rather than
 *  fake them. Mirrors `safe_fs.test.ts`. */
const posixOnly = process.platform === 'win32' ? test.skip : test;

function hook(over: Partial<HookView> = {}): HookView {
  return {
    hookKind: 'PreToolUse',
    scope: 'project',
    scopePath: ORIGIN,
    command: 'echo hi',
    ...over,
  };
}

function writeScript(rel: string, body: string): string {
  const abs = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe('resolveHookScriptSha', () => {
  test('resolves $CLAUDE_PROJECT_DIR, braced form, ./-relative, and absolute', () => {
    const abs = writeScript('.claude/hooks/guard.sh', '#!/bin/sh\necho guard\n');
    const expected = resolveHookScriptSha(abs, projectDir);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);

    // All four spellings of the same file must hash identically, or a hook
    // rewritten from one form to another would look like a changed script
    // rather than the identical file it is.
    expect(resolveHookScriptSha('$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh', projectDir)).toBe(
      expected,
    );
    expect(resolveHookScriptSha('${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.sh', projectDir)).toBe(
      expected,
    );
    expect(resolveHookScriptSha('./.claude/hooks/guard.sh --flag', projectDir)).toBe(expected);
  });

  test('a quoted first token with spaces resolves; the unquoted form does not', () => {
    const abs = writeScript('.claude/hooks/my guard.sh', 'x');
    const expected = createHash('sha256').update('x').digest('hex');
    expect(resolveHookScriptSha(`"${abs}" --dry-run`, projectDir)).toBe(expected);
    expect(resolveHookScriptSha(`'${abs}'`, projectDir)).toBe(expected);
    // Unquoted, the space is a token boundary — the same way a shell reads it.
    // Resolving it anyway would mean guessing that a path, not a command plus
    // argument, was intended.
    expect(resolveHookScriptSha(`${abs} --dry-run`, projectDir)).toBeNull();
  });

  test('returns null for bare commands, pipelines, and missing files', () => {
    // A bare command resolves through PATH, which can differ between spawns —
    // nothing stable to pin.
    expect(resolveHookScriptSha('jq .', projectDir)).toBeNull();
    expect(resolveHookScriptSha('python3 -c "print(1)"', projectDir)).toBeNull();
    // Shell syntax is a parser problem, not a path. Guessing wrong would pin
    // the wrong bytes and then report "unchanged" while the real script moved.
    expect(resolveHookScriptSha('sh -c "$(cat x)"', projectDir)).toBeNull();
    expect(resolveHookScriptSha('cat a | tee b', projectDir)).toBeNull();
    expect(resolveHookScriptSha('./.claude/hooks/missing.sh', projectDir)).toBeNull();
    expect(resolveHookScriptSha('', projectDir)).toBeNull();
    // A directory is not a script.
    expect(resolveHookScriptSha('./.claude/hooks', projectDir)).toBeNull();
  });

  // ---- Cebab-x1n.6.21: this used to open with a bare 'r' and read whole ----
  //
  // `command` is a path a PROJECT chose in its own `.claude/settings*.json`,
  // and this runs on the way into every session start. The TOCTOU guard was
  // here from the start; the other two hazards `safe_fs` names were not.

  test('[security] the hook target is opened NON-BLOCKING, so a FIFO cannot park the server', () => {
    // The obvious test — point this at a real FIFO and assert it returns —
    // is the one test that must NOT be written here. A blocking `openSync`
    // freezes the event loop, and vitest's per-test timeout is itself
    // JavaScript: it can never fire, so a regression would HANG the suite
    // (and CI) instead of reddening it. Verified by doing exactly that.
    //
    // So assert the guard rather than its consequence. `O_NONBLOCK` on the
    // open is what makes a FIFO at a project-named hook path return ENXIO
    // immediately instead of waiting forever for a writer. Reading a normal
    // file here means the assertion costs nothing and can never block.
    const abs = writeScript('.claude/hooks/flagged.sh', 'x');
    const flags: number[] = [];
    const realOpen = fs.openSync.bind(fs);
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
      p: fs.PathLike,
      f: number,
      m?: fs.Mode,
    ) => {
      flags.push(typeof f === 'number' ? f : 0);
      return realOpen(p, f, m);
    }) as typeof fs.openSync);
    try {
      expect(resolveHookScriptSha(abs, projectDir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      spy.mockRestore();
    }
    expect(flags).toHaveLength(1);
    // 0 on Windows, where the constant does not exist and `safe_fs` says
    // `?? 0`. Skip rather than assert `x & 0 === 0`, which would pass while
    // measuring nothing.
    const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
    if (NONBLOCK === 0) return;
    expect(flags[0]! & NONBLOCK).toBe(NONBLOCK);
  });

  posixOnly(
    '[security] a character device is refused rather than hashed forever',
    () => {
      // /dev/zero never ends: an unbounded read allocates until it dies.
      expect(resolveHookScriptSha('/dev/zero', projectDir)).toBeNull();
    },
    10_000,
  );

  test('an ordinary script still hashes — the cap is not a blanket refusal', () => {
    // Anti-vacuity for the two above: a null is only meaningful if the normal
    // path still returns a hash.
    const abs = writeScript('.claude/hooks/normal.sh', '#!/bin/sh\necho ok\n');
    expect(resolveHookScriptSha(abs, projectDir)).toBe(
      createHash('sha256').update('#!/bin/sh\necho ok\n').digest('hex'),
    );
  });
});

describe('observeProjectHooks', () => {
  test('first spawn reports every hook once, then goes silent', () => {
    const hooks = [hook({ command: 'echo a' }), hook({ hookKind: 'Stop', command: 'echo b' })];

    const first = observeProjectHooks(projectId, hooks, projectDir);
    expect(first.map((o) => [o.change, o.command])).toEqual([
      ['first_seen', 'echo a'],
      ['first_seen', 'echo b'],
    ]);

    // Steady state is silent. A notification that fires on every spawn trains
    // the operator to ignore it, which is worse than not having it.
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
    expect(listHookTrust(projectId)).toHaveLength(2);
  });

  test('[security] a rewritten command is a NEW hook, not a mutation', () => {
    observeProjectHooks(projectId, [hook({ command: './.claude/hooks/a.sh' })], projectDir);
    const second = observeProjectHooks(
      projectId,
      [hook({ command: './.claude/hooks/evil.sh' })],
      projectDir,
    );
    // Identity includes the command text on purpose: an edited command is
    // exactly what the operator must re-read, so it must re-report rather
    // than quietly updating the existing row.
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ change: 'first_seen', command: './.claude/hooks/evil.sh' });
    expect(listHookTrust(projectId)).toHaveLength(2);
  });

  test('[security] same command at a different origin is a distinct row', () => {
    observeProjectHooks(projectId, [hook({ command: 'run.sh' })], projectDir);
    const other = observeProjectHooks(
      projectId,
      [hook({ command: 'run.sh', scopePath: '/other/.claude/settings.local.json' })],
      projectDir,
    );
    // A sibling repo's settings.local.json redefining a familiar-looking hook
    // is a different trust question from the one already answered.
    expect(other).toHaveLength(1);
    expect(other[0]!.change).toBe('first_seen');
  });

  test('[security] different args are a distinct hook', () => {
    observeProjectHooks(projectId, [hook({ command: 'g.sh', args: ['--dry-run'] })], projectDir);
    const applied = observeProjectHooks(
      projectId,
      [hook({ command: 'g.sh', args: ['--apply'] })],
      projectDir,
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]!.change).toBe('first_seen');
  });

  test('undefined args and [] are the same identity', () => {
    // Otherwise the same hook alternates between two rows and re-reports on
    // every spawn depending on how the settings file happened to be written.
    observeProjectHooks(projectId, [hook({ command: 'g.sh' })], projectDir);
    expect(
      observeProjectHooks(projectId, [hook({ command: 'g.sh', args: [] })], projectDir),
    ).toEqual([]);
    expect(listHookTrust(projectId)).toHaveLength(1);
  });

  test('[security] rewriting the script behind a stable command is reported', () => {
    writeScript('.claude/hooks/guard.sh', 'original');
    const hooks = [hook({ command: './.claude/hooks/guard.sh' })];
    const first = observeProjectHooks(projectId, hooks, projectDir);
    expect(first[0]!.change).toBe('first_seen');
    const originalSha = first[0]!.scriptSha!;
    expect(originalSha).toMatch(/^[0-9a-f]{64}$/);

    // The case identity cannot catch: settings.json untouched, script swapped.
    writeScript('.claude/hooks/guard.sh', 'rm -rf /');
    const second = observeProjectHooks(projectId, hooks, projectDir);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      change: 'script_changed',
      previousScriptSha: originalSha,
    });
    expect(second[0]!.scriptSha).not.toBe(originalSha);

    // Reported once — the new hash is now the baseline.
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
  });

  test('a script that becomes unresolvable reports nothing', () => {
    writeScript('.claude/hooks/guard.sh', 'original');
    const hooks = [hook({ command: './.claude/hooks/guard.sh' })];
    observeProjectHooks(projectId, hooks, projectDir);

    fs.rmSync(path.join(projectDir, '.claude/hooks/guard.sh'));
    // Absence is not evidence of tampering, and the run fails loudly on its
    // own when the hook cannot execute. Claiming "script changed" here would
    // be a false positive on the most common cause: a moved file.
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
  });

  // Register D07 [security]. The test above stops at "reports nothing", which
  // was true — but the touch UPDATE wrote `script_sha` unconditionally, so the
  // unresolvable spawn ALSO overwrote the good baseline with NULL. And once
  // the baseline is NULL the `changed` comparison (which requires both sides
  // non-null) can never be true again: the ledger goes permanently blind for
  // that hook. Absence of the script must not destroy the evidence.
  test('[security] an unresolvable spawn does not erase the recorded hash', () => {
    writeScript('.claude/hooks/guard.sh', 'original');
    const hooks = [hook({ command: './.claude/hooks/guard.sh' })];
    const originalSha = observeProjectHooks(projectId, hooks, projectDir)[0]!.scriptSha!;

    // The script goes missing for one spawn — a rename, a checkout, a
    // permissions blip.
    fs.rmSync(path.join(projectDir, '.claude/hooks/guard.sh'));
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
    // The baseline is the thing being protected: it must still be on the row.
    expect(listHookTrust(projectId)[0]!.script_sha).toBe(originalSha);

    // Now the attack this enables: the script comes back, rewritten. With the
    // baseline erased this reported `first_seen`-style silence and silently
    // re-baselined; it must report the change.
    writeScript('.claude/hooks/guard.sh', 'rm -rf /');
    const after = observeProjectHooks(projectId, hooks, projectDir);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      change: 'script_changed',
      previousScriptSha: originalSha,
    });
  });

  test('[security] a restored-identical script after an unresolvable spawn stays quiet', () => {
    // The other side of the same coin: preserving the baseline must not
    // manufacture a false positive when nothing actually changed.
    writeScript('.claude/hooks/guard.sh', 'original');
    const hooks = [hook({ command: './.claude/hooks/guard.sh' })];
    observeProjectHooks(projectId, hooks, projectDir);

    fs.rmSync(path.join(projectDir, '.claude/hooks/guard.sh'));
    observeProjectHooks(projectId, hooks, projectDir);

    writeScript('.claude/hooks/guard.sh', 'original');
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
  });

  test('a bare command is tracked for identity but never reports a change', () => {
    const hooks = [hook({ command: 'jq .' })];
    expect(observeProjectHooks(projectId, hooks, projectDir)[0]!.scriptSha).toBeNull();
    // No hash on either side, so there is nothing to compare — and inventing
    // a comparison would mean re-prompting forever.
    expect(observeProjectHooks(projectId, hooks, projectDir)).toEqual([]);
  });

  test('an empty hook list touches nothing', () => {
    expect(observeProjectHooks(projectId, [], projectDir)).toEqual([]);
    expect(listHookTrust(projectId)).toEqual([]);
  });

  test('hook rows are scoped per project', () => {
    const otherDir = path.join(tmpRoot, 'proj2');
    fs.mkdirSync(otherDir, { recursive: true });
    const other = upsertProject('proj2', otherDir).id;
    observeProjectHooks(projectId, [hook({ command: 'g.sh' })], projectDir);
    // The same command in a different project is a different trust question.
    expect(observeProjectHooks(other, [hook({ command: 'g.sh' })], otherDir)).toHaveLength(1);
    expect(listHookTrust(projectId)).toHaveLength(1);
    expect(listHookTrust(other)).toHaveLength(1);
  });

  test('deleting a project cascades its hook rows away', () => {
    observeProjectHooks(projectId, [hook({ command: 'g.sh' })], projectDir);
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    // A re-added project is not the same trust context as the one removed —
    // it must re-prompt from scratch.
    expect(listHookTrust(projectId)).toEqual([]);
  });
});
