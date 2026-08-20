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

describe('buildSdkOptions — systemPrompt (Cebab-ws0.15)', () => {
  test('a run with nothing to say has NO systemPrompt key at all', () => {
    // This is the assertion the whole feature rests on. Cebab ships no system
    // prompt today, and the SDK turns an OMITTED one into an explicit empty
    // override — measured in `src/system_prompt_smoke.ts`. So "absent" here is
    // not tidiness: it is the difference between every healthy project
    // spawning as it always has and every healthy project newly carrying an
    // override. `systemPrompt: opts.systemPrompt` in the always-present
    // literal above reddens here.
    expect('systemPrompt' in buildSdkOptions(MINIMAL)).toBe(false);
  });

  test('a note is passed through verbatim', () => {
    const note = "MCP server status, from Cebab's most recent session start...";
    expect(buildSdkOptions({ ...MINIMAL, systemPrompt: note }).systemPrompt).toBe(note);
  });

  test('an empty note is treated as nothing to say', () => {
    // Truthiness, matching `model` directly above it. `!== undefined` would
    // send an empty-string override on any turn whose builder returned ''.
    expect('systemPrompt' in buildSdkOptions({ ...MINIMAL, systemPrompt: '' })).toBe(false);
  });

  test('it never becomes the preset object, whatever a caller passes', () => {
    // `RunOptions.systemPrompt` is a plain string on purpose: the SDK's preset
    // arm would swap the run onto Claude Code's entire system prompt, which is
    // a posture change and not a variation on this feature. Widening the field
    // to `Options['systemPrompt']` reddens here.
    const o = buildSdkOptions({ ...MINIMAL, systemPrompt: 'a note' });
    expect(typeof o.systemPrompt).toBe('string');
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
