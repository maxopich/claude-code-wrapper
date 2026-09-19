import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { classifyBusStartFailure } from './server.js';
import { GateAbandonedError } from '../gate_abandon.js';
import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-2m7n` — a bus start cancelled by the operator is not a crash.
 *
 * `Cebab-6fax.17` taught the WS dispatch catch (and the single-agent turn
 * path) that an operator DECLINING a trust or env-injection prompt rejects the
 * parked gate with a `GateAbandonedError` (`name === 'AbortError'`) and must
 * surface as `aborted`, not `process_crashed`. But both `start_multi_agent`
 * arms await `gateProjectsForSpawn` inside a try whose `finally` releases the
 * start claim, and catch its rejection LOCALLY — so the fix never reached them
 * and a declined trust prompt during a bus start still shipped as a crash
 * (a sticky red "Server error … process_crashed" banner).
 *
 * Two halves, both pinned here:
 *   1. `classifyBusStartFailure` maps the error correctly (behavioural).
 *   2. Both bus-start catch arms actually route through it, rather than
 *      hard-coding the kind again (source-anchored — this is the assertion
 *      that reddens on the pre-fix source, for the same reason
 *      `start_claim_release.test.ts` is a source test: the catch is inline in
 *      a switch case that cannot be isolated without a full WS round-trip
 *      through a gate that parks on an operator).
 */
describe('classifyBusStartFailure — the mapping', () => {
  test('a declined gate is `aborted` with a plain-language message', () => {
    const { kind, message } = classifyBusStartFailure(
      new GateAbandonedError('session-start', 'cancelled'),
    );
    expect(kind).toBe('aborted');
    // Not the raw "session-start gate abandoned: cancelled" jargon.
    expect(message).not.toContain('gate abandoned');
    expect(message.toLowerCase()).toContain('cancelled');
  });

  test('so is any AbortController abort', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyBusStartFailure(err).kind).toBe('aborted');
  });

  test('ANTI-VACUITY: a genuine start throw stays `process_crashed` and keeps its message', () => {
    // Widening this would hide a real start failure behind the quiet
    // cancellation styling — worse than the defect being fixed.
    const { kind, message } = classifyBusStartFailure(new Error('ENOENT: workspace gone'));
    expect(kind).toBe('process_crashed');
    expect(message).toBe('ENOENT: workspace gone');
  });

  test('a non-Error rejection does not throw on the way through', () => {
    expect(classifyBusStartFailure('a string')).toEqual({
      kind: 'process_crashed',
      message: 'a string',
    });
    expect(classifyBusStartFailure(undefined).kind).toBe('process_crashed');
  });
});

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/**
 * Slice out the `start_multi_agent` case. `resume_multi_agent` also releases
 * the start claim in a `finally` and hard-codes its own kind — the same class
 * of defect, tracked separately — so an unscoped scan would drag that third
 * site in and this bead's fix would not turn it green.
 */
export function startMultiAgentRegion(source: string): string {
  const stripped = stripComments(source);
  const from = stripped.indexOf("case 'start_multi_agent': {");
  const to = stripped.indexOf("case 'multi_agent_user_prompt': {");
  expect(from, "the start_multi_agent case moved — this gate's anchor is stale").toBeGreaterThan(
    -1,
  );
  expect(to, 'the case after start_multi_agent moved — anchor is stale').toBeGreaterThan(from);
  return stripped.slice(from, to);
}

const CATCH_OPEN = '} catch (err) {';
const FINALLY_OPEN = '} finally {';

/**
 * Every `catch (err)` body in `region` whose matching `finally` releases the
 * start claim. Deterministic string scanning (no regex — the tempered-quantifier
 * form the linter flags as unsafe): for each `} catch (err) {`, accept it only
 * when the very next block opener is a `} finally {` (no intervening catch) and
 * that finally releases the start claim. The top-of-case guards, the claim
 * failures and the `resolveOrchestratorWorkers` catch all send `process_crashed`
 * too, so keying on that literal alone would false-match; the
 * `finally { … releaseSessionStart }` picks out exactly the two start-arm
 * catches that wrap the gate + start.
 */
export function startCatchBodies(region: string): string[] {
  const bodies: string[] = [];
  for (let at = region.indexOf(CATCH_OPEN); at !== -1; at = region.indexOf(CATCH_OPEN, at + 1)) {
    const bodyStart = at + CATCH_OPEN.length;
    const nextFinally = region.indexOf(FINALLY_OPEN, bodyStart);
    if (nextFinally === -1) continue;
    // Another catch before the finally means this catch is not the one the
    // finally closes — skip it.
    const nextCatch = region.indexOf(CATCH_OPEN, bodyStart);
    if (nextCatch !== -1 && nextCatch < nextFinally) continue;
    // The finally must release the start claim. Bound the look to the finally
    // block itself (its closing brace precedes the next block opener).
    const finallyBody = region.slice(nextFinally + FINALLY_OPEN.length, nextFinally + 400);
    if (!finallyBody.includes('releaseSessionStart')) continue;
    bodies.push(region.slice(bodyStart, nextFinally));
  }
  return bodies;
}

describe('both bus-start catches route through classifyBusStartFailure [regression]', () => {
  const region = startMultiAgentRegion(fs.readFileSync(SERVER_TS, 'utf8'));

  // The pre-fix shape of a start-arm catch, verbatim. Used as a control so the
  // guard below cannot pass vacuously.
  const PRE_FIX = [
    '        });',
    '        } catch (err) {',
    '          const message = err instanceof Error ? err.message : String(err);',
    "          send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });",
    '        } finally {',
    '          releaseSessionStart(startClaimId);',
    '        }',
  ].join('\n');

  // One test, so every assertion here reddens when the source fix is reverted
  // (the guard loop fails on the pre-fix `kind: 'process_crashed'`). The
  // anti-vacuity count and the predicate control are folded in rather than
  // split into their own always-green cases — a separate test that passes with
  // OR without the change guards nothing, which is exactly what the
  // revert-check flags. They stay as assertions because they still keep this
  // test honest: the count proves both arms were found, and the control proves
  // the scanner can actually see the shape it is asserting the absence of.
  test('neither start-arm catch hard-codes the failure kind (with anti-vacuity + control)', () => {
    const bodies = startCatchBodies(region);

    // Anti-vacuity: orchestrator + chain. If a rename made this zero (or one),
    // the guard loop would pass over a short list without checking the arm it
    // was meant to guard (`project_gates_pass_vacuously`).
    expect(bodies, 'expected exactly the orchestrator + chain start catches').toHaveLength(2);

    // Control (the other direction): a scanner that returned [] would pass the
    // guard forever. Prove it flags the exact shape this bead replaced.
    const [ctl] = startCatchBodies(PRE_FIX);
    expect(ctl, 'the scanner failed to see the pre-fix catch shape').toBeDefined();
    expect(ctl).toMatch(/kind:\s*'/);
    expect(ctl).not.toContain('classifyBusStartFailure(err)');

    // The guard: neither real catch hard-codes the kind; both route the error
    // through the classifier so a declined trust/env gate (an AbortError) is
    // `aborted`, not a crash.
    for (const body of bodies) {
      expect(
        body,
        'A bus-start catch hard-codes `kind: ...`. A declined trust/env gate ' +
          'rejects with an AbortError here and must classify as `aborted`, not ' +
          'a crash. Route it through `classifyBusStartFailure(err)`.',
      ).not.toMatch(/kind:\s*'/);
      expect(body).toContain('classifyBusStartFailure(err)');
    }
  });
});
