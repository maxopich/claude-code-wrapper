import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { translate } from './translate.js';

// Cluster B Phase 2 (BE-B1): the SDK init payload (SDKSystemMessage subtype
// 'init') ships cwd, permission_mode, apiKeySource, slash_commands, skills,
// agents, plugins, mcp_servers, output_style, fast_mode_state,
// claude_code_version, memory_paths. Pre-Phase-2, Cebab forwarded only
// model + tools and silently dropped the rest — the "data on wire, nothing
// rendered" gap (critical/B-authority-transparency.md §1).
//
// These tests assert the verbatim pass-through (snake_case → camelCase per
// Cebab convention) plus the additive-optional contract: every new field is
// `?`, omitted when the SDK omits it, never invented.

function initMsg(extra: Record<string, unknown>): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    model: 'claude-sonnet-4',
    tools: ['Bash', 'Read'],
    ...extra,
  } as unknown as SDKMessage;
}

describe('translate(system.init) — Cluster B Phase 2 extended payload', () => {
  test('minimal init (only model + tools) still works — back-compat with old SDK shapes', () => {
    // Phase 2 must NOT break the existing minimal-init behavior. Operator
    // running a stale SDK build that omits cwd/permission_mode/etc. must
    // still see a session_started with just model + tools (no undefined
    // junk on the wire).
    const out = translate(initMsg({}), 7);
    expect(out).toEqual({
      type: 'session_started',
      sessionId: 'sess-1',
      projectId: 7,
      model: 'claude-sonnet-4',
      tools: ['Bash', 'Read'],
    });
    // No leaked-undefined fields — additive contract is "omit when absent",
    // not "include as undefined". JSON.stringify proves the wire shape.
    const json = JSON.parse(JSON.stringify(out));
    expect(Object.keys(json).sort()).toEqual(
      ['model', 'projectId', 'sessionId', 'tools', 'type'].sort(),
    );
  });

  test('full init forwards every field with snake → camel conversion', () => {
    const out = translate(
      initMsg({
        cwd: '/Users/op/projects/cebab',
        permission_mode: 'acceptEdits',
        apiKeySource: 'oauth',
        claude_code_version: '2.1.0',
        output_style: 'default',
        fast_mode_state: 'off',
        memory_paths: { auto: '/Users/op/projects/cebab/CLAUDE.md' },
        mcp_servers: [
          { name: 'cebab_bus', status: 'connected' },
          { name: 'computer-use', status: 'needs-auth' },
        ],
        slash_commands: ['/compact', '/context'],
        skills: ['claude-code-guide'],
        agents: ['Explore', 'Plan'],
        plugins: [{ name: 'plugin_engineering_github', path: '/some/path' }],
      }),
      7,
    );
    expect(out).toMatchObject({
      type: 'session_started',
      sessionId: 'sess-1',
      projectId: 7,
      model: 'claude-sonnet-4',
      tools: ['Bash', 'Read'],
      cwd: '/Users/op/projects/cebab',
      permissionMode: 'acceptEdits',
      apiKeySource: 'oauth',
      claudeCodeVersion: '2.1.0',
      outputStyle: 'default',
      fastModeState: 'off',
      memoryPaths: { auto: '/Users/op/projects/cebab/CLAUDE.md' },
      mcpServers: [
        { name: 'cebab_bus', status: 'connected' },
        { name: 'computer-use', status: 'needs-auth' },
      ],
      slashCommands: ['/compact', '/context'],
      skills: ['claude-code-guide'],
      agents: ['Explore', 'Plan'],
      plugins: [{ name: 'plugin_engineering_github', path: '/some/path' }],
    });
  });

  test('partial init (some new fields present, others absent) omits the absent ones', () => {
    // Confirms additive-optional: SDK adding fields in stages doesn't force
    // operators to upgrade their UI in lockstep. Absent fields stay off the
    // wire entirely (vs. shipping as `undefined`).
    const out = translate(initMsg({ cwd: '/tmp/proj', permission_mode: 'default' }), 42);
    expect(out).toMatchObject({
      type: 'session_started',
      cwd: '/tmp/proj',
      permissionMode: 'default',
    });
    const json = JSON.parse(JSON.stringify(out));
    expect(json.apiKeySource).toBeUndefined();
    expect(json.slashCommands).toBeUndefined();
    expect(json.agents).toBeUndefined();
  });

  test('forward-compat: unknown permission_mode string is passed through as-is', () => {
    // The protocol type narrows permissionMode to the six current SDK
    // variants. If the SDK adds a new one, the translator forwards bytes
    // rather than dropping them; the client gracefully ignores unknowns
    // (Cebab convention for SDK enum drift — see system_event fall-through
    // at translate.ts:49).
    const out = translate(initMsg({ permission_mode: 'some_future_mode' }), 7);
    expect((out as { permissionMode: string }).permissionMode).toBe('some_future_mode');
  });

  test('empty arrays in init forward as empty arrays (not omitted)', () => {
    // An SDK that explicitly ships `slash_commands: []` is communicating
    // "this session has zero slash commands" — distinct from "the field is
    // absent". We preserve that distinction so the AuthorityPanel can render
    // "No slash commands available" vs. "Slash commands: not reported".
    const out = translate(initMsg({ slash_commands: [], skills: [], agents: [], plugins: [] }), 7);
    expect(out).toMatchObject({
      slashCommands: [],
      skills: [],
      agents: [],
      plugins: [],
    });
  });

  test('mcp_servers entries preserve verbatim per-server status (forward-compat with new SDK statuses)', () => {
    // Status string comes from SDK; protocol type is `string` so any future
    // status the SDK introduces (e.g. 'reconnecting') reaches the client.
    const out = translate(
      initMsg({
        mcp_servers: [
          { name: 'a', status: 'connected' },
          { name: 'b', status: 'some-future-status' },
        ],
      }),
      7,
    );
    expect((out as { mcpServers: { name: string; status: string }[] }).mcpServers).toEqual([
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'some-future-status' },
    ]);
  });
});
