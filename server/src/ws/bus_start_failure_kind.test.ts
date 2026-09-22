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

  // `Cebab-2ros` — the `cancelledMessage` override, both directions in ONE
  // test so the case reddens on revert. The override-used half FAILS on the
  // pre-change one-arg function (the second argument is ignored, so a declined
  // gate keeps the default *start* wording, not the resume wording). Folding
  // the anti-vacuity half in beside it — rather than as its own test() —
  // follows this file's existing rule: a behavioural assertion on a genuine
  // Error is identical before and after this change (the raw-error path never
  // touches `cancelledMessage`), so on its own it passes with OR without the
  // change and guards nothing, which is exactly what the revert-check flags.
  // Here it still does its job: it reddens if `classifyBusStartFailure` ever
  // returns `cancelledMessage` unconditionally (as do the existing genuine-throw
  // cases above, through the default).
  const RESUME_OVERRIDE =
    'Resume cancelled: you declined a trust or environment prompt, so the session was not re-attached.';

  test('the cancelled-message override is used for a cancel, IGNORED for a real failure', () => {
    // Override used: a declined gate carries the resume wording, not the
    // default start wording — reverting to the one-arg function reddens this.
    const cancelled = classifyBusStartFailure(
      new GateAbandonedError('session-start', 'cancelled'),
      RESUME_OVERRIDE,
    );
    expect(cancelled.kind).toBe('aborted');
    expect(cancelled.message).toBe(RESUME_OVERRIDE);

    // ANTI-VACUITY: override IGNORED for a real failure. An implementation that
    // returned `cancelledMessage` unconditionally would report a genuine ENOENT
    // resume failure as a quiet cancellation — greener test, worse product.
    const crashed = classifyBusStartFailure(new Error('ENOENT: workspace gone'), RESUME_OVERRIDE);
    expect(crashed.kind).toBe('process_crashed');
    expect(crashed.message).toBe('ENOENT: workspace gone');
  });
});

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/**
 * Slice out the `start_multi_agent` case. `resume_multi_agent` also releases
 * the start claim in a `finally` — the same class of defect, now guarded by
 * `resumeMultiAgentRegion` below (`Cebab-2ros`) — so an unscoped scan would
 * drag that third site in and a revert of either start arm alone would still
 * leave a passing count. One region per site keeps a fix to one arm from
 * carrying the other.
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

/**
 * `Cebab-2ros` — slice out the `resume_multi_agent` case only. Mirrors
 * `startMultiAgentRegion` and carries the same two stale-anchor assertions, so
 * a renamed case reddens here rather than scanning nothing. Kept a separate
 * region from the start arms on purpose: one region per site is what lets a
 * revert of any single catch redden without the others' bodies masking it.
 */
export function resumeMultiAgentRegion(source: string): string {
  const stripped = stripComments(source);
  const from = stripped.indexOf("case 'resume_multi_agent': {");
  const to = stripped.indexOf("case 'continue_multi_agent': {");
  expect(from, "the resume_multi_agent case moved — this gate's anchor is stale").toBeGreaterThan(
    -1,
  );
  expect(to, 'the case after resume_multi_agent moved — anchor is stale').toBeGreaterThan(from);
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

// The pre-fix shape of the resume catch, verbatim — the real shape this bead
// replaced. Used as a control so the resume guard cannot pass vacuously (a
// scanner that saw nothing would pass forever); it must find this AND match
// the hard-coded-kind pattern the guard asserts is absent from the real catch.
const PRE_FIX_RESUME = [
  '        });',
  '        } catch (err) {',
  "          console.error('[ws] resume_multi_agent failed', err);",
  '          send(conn.ws, {',
  "            type: 'wrapper_error',",
  '            sessionId: msg.sessionId,',
  "            kind: 'process_crashed',",
  "            message: 'Failed to resume this session.',",
  '          });',
  '        } finally {',
  '          releaseSessionStart(resumeClaimId);',
  '        }',
].join('\n');

describe('the resume_multi_agent catch routes through classifyBusStartFailure [regression]', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  // One test, so every assertion reddens on revert (restore the hard-coded
  // `kind: 'process_crashed'` at the resume catch and the guard below fails).
  test('the resume catch does not hard-code the failure kind (with anti-vacuity + control)', () => {
    const bodies = startCatchBodies(resumeMultiAgentRegion(source));

    // Anti-vacuity floor: exactly the one resume catch. A rename that made the
    // region or scanner return nothing would loop over an empty list and pass.
    expect(bodies, 'expected exactly the resume_multi_agent start catch').toHaveLength(1);

    // Control (the other direction): a scanner that saw nothing would pass the
    // guard forever. Prove it flags the exact shape this bead replaced.
    const [ctl] = startCatchBodies(PRE_FIX_RESUME);
    expect(ctl, 'the scanner failed to see the pre-fix resume catch shape').toBeDefined();
    expect(ctl).toMatch(/kind:\s*'/);

    // The guard: the catch does not hard-code the kind; it routes the error
    // through the classifier so a declined trust/env gate (an AbortError) is
    // `aborted`, not a crash.
    expect(
      bodies[0],
      'The resume_multi_agent catch hard-codes `kind: ...`. A declined ' +
        'trust/env gate rejects with an AbortError here and must classify as ' +
        '`aborted`, not a crash. Route it through `classifyBusStartFailure(...)`.',
    ).not.toMatch(/kind:\s*'/);
    expect(bodies[0]).toContain('classifyBusStartFailure(');
    // The resume wording must be passed AT THIS SITE; the one-arg form would
    // tell the operator a re-attach "never began". Comment-stripped region, so
    // only the real argument satisfies it. The outcome itself is pinned end to
    // end in resume_gate_cancel.test.ts.
    expect(bodies[0]).toContain("'Resume cancelled:");
    // Pins the sticky-toast regression: a sessionless bus `wrapper_error` is
    // toasted as a crash regardless of `kind`, so the sessionId must stay.
    expect(bodies[0]).toContain('sessionId: msg.sessionId');
  });
});
