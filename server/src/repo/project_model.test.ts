// Cebab-ws0.3: the two functions that decide whether a spawn asks for a model.
//
// Both exist to return UNDEFINED rather than a placeholder string, because
// `runClaude` keys off exactly that to leave `Options.model` off the options
// object. A resolver that returned `'default'` for "no choice" would look
// equivalent at every call site and would instead send the CLI a model id on
// every single turn, for every project, forever.
import { describe, expect, test } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { projectModelSpec, resolveModel, setProjectModel, upsertProject } from './projects.js';

describe('resolveModel', () => {
  test('no choice resolves to undefined', () => {
    expect(resolveModel(null)).toBe(undefined);
    expect(resolveModel(undefined)).toBe(undefined);
  });

  test('a choice resolves to itself', () => {
    expect(resolveModel('opus[1m]')).toBe('opus[1m]');
  });

  test('whitespace-only is no choice', () => {
    // A picker that wrote '' or '  ' must not spawn asking for a model named "".
    expect(resolveModel('')).toBe(undefined);
    expect(resolveModel('   ')).toBe(undefined);
  });

  test('surrounding whitespace is trimmed, the value is not otherwise touched', () => {
    expect(resolveModel('  sonnet  ')).toBe('sonnet');
    expect(resolveModel('claude-Fable-5[1m]')).toBe('claude-Fable-5[1m]');
  });

  test("the literal string 'default' is NOT special-cased here", () => {
    // Deliberate. The UI converts its Default row to null before it ever
    // reaches the DB; if some other path ever stores the CLI's own 'default'
    // alias, passing it through is correct — it is a real value the CLI
    // accepts. Swallowing it here would silently drop a legitimate choice.
    expect(resolveModel('default')).toBe('default');
  });
});

describe('projectModelSpec', () => {
  withTempDataDir('project-model-spec');

  test('an unconfigured project contributes NO model key', () => {
    const id = upsertProject('p1', '/tmp/p1').id;
    const spec = projectModelSpec(id);
    // `in`, not toBeUndefined(): the spread must add nothing at all, and
    // `{ model: undefined }` spreads a key that reaches the SDK.
    expect('model' in spec).toBe(false);
    expect(spec).toEqual({});
  });

  test('a configured project contributes its model', () => {
    const id = upsertProject('p2', '/tmp/p2').id;
    setProjectModel(id, 'sonnet');
    expect(projectModelSpec(id)).toEqual({ model: 'sonnet' });
  });

  test('a project that does not exist contributes nothing', () => {
    // The orchestrator's own spec has no project at all; a throw here would
    // take down every bus start.
    expect(projectModelSpec(999_999)).toEqual({});
  });

  test('clearing the choice removes the key again', () => {
    const id = upsertProject('p3', '/tmp/p3').id;
    setProjectModel(id, 'haiku');
    expect(projectModelSpec(id)).toEqual({ model: 'haiku' });
    setProjectModel(id, null);
    expect('model' in projectModelSpec(id)).toBe(false);
  });
});
