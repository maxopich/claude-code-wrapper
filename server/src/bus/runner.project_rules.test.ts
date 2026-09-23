// `Cebab-fu6n`: an untrusted bus participant's project CLAUDE.md must ride the
// system-prompt APPEND on every hop, not just the one-time visible copy on its
// first delivered prompt.
//
// The bug this pins: the visible copy is a USER-turn message sent once per
// participant per run; a long chain or a worker taking many hops carries it
// only as far back as its context window reaches, and a compaction drops it —
// the opposite of the intent, since bus runs are the ones that go long. The
// single-agent path already solved durability by putting the bytes on
// `systemPromptAppend` (the SDK re-sends the system prompt every turn), so this
// reuses that exact helper (`projectRulesSpec`) rather than a second copy.
//
// Asserted on the CAPTURED options object, and on a hop AFTER the first,
// because `runMock` type-accepts a system prompt and ignores it — a replay can
// never observe the append, so the suite would stay green if the value reached
// the SDK and did nothing. The trusted control lives in the same case: a
// trusted participant already gets the SDK auto-load every hop, so a second
// copy would just pay for the same bytes twice, and its captured options must
// carry NO append.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MockOptions, RunOptions } from '../runner/index.js';
import { AgentRunner } from './runner.js';

function fakeRunner(msgs: SDKMessage[]) {
  const it = msgs[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const n = it.next();
        return n.done
          ? { done: true as const, value: undefined }
          : { done: false as const, value: n.value };
      },
    }),
    close: () => {},
  };
}

function capture() {
  const calls: (RunOptions & Partial<MockOptions>)[] = [];
  const runner = new AgentRunner({
    onEvent: () => {},
    runnerFactory: (opts) => {
      calls.push(opts);
      return fakeRunner([
        { type: 'result', subtype: 'success', session_id: 's-1' } as unknown as SDKMessage,
      ]);
    },
  });
  return { runner, calls };
}

const RULES = '# House rules\n\n- Run `npm test` before every reply\n- Never touch prod';

describe('bus participant project CLAUDE.md on the system prompt append', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-fu6n-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function projectDir(name: string, claudeMd: string | null): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (claudeMd !== null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    return dir;
  }

  test('an untrusted participant carries the rules on a hop AFTER the first', async () => {
    const { runner, calls } = capture();
    // Untrusted = the scope set excludes `'project'`, exactly as
    // `busSettingScopesFor` returns for a not-Trusted project.
    runner.register({ name: 'alpha', cwd: projectDir('alpha', RULES), settingSources: ['user'] });

    await runner.deliverTurn('alpha', 'first');
    await runner.deliverTurn('alpha', 'second');

    // The second hop — the one the visible user-turn copy never reaches — still
    // carries the rules in the system prompt.
    const second = calls[1]!;
    expect(second.systemPromptAppend).toContain('Run `npm test` before every reply');
    expect(second.systemPromptAppend).toContain('<project_claude_md>');
    // And it is on every hop, including the first, by construction.
    expect(calls[0]!.systemPromptAppend).toContain('Run `npm test` before every reply');
  });

  test('a trusted participant carries NO duplicate (control, same file present)', async () => {
    const { runner, calls } = capture();
    // Trusted = the scope set includes `'project'`, so the SDK auto-loads the
    // CLAUDE.md itself on every hop. A Cebab append would be a second copy.
    runner.register({
      name: 'beta',
      cwd: projectDir('beta', RULES),
      settingSources: ['user', 'project', 'local'],
    });

    await runner.deliverTurn('beta', 'first');
    await runner.deliverTurn('beta', 'second');

    // `in`, not `toBeUndefined()`: the latter would pass on
    // `{ systemPromptAppend: undefined }`, which the spreadable helper is shaped
    // precisely to avoid producing.
    expect('systemPromptAppend' in calls[0]!).toBe(false);
    expect('systemPromptAppend' in calls[1]!).toBe(false);
  });

  test('no CLAUDE.md on disk leaks nothing, even untrusted', async () => {
    const { runner, calls } = capture();
    runner.register({ name: 'gamma', cwd: projectDir('gamma', null), settingSources: ['user'] });

    await runner.deliverTurn('gamma', 'go');

    expect('systemPromptAppend' in calls[0]!).toBe(false);
  });
});
