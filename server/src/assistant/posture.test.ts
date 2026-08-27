// Cebab-8x8.1.2: the assistant's spawn posture, pinned.
//
// The posture lives in a pure exported function precisely so a test asserts its
// values rather than a reader tracing the giant `runOneTurn` switch arm in
// `ws/server.ts`. This file is that assertion — plus a source-scan tripwire for
// the ONE line the pure function cannot hold (forcing `trusted` false), because
// that line touches the live project row and stays inline in `runOneTurn`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ASSISTANT_DISALLOWED_TOOLS,
  ASSISTANT_MAX_TURNS,
  ASSISTANT_TOOLS,
  assistantSpawnPosture,
} from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('assistantSpawnPosture (Cebab-8x8.1.2)', () => {
  const KB = '/tmp/cebab-assistant-kb';

  test('cwd is the KB directory it is handed', () => {
    expect(assistantSpawnPosture(KB).cwd).toBe(KB);
  });

  test('permissionMode is default — never acceptEdits/bypass', () => {
    // The assistant is not Trusted, so tools route through the permission gate.
    expect(assistantSpawnPosture(KB).permissionMode).toBe('default');
  });

  test('settingSources is EMPTY — no user/project/local layers, no CLAUDE.md', () => {
    // The whole point: zero settings layers, so no project hooks, MCP servers,
    // env injections, or CLAUDE.md reach the turn. `['user']` here would leak
    // the operator's home-scope MCP servers into a help turn.
    expect(assistantSpawnPosture(KB).settingSources).toEqual([]);
  });

  test('maxTurns is the assistant cap, not a workspace budget', () => {
    expect(assistantSpawnPosture(KB).maxTurns).toBe(ASSISTANT_MAX_TURNS);
  });

  test('tools are read-only: Read, Glob, Grep only', () => {
    expect(assistantSpawnPosture(KB).tools).toEqual(['Read', 'Glob', 'Grep']);
    expect([...ASSISTANT_TOOLS]).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('skills is [] — every skill hidden, NOT omitted', () => {
    // Omitting would leave the CLI's skills on (per SDK docs); `[]` turns them
    // off. The distinction is the reason the posture is explicit here.
    expect(assistantSpawnPosture(KB).skills).toEqual([]);
  });

  test('systemPrompt is a non-empty string stating the read-only identity', () => {
    const { systemPrompt } = assistantSpawnPosture(KB);
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(systemPrompt.toLowerCase()).toContain('read-only');
  });

  test('disallowedTools is the belt: every mutating/executing built-in, and Read/Glob/Grep are NOT in it', () => {
    const { disallowedTools, tools } = assistantSpawnPosture(KB);
    // Belt-and-suspenders against a future SDK default surfacing a write tool.
    for (const t of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task']) {
      expect(disallowedTools).toContain(t);
    }
    // The belt must be disjoint from the allowed set — disallowing Read would
    // silently defeat the assistant's only capability.
    for (const survivor of tools) {
      expect(disallowedTools).not.toContain(survivor);
    }
    expect([...ASSISTANT_DISALLOWED_TOOLS]).toEqual(disallowedTools);
  });

  test('the arrays are fresh copies, not shared module constants', () => {
    // Callers spread these into an options object; a shared reference that a
    // consumer mutated would poison the next turn's posture.
    const a = assistantSpawnPosture(KB);
    expect(a.tools).not.toBe(ASSISTANT_TOOLS);
    expect(a.disallowedTools).not.toBe(ASSISTANT_DISALLOWED_TOOLS);
  });
});

describe('runOneTurn source tripwire — the trusted line survives', () => {
  // The single most important line of Cebab-8x8.1.2 cannot live in the pure
  // posture function: it reads the live project row. So it stays inline in
  // `runOneTurn`, where `shouldAutoAllow(trusted, …)` auto-allows EVERY tool
  // (including Bash) for a trusted project. An assistant must never be trusted;
  // dropping the `!assistant &&` guard would re-open that path silently. This
  // scan reddens the moment the guard is removed or reworded.
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '../ws/server.ts'), 'utf8');

  test('`const trusted = !assistant && project.trusted === 1` is present verbatim', () => {
    expect(serverSrc).toContain('const trusted = !assistant && project.trusted === 1;');
  });

  test('the posture is selected by a single isAssistantProject boolean', () => {
    // Guards against a refactor that forks the turn instead of branching one
    // boolean — the "no fork" property the issue asks for.
    expect(serverSrc).toContain('const assistant = isAssistantProject(project);');
  });
});
