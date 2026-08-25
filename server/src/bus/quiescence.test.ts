/**
 * `Cebab-vie.8` — the four conjuncts, one at a time.
 *
 * `decideStrandedRun` is where the whole detector's safety lives: firing it on
 * a healthy run puts a red row into a transcript that is fine. So every
 * conjunct gets a matched pair — one input that fires and the same input with
 * that conjunct flipped — because a single-direction assertion is satisfied by
 * `return null` (for the negatives) or by `return decision` (for the positive).
 */
import { describe, expect, test } from 'vitest';
import { decideStrandedRun, strandedRunText, type StrandedCause } from './quiescence.js';

const DROP: StrandedCause = {
  reasonCode: 'muted_source',
  source: 'scribe',
  destination: 'orchestrator',
  kind: 'reply',
};

/** The wedge: nothing running, nothing ended, nothing held, tail on an agent. */
const WEDGED = {
  turnsInFlight: 0,
  ended: false,
  anyGateHeld: false,
  tail: { destination: 'scribe', kind: 'prompt' },
  cause: DROP,
};

describe('decideStrandedRun', () => {
  test('fires on the wedge, and names the agent the tail points at', () => {
    // The positive control. Without it, every negative below is satisfied by a
    // function that never fires at all.
    expect(decideStrandedRun(WEDGED)).toEqual({ awaitingAgent: 'scribe', cause: DROP });
  });

  test('does not fire while a turn is still running', () => {
    // Reddens if the caller's count is replaced by "the turn I just watched
    // end" — which is true on every parallel hop of a multi-worker run.
    expect(decideStrandedRun({ ...WEDGED, turnsInFlight: 1 })).toBeNull();
  });

  test('does not fire on a session that has ended', () => {
    // The budget-exhaust and Stop paths both reach a settle with `ended` set;
    // teardown has already written the trail's explanation.
    expect(decideStrandedRun({ ...WEDGED, ended: true })).toBeNull();
  });

  test('does not fire while any turn queue is held', () => {
    // The pause-on-dangerous hold ends the worker's turn with the tail still
    // pointing at that worker. The operator has Continue/Abandon; telling them
    // the run is wedged would be false and would bury the real affordance.
    expect(decideStrandedRun({ ...WEDGED, anyGateHeld: true })).toBeNull();
  });

  describe('does not fire when the tail is not awaiting an agent', () => {
    // These are the ordinary shapes, and the reason a general detector is safe
    // rather than mute-specific: each one is a run that is idle for a reason
    // the operator can already see.
    test.each([
      ['the orchestrator answered the operator', { destination: 'user', kind: 'final' }],
      ['a chain reached its terminator', { destination: '_sink', kind: 'final' }],
      ['a worker failure wrote its own row', { destination: 'user', kind: 'error' }],
      ['the budget exhausted', { destination: '_sink', kind: 'error' }],
    ])('%s', (_label, tail) => {
      expect(decideStrandedRun({ ...WEDGED, tail })).toBeNull();
    });

    test('a run with no events at all', () => {
      // An R-B session sitting on `awaitingContinue` never calls `deliver`, so
      // it never reaches a settle — but a router torn down before its first
      // hop would, and there is nobody to be waiting on.
      expect(decideStrandedRun({ ...WEDGED, tail: null })).toBeNull();
      expect(decideStrandedRun({ ...WEDGED, tail: undefined })).toBeNull();
    });
  });

  test('fires with no cause when nothing was dropped', () => {
    // `cause: null` is a real answer, not a gap: the woken agent simply ended
    // its turn without a `bus_send`. Reddens if the decision is gated on
    // having a drop to blame, which would miss that whole second route in.
    expect(decideStrandedRun({ ...WEDGED, cause: null })).toEqual({
      awaitingAgent: 'scribe',
      cause: null,
    });
  });
});

describe('strandedRunText', () => {
  const withDrop = strandedRunText({
    awaitingAgent: 'scribe',
    cause: DROP,
    recovery: 'orchestrator-prompt',
  });

  test('says the agent is NOT working', () => {
    // The single most important sentence: the bar said `scribe working` for
    // seven minutes, so the row that replaces it has to contradict that
    // directly rather than merely being informative.
    expect(withDrop).toContain('Nothing is running in this session');
    expect(withDrop).toContain('its turn has ended');
    expect(withDrop).toContain('`scribe`');
  });

  test('names the drop and its reason code verbatim', () => {
    expect(withDrop).toContain('muted_source');
    expect(withDrop).toContain('`scribe` → `orchestrator`');
    expect(withDrop).toContain('never re-delivered');
  });

  test('says the hop budget will not rescue the run', () => {
    // Measured in the bead: hops stop advancing on a dropped event, so the cap
    // can never be reached and the session never self-terminates. An operator
    // who assumes the budget is a backstop waits forever.
    expect(withDrop).toContain('hop budget will not stop the run');
  });

  test('orchestrator mode offers the prompt; chain mode does not', () => {
    // The bead's own notes claimed Stop was the only exit in orchestrator
    // mode. It is not — the composer renders in exactly this state. Chain is
    // the mode where that claim is true (`sendUserPrompt: null`), so the two
    // strings must differ and each must be right about its own mode.
    const chain = strandedRunText({ awaitingAgent: 'beta', cause: DROP, recovery: 'stop-only' });
    expect(withDrop).toContain('Send a prompt below');
    expect(withDrop).not.toContain('only way out');
    expect(chain).toContain('only way out');
    expect(chain).not.toContain('Send a prompt below');
  });

  test('with no cause, it says the turn ended without sending', () => {
    const quiet = strandedRunText({
      awaitingAgent: 'scribe',
      cause: null,
      recovery: 'orchestrator-prompt',
    });
    expect(quiet).toContain('ended without sending anything on the bus');
    // And does not invent a drop that did not happen.
    expect(quiet).not.toContain('dropped at the router');
  });
});
