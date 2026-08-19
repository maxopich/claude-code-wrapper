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

describe('[security] single-agent spawn threads the project model', () => {
  test('control: the pickRunner call is found and is the real one', () => {
    const block = pickRunnerBlock();
    // If this fails, the scan below proves nothing — fix the locator, do not
    // delete the assertion.
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain('cwd: project.path');
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
