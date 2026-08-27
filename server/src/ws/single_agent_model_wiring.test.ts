/**
 * Cebab-ws0.3 — the single-agent spawn actually asks for the project's model.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Every other site that
 * threads the model is pinned by running code: `projectModelSpec` has unit
 * tests, `buildSdkOptions` has its own file, and both bus register paths are
 * asserted through a real `startChainSession` / `wireOrchestratorSession` with
 * a captured `runnerFactory`. The single-agent turn has no such seam —
 * `runOneTurn` builds its options inline inside a WS handler with no injection
 * point, and mock mode cannot stand in because `runMock` ignores `model`
 * entirely. So deleting one line from that call would leave the headline
 * feature of this change dead while every test above stayed green.
 *
 * A scan is the weaker instrument and it is honest about what it proves: that
 * the call site still mentions the helper. It does not prove the spawn
 * behaves — `build_sdk_options.test.ts` and `project_model.test.ts` prove the
 * two halves it is composed from.
 *
 * TWO ANTI-VACUITY GUARDS, because a scanning gate's usual failure is passing
 * while measuring nothing:
 *   - comments are stripped first (shared helper, per Cebab-1px), so the
 *     paragraph you are reading cannot satisfy the assertion it describes;
 *   - the block must be FOUND and substantial before it is searched. A regex
 *     that stopped matching — after a rename or a reformat — would otherwise
 *     hand back an empty string, which contains no violations and passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { strippedLines } from '../test_support/strip_comments.js';

const SERVER_TS = path.join(import.meta.dirname, 'server.ts');

/** The `pickRunner({ ... })` argument object in `runOneTurn`, comments removed. */
function pickRunnerBlock(): string {
  const src = strippedLines(fs.readFileSync(SERVER_TS, 'utf8')).join('\n');
  const start = src.indexOf('pickRunner({');
  if (start === -1) return '';
  const end = src.indexOf('\n  });', start);
  return end === -1 ? '' : src.slice(start, end);
}

describe('[security] single-agent seed reads the project starting mode', () => {
  // Cebab-ws0.4, same reasoning as the model scan below: `seedPermissionMode`
  // is exercised directly by its own unit tests, but nothing proves
  // `runOneTurn` PASSES the project's column to it. Drop that third argument
  // and every seed test stays green while the setting silently stops applying
  // to any real session.
  function seedCall(): string {
    const src = strippedLines(fs.readFileSync(SERVER_TS, 'utf8')).join('\n');
    // `: seedPermissionMode(`, not `seedPermissionMode(` — the bare form
    // matches the function DEFINITION first, and scanning that would assert
    // the signature rather than the call. Since Cebab-8x8.1.2 the call is the
    // else-arm of the assistant-posture ternary (`... : seedPermissionMode(`),
    // so the `: ` prefix is what still selects the call over the definition.
    // The control below is what caught the old `= ` prefix going stale.
    const start = src.indexOf(': seedPermissionMode(');
    if (start === -1) return '';
    const end = src.indexOf(');', start);
    return end === -1 ? '' : src.slice(start, end);
  }

  test('control: the seed call site is found and is the real one', () => {
    const call = seedCall();
    expect(call.length).toBeGreaterThan(40);
    expect(call).toContain('msg.sessionId');
    expect(call).toContain('trusted');
  });

  test('it passes the project starting mode through the read-side guard', () => {
    // `resolveStartPermissionMode(...)`, not `project.start_permission_mode`
    // raw — the column is unconstrained TEXT, and the guard is what stops a
    // hand-edited `bypassPermissions` reaching the spawn.
    const call = seedCall();
    expect(call).toContain('resolveStartPermissionMode(');
    expect(call).toContain('project.start_permission_mode');
  });
});

describe('[security] single-agent spawn threads the project model', () => {
  test('control: the pickRunner call is found and is the real one', () => {
    const block = pickRunnerBlock();
    // If this fails, the scan below proves nothing — fix the locator, do not
    // delete the assertion.
    expect(block.length).toBeGreaterThan(200);
    // Since Cebab-8x8.1.2 the cwd is `posture ? posture.cwd : project.path`
    // (the assistant runs in its KB dir), so scan for the ordinary-project
    // path fragment rather than the whole old literal.
    expect(block).toContain('project.path');
    expect(block).toContain('prompt: msg.text');
  });

  test('control: there is exactly one such call to guard', () => {
    const src = strippedLines(fs.readFileSync(SERVER_TS, 'utf8')).join('\n');
    // A second spawn site would need its own model threading, and this gate
    // would silently keep checking only the first.
    expect(src.split('pickRunner({').length - 1).toBe(1);
  });

  test('it spreads projectModelSpec', () => {
    // Deleting this line is the regression: no compiler error, no failing
    // test anywhere else, and model selection stops working for every chat.
    expect(pickRunnerBlock()).toContain('projectModelSpec(');
  });

  test('it does not hand-roll the model key', () => {
    // `model: resolveModel(...)` is the plausible-looking alternative that
    // sends `undefined` to the SDK on every unconfigured project. The helper
    // returns a spreadable object precisely so no call site writes this.
    expect(pickRunnerBlock()).not.toMatch(/\bmodel:\s/);
  });
});
