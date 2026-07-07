import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MockOptions, RunOptions, Runner } from '../runner/index.js';
import { AgentRunner, DELEGATE_ONLY_DISALLOWED, isDelegationAllowedTool } from './runner.js';

// --- helpers (mirror runner.test.ts) -------------------------------------

function fakeRunner(messages: SDKMessage[]): Runner {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const m of messages) yield m;
  }
  const it = gen();
  return { [Symbol.asyncIterator]: () => it, close: () => {} };
}

function resultMsg(sessionId: string): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId } as unknown as SDKMessage;
}

/** Invoke a captured `canUseTool` the way the SDK does. */
type Gate = (
  n: string,
  i: unknown,
  o: unknown,
) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>;

function callGate(opts: RunOptions & Partial<MockOptions>, toolName: string) {
  return (opts.canUseTool as unknown as Gate)(
    toolName,
    {},
    {
      toolUseID: 't1',
      signal: new AbortController().signal,
    },
  );
}

/**
 * Build a runner whose `runnerFactory` captures the SDK options for the first
 * turn, wiring an `onAskUserQuestion` (so the interactive posture with a
 * `canUseTool` gate is selected) and a spy `onGuardrailViolation`.
 */
async function captureTurn(spec: { name: string; toolPolicy?: 'delegate-only' }): Promise<{
  opts: RunOptions & Partial<MockOptions>;
  violations: Array<[string, string]>;
}> {
  const calls: (RunOptions & Partial<MockOptions>)[] = [];
  const violations: Array<[string, string]> = [];
  const runner = new AgentRunner({
    onEvent: () => {},
    onAskUserQuestion: async () => 'User selected: Ship it',
    onGuardrailViolation: (agent, tool) => violations.push([agent, tool]),
    runnerFactory: (opts) => {
      calls.push(opts);
      return fakeRunner([resultMsg('sess-1')]);
    },
  });
  runner.register({ name: spec.name, cwd: `/tmp/${spec.name}`, toolPolicy: spec.toolPolicy });
  await runner.deliverTurn(spec.name, 'go');
  return { opts: calls[0]!, violations };
}

describe('isDelegationAllowedTool', () => {
  test('only bus_send (both server names) and AskUserQuestion are allowed', () => {
    expect(isDelegationAllowedTool('AskUserQuestion')).toBe(true);
    expect(isDelegationAllowedTool('mcp__cebab_bus__bus_send')).toBe(true);
    // Deprecation alias for the `bus` → `cebab_bus` rename must still pass.
    expect(isDelegationAllowedTool('mcp__bus__bus_send')).toBe(true);
    for (const t of ['Edit', 'Write', 'Bash', 'Read', 'Task', 'Glob', 'Grep', 'WebFetch']) {
      expect(isDelegationAllowedTool(t)).toBe(false);
    }
    // Must not be spoofable by a look-alike suffix on an arbitrary MCP tool.
    expect(isDelegationAllowedTool('mcp__evil__bus_send_now')).toBe(false);
  });
});

describe('delegate-only tool policy', () => {
  test('[security] canUseTool denies file/shell/analysis tools with a delegate nudge + audit', async () => {
    const { opts, violations } = await captureTurn({
      name: 'orchestrator',
      toolPolicy: 'delegate-only',
    });
    expect(opts.canUseTool).toBeTypeOf('function');

    for (const tool of ['Edit', 'Write', 'Bash', 'Read', 'Task', 'Glob']) {
      const res = await callGate(opts, tool);
      expect(res.behavior).toBe('deny');
      // The nudge steers the model back to delegation and names the blocked tool.
      expect(res.message).toContain('bus_send');
      expect(res.message).toContain(tool);
    }

    // Every blocked attempt is reported to the observability side-channel.
    expect(violations).toEqual([
      ['orchestrator', 'Edit'],
      ['orchestrator', 'Write'],
      ['orchestrator', 'Bash'],
      ['orchestrator', 'Read'],
      ['orchestrator', 'Task'],
      ['orchestrator', 'Glob'],
    ]);
  });

  test('canUseTool allows bus_send (both names) and still parks AskUserQuestion', async () => {
    const { opts, violations } = await captureTurn({
      name: 'orchestrator',
      toolPolicy: 'delegate-only',
    });

    for (const tool of ['mcp__cebab_bus__bus_send', 'mcp__bus__bus_send']) {
      const res = await callGate(opts, tool);
      expect(res.behavior).toBe('allow');
    }

    // AskUserQuestion is on the allowlist, so it bypasses the delegate-deny and
    // hits the existing park-for-operator branch (returns the answer as `deny`).
    const ask = await callGate(opts, 'AskUserQuestion');
    expect(ask.behavior).toBe('deny');
    expect(ask.message).toBe('User selected: Ship it');

    // Allowed tools never count as guardrail violations.
    expect(violations).toEqual([]);
  });

  test('runOneAttempt strips the built-ins from context via disallowedTools', async () => {
    const { opts } = await captureTurn({ name: 'orchestrator', toolPolicy: 'delegate-only' });
    expect(opts.disallowedTools).toEqual([...DELEGATE_ONLY_DISALLOWED]);
    // The two allowed tools must NOT be in the strip-list.
    expect(opts.disallowedTools).not.toContain('AskUserQuestion');
    expect(opts.disallowedTools).not.toContain('mcp__cebab_bus__bus_send');
  });

  test('[security] an unrestricted agent auto-allows every tool (no regression)', async () => {
    const { opts, violations } = await captureTurn({ name: 'worker' });
    expect(opts.disallowedTools).toBeUndefined();

    for (const tool of ['Edit', 'Write', 'Bash', 'Task']) {
      const res = await callGate(opts, tool);
      expect(res.behavior).toBe('allow');
    }
    expect(violations).toEqual([]);
  });
});
