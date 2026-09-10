// What `runClaude` hands the SDK, pinned.
//
// This file exists because `query()` is never mocked anywhere in this repo, so
// the options assembly had no coverage at all: a change to the `??` defaults, to
// which keys are conditional, or to the `disallowedTools` union would have been
// caught by nothing. `mcpDenialOptions` next door is pinned for the same reason
// and says so in its own header.
//
// THE PROPERTY THAT MATTERS MOST HERE is absent-vs-undefined. `Options` is
// handed to the CLI; a key present with value `undefined` is not always the same
// as a key that was never set, and Cebab's guarantee for every optional run
// feature is that an operator who has not used it gets a byte-identical spawn.
// Every assertion below uses `in`, never `toBeUndefined()` — the latter passes
// on both shapes and would defend nothing.
import { describe, expect, test } from 'vitest';
import { buildSdkOptions, type RunOptions } from './claude.js';

const MINIMAL: RunOptions = { cwd: '/tmp/project', prompt: 'hi' };

describe('buildSdkOptions — model', () => {
  test('a run with no model chosen has NO model key at all', () => {
    const o = buildSdkOptions(MINIMAL);
    // Reddens on `model: opts.model` in the literal, which is the natural way
    // to write this and the one that silently changes every existing spawn.
    expect('model' in o).toBe(false);
  });

  test('a chosen model is passed through verbatim', () => {
    expect(buildSdkOptions({ ...MINIMAL, model: 'opus[1m]' }).model).toBe('opus[1m]');
  });

  test('the value is not normalised, parsed, or prefixed', () => {
    // The CLI's catalogue ships bracketed context-window variants and bare
    // aliases side by side (`opus[1m]`, `sonnet`, `claude-fable-5[1m]`). Cebab
    // stores and forwards whatever the CLI called it; inventing a canonical
    // form here is how a picker starts sending ids that do not exist.
    for (const m of ['sonnet', 'claude-fable-5[1m]', 'claude-opus-5[1m]']) {
      expect(buildSdkOptions({ ...MINIMAL, model: m }).model).toBe(m);
    }
  });

  test('an empty-string model is treated as no choice', () => {
    // A cleared picker must not spawn asking for a model named "".
    expect('model' in buildSdkOptions({ ...MINIMAL, model: '' })).toBe(false);
  });
});

describe('buildSdkOptions — systemPrompt (Cebab-6s27)', () => {
  /**
   * THIS BLOCK IS THE REVERSE OF WHAT IT USED TO ASSERT, deliberately.
   *
   * It previously pinned "a run with nothing to say has NO systemPrompt key at
   * all", on the measured premise that an omitted option meant an empty prompt,
   * so absence kept every healthy spawn byte-identical. That premise stopped
   * holding (`Cebab-6s27`) and absence silently became "whatever this SDK
   * release decides", which is how a note meant to ADD a paragraph came within
   * one release of REPLACING the agent's instructions.
   *
   * So the invariant is now the opposite one: the key is ALWAYS present, because
   * a posture Cebab states cannot be moved by someone else's default. The old
   * cases are rewritten rather than deleted — see
   * `project_a_test_can_defend_the_bug`.
   */
  test('every ordinary run states the preset explicitly', () => {
    const o = buildSdkOptions(MINIMAL);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  test('a run with nothing to add sends the bare preset, with no append key', () => {
    // `append: undefined` would be a present-but-empty key on every healthy
    // spawn. Truthiness at the call site is what keeps it absent; `!== undefined`
    // there reddens here.
    const o = buildSdkOptions(MINIMAL);
    expect('append' in (o.systemPrompt as object)).toBe(false);
    expect(
      'append' in (buildSdkOptions({ ...MINIMAL, systemPromptAppend: '' }).systemPrompt as object),
    ).toBe(false);
  });

  test("Cebab's note is APPENDED, and the preset survives beside it", () => {
    // The whole point of the change. Both halves are asserted together on
    // purpose: a fix that carried the note but dropped the preset would satisfy
    // a test that only looked for the note.
    const note = "MCP server status, from Cebab's most recent session start...";
    const o = buildSdkOptions({ ...MINIMAL, systemPromptAppend: note });
    expect(o.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: note,
    });
  });

  test("a full override replaces everything, and is the assistant's alone", () => {
    // The help assistant is a different product with its own identity and wants
    // none of Claude Code's prompt. It is the ONLY caller that may do this.
    const o = buildSdkOptions({ ...MINIMAL, systemPrompt: 'You are the Cebab help assistant.' });
    expect(o.systemPrompt).toBe('You are the Cebab help assistant.');
  });

  test('an override wins over an append — there is nothing to append to', () => {
    // Anti-vacuity for the branch: if both arrive, the result must not silently
    // become a preset carrying the override as its append, which would give the
    // assistant Claude Code's instructions it deliberately declines.
    const o = buildSdkOptions({
      ...MINIMAL,
      systemPrompt: 'assistant identity',
      systemPromptAppend: 'a note that must not resurrect the preset',
    });
    expect(o.systemPrompt).toBe('assistant identity');
  });
});

describe('buildSdkOptions — tools + skills (Cebab-8x8.1.2)', () => {
  test('a run that names neither has NEITHER key — absent, not undefined', () => {
    // The assistant is the only caller that passes these; every other spawn
    // must stay byte-identical. `tools: opts.tools` / `skills: opts.skills` in
    // the always-present literal above would redden here.
    const o = buildSdkOptions(MINIMAL);
    expect('tools' in o).toBe(false);
    expect('skills' in o).toBe(false);
  });

  test('a tools array is passed through verbatim', () => {
    const o = buildSdkOptions({ ...MINIMAL, tools: ['Read', 'Glob', 'Grep'] });
    expect(o.tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('tools: [] survives (guarded by !== undefined) — "no built-in tools"', () => {
    // `[]` is a real value (disable every built-in), distinct from omitting the
    // key. A truthiness guard would forward it too (arrays are truthy), but the
    // property under test is that `[]` reaches the SDK rather than being dropped.
    const o = buildSdkOptions({ ...MINIMAL, tools: [] });
    expect('tools' in o).toBe(true);
    expect(o.tools).toEqual([]);
  });

  test('the tools preset object is accepted (SDK shape, not narrowed away)', () => {
    const o = buildSdkOptions({ ...MINIMAL, tools: { type: 'preset', preset: 'claude_code' } });
    expect(o.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  test('skills: [] survives — the assistant hides every skill', () => {
    // Omitting skills is NOT skills-off (the CLI keeps its own on); the empty
    // array is how a caller actually turns them off, so it must reach the SDK.
    const o = buildSdkOptions({ ...MINIMAL, skills: [] });
    expect('skills' in o).toBe(true);
    expect(o.skills).toEqual([]);
  });

  test('a named skills list is passed through verbatim', () => {
    const o = buildSdkOptions({ ...MINIMAL, skills: ['pdf', 'docx'] });
    expect(o.skills).toEqual(['pdf', 'docx']);
  });
});

describe('buildSdkOptions — the pre-existing assembly (control)', () => {
  // These pass before this PR as well as after. They are here deliberately: the
  // extraction of `buildSdkOptions` out of `runClaude` had to be behaviour-
  // neutral, and an extraction with no test is a refactor nobody checked.
  test('the always-present keys keep their defaults', () => {
    const o = buildSdkOptions(MINIMAL);
    expect(o.cwd).toBe('/tmp/project');
    expect(o.settingSources).toEqual(['user']);
    expect(o.includePartialMessages).toBe(true);
    expect(o.permissionMode).toBe('default');
  });

  test('the optional keys are absent, not undefined', () => {
    const o = buildSdkOptions(MINIMAL);
    for (const k of [
      'sessionId',
      'resume',
      'maxTurns',
      'mcpServers',
      'disallowedTools',
      'settings',
      'allowDangerouslySkipPermissions',
      'model',
      'tools',
      'skills',
    ]) {
      expect({ key: k, present: k in o }).toEqual({ key: k, present: false });
    }
  });

  test('maxTurns: 0 survives (guarded by !== undefined, not truthiness)', () => {
    expect(buildSdkOptions({ ...MINIMAL, maxTurns: 0 }).maxTurns).toBe(0);
  });

  test('caller disallowedTools and MCP denials union rather than overwrite', () => {
    const o = buildSdkOptions({
      ...MINIMAL,
      disallowedTools: ['Bash'],
      deniedMcpServers: ['sketchy'],
    });
    expect(o.disallowedTools).toEqual(['Bash', 'mcp__sketchy__*']);
    expect(o.settings).toEqual({ deniedMcpServers: [{ serverName: 'sketchy' }] });
  });

  test('settingSources is not widened here', () => {
    // Trust decides this in the WS layer. A default of anything but ['user']
    // would auto-load a sibling repo's hooks on first click.
    expect(
      buildSdkOptions({ ...MINIMAL, settingSources: ['user', 'project', 'local'] }).settingSources,
    ).toEqual(['user', 'project', 'local']);
  });
});
