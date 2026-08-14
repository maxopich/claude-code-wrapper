/**
 * Register W29: the call sites that carry an operator DECISION must route
 * through `sendThenApply`, so the UI cannot show a decision that never went
 * out.
 *
 * WHY A SOURCE GATE. `web/src/sendThenApply.test.ts` proves the helper honours
 * the ordering, and it would stay green if `decidePermission` went back to
 * dispatching its optimistic `permission_decided` first and calling `send`
 * afterwards — which is precisely how the defect shipped. PR #320 and #322
 * both learned this the same way: a helper passing proves nothing about its
 * call sites, and the source gate written for #320 is what turned up two more
 * nobody had looked at.
 *
 * WHY IT IS NOT IN `web/`. `web/tsconfig.json` sets `"types": []` so the web
 * program has no `@types/node`, and `web/src/nodeTypeIsolation.test.ts` fails
 * typecheck if that ever stops being true. A web-side test therefore cannot
 * read a file. `scripts/` is where this repo's source-level claims already
 * live (`busSafetyClaims`, `exportConsumers`, `sideChannelSeamStability`).
 *
 * SCOPE, stated so a later reader does not mistake it for more than it is:
 * this checks the sends that apply optimistic state, discard operator input,
 * or have no other feedback. The ~50 remaining `send` call sites in App.tsx
 * are deliberately not covered — their failure is now at least visible in the
 * console, and forcing every list-refresh through a decision helper would be
 * noise.
 *
 * Cebab-u0s widened it from the two W29 sites to eleven, and added the
 * child-component half. That half is not decoration: `ParticipantControlMenu`
 * closed its modal AND the modal closed itself (its own comment said so —
 * "closeModal() here is just defensive"), so gating only the menu would have
 * left the modal closing anyway. A source gate that checked one of the two
 * would have passed while the bug survived.
 *
 * ONE DOCUMENTED EXEMPTION: `archiveSession`. It applies no optimistic state,
 * is idempotent and reversible, and its row stays on screen to click again, so
 * a dropped send costs a second click and nothing else. Asserted below as an
 * exemption rather than omitted, so it reads as a decision.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(REPO_ROOT, 'web', 'src', 'App.tsx');
const AGENT_CONTROL = join(REPO_ROOT, 'web', 'src', 'components', 'agentControl');
const MENU = join(AGENT_CONTROL, 'ParticipantControlMenu.tsx');
const MULTI_AGENT_TAB = join(REPO_ROOT, 'web', 'src', 'components', 'MultiAgentTab.tsx');

/**
 * Comments stripped before matching. Every function below is named in the
 * prose right above it, so a scan over raw text would be satisfied by the
 * explanation rather than the code.
 */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * The body of `function <name>(...)` — or of `const <name> = …` for the
 * `useCallback` senders — up to the first line that dedents to `}` or `);`.
 */
function bodyOf(code, name) {
  const starts = [code.indexOf(`function ${name}(`), code.indexOf(`const ${name} = `)].filter(
    (i) => i !== -1,
  );
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const ends = ['\n  }', '\n  );'].map((m) => code.indexOf(m, start)).filter((i) => i !== -1);
  return ends.length === 0 ? code.slice(start) : code.slice(start, Math.min(...ends));
}

describe('App.tsx optimistic sends go through sendThenApply (W29, Cebab-u0s)', () => {
  /** Every sender that calls the helper directly. */
  const SITES = [
    // W29
    'decidePermission',
    'interruptSession',
    // Cebab-u0s
    'submitStopReason',
    'sendMultiAgentUserPrompt',
    'continueMultiAgent',
    'retryWorker',
    'abandonSession',
    'continueThroughMutation',
    'answerQuestion',
    'sendControlVerb',
  ];

  /** The five control verbs reach the helper via the shared `sendControlVerb`. */
  const CONTROL_VERBS = [
    'muteParticipant',
    'unmuteParticipant',
    'pauseParticipant',
    'resumeParticipant',
    'kickParticipant',
  ];

  test('the helper and every call site still exist', () => {
    // Positive control. Without it, a rename would make every assertion below
    // pass by matching nothing.
    const code = codeOf(APP);
    expect(code).toContain('export function sendThenApply(');
    for (const name of [...SITES, ...CONTROL_VERBS, 'archiveSession']) {
      expect(bodyOf(code, name), `${name} not found in App.tsx`).not.toBeNull();
    }
  });

  test.each(SITES)('%s routes through sendThenApply', (name) => {
    const body = bodyOf(codeOf(APP), name);
    expect(body).toContain('sendThenApply({');
  });

  test.each(CONTROL_VERBS)('%s routes through sendControlVerb', (name) => {
    // Two hops, asserted as two hops so this does not read as a stronger claim
    // than it is: the verb reaches the helper only because `sendControlVerb`
    // does — which the SITES case above pins.
    const body = bodyOf(codeOf(APP), name);
    expect(body).toContain('return sendControlVerb(');
  });

  test('archiveSession is the documented exemption, not an oversight', () => {
    const body = bodyOf(codeOf(APP), 'archiveSession');
    expect(body).not.toContain('sendThenApply({');
    // The reason has to survive with it — an exemption nobody wrote down is
    // indistinguishable from a site nobody looked at. Read RAW, because
    // `codeOf` strips the very comment being asserted, and read FORWARD from
    // the signature, because the reason lives inside the body.
    const raw = readFileSync(APP, 'utf8');
    const at = raw.indexOf('function archiveSession(');
    expect(at).toBeGreaterThan(-1);
    expect(raw.slice(at, at + 1200)).toContain('deliberately NOT routed through');
  });

  /**
   * The ordering claim, per site: the optimistic dispatch must appear AFTER
   * `sendThenApply({` in the source, which is only possible if it sits inside
   * `apply:`. This is the exact regression — a dispatch at the top of the
   * function, before an unchecked send.
   */
  test.each([
    ['decidePermission', 'permission_decided'],
    ['submitStopReason', 'stop_reason_dismissed'],
    ['continueMultiAgent', 'ma_clear_awaiting'],
    ['retryWorker', 'ma_clear_pending_retry'],
    ['continueThroughMutation', 'ma_clear_pending_mutation'],
    ['answerQuestion', 'ma_clear_pending_question'],
  ])('%s dispatches %s only inside the helper', (name, action) => {
    const body = bodyOf(codeOf(APP), name);
    const helperAt = body.indexOf('sendThenApply({');
    const dispatchAt = body.indexOf(action);
    expect(helperAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(helperAt);
  });
});

describe('undeliverable notifications are distinguishable (Cebab-u0s)', () => {
  /**
   * Eleven near-identical `onUndeliverable` blocks is exactly the shape that
   * produces a copy-pasted `dedupeKey`, and a duplicate is not cosmetic:
   * operational notifications coalesce by key, so two different failures would
   * collapse into one toast and the operator would be told about one of them.
   */
  test('every undeliverable dedupeKey is unique', () => {
    const code = codeOf(APP);
    // Matches the key wherever it is written, because it is written two ways:
    // as a `dedupeKey:` property at the nine direct sites, and as a positional
    // argument to `sendControlVerb` at the five control verbs. Keying on
    // `dedupeKey:` alone silently skipped the second group — five of the
    // fourteen — which is the half most at risk of a copy-paste.
    const keys = [...code.matchAll(/`([a-z_]+_undeliverable):/g)].map((m) => m[1]);
    // Positive control: an assertion over an empty list passes for free.
    expect(keys.length).toBe(14);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('each treated site names itself in its key', () => {
    const code = codeOf(APP);
    for (const [name, key] of [
      ['submitStopReason', 'stop_reason_undeliverable'],
      ['sendMultiAgentUserPrompt', 'ma_user_prompt_undeliverable'],
      ['continueMultiAgent', 'continue_multi_agent_undeliverable'],
      ['retryWorker', 'retry_worker_undeliverable'],
      ['abandonSession', 'abandon_session_undeliverable'],
      ['continueThroughMutation', 'continue_through_mutation_undeliverable'],
      ['answerQuestion', 'ask_user_answer_undeliverable'],
    ]) {
      expect(bodyOf(code, name), `${name} not found`).toContain(key);
    }
  });

  test('the five control verbs key on the participant, not just the session', () => {
    // A session-only key would coalesce a failed mute on worker-a with a
    // failed kick on worker-b.
    //
    // The leading backtick is load-bearing. Without it the `mute` assertion
    // could never fail, because `unmute_participant_undeliverable:…` CONTAINS
    // `mute_participant_undeliverable:…` — so a genuinely broken mute key
    // passed on the strength of the unmute line next to it. The revert-check
    // is what surfaced that; the first version of this test was vacuous for
    // one of its five verbs.
    const body = bodyOf(codeOf(APP), 'sendControlVerb');
    expect(body).toContain('dedupeKey,');
    for (const verb of ['mute', 'unmute', 'pause', 'resume', 'kick']) {
      expect(codeOf(APP)).toContain(
        `\`${verb}_participant_undeliverable:\${sessionId}:\${projectId}\``,
      );
    }
  });
});

describe('the child components gate their own reset (Cebab-u0s)', () => {
  /**
   * `handleSubmit` must not reach `onClose()` unconditionally: the call to
   * `onSubmit(...)` has to be followed by a `return` that precedes it. Written
   * as an index ordering because the three modals spell the guard differently
   * (`if (!onSubmit(…)) return;` vs a `const sent = …` temporary), and pinning
   * one spelling would fail on a refactor that kept the behaviour.
   *
   * The search for `return` starts AFTER `onSubmit(` on purpose — every
   * `handleSubmit` opens with an unrelated `if (!canSubmit) return;`.
   */
  test.each(['MuteReasonModal', 'KickModal', 'PauseReasonModal'])(
    '%s closes only after a delivered submit',
    (modal) => {
      const body = bodyOf(codeOf(join(AGENT_CONTROL, `${modal}.tsx`)), 'handleSubmit');
      expect(body, `handleSubmit not found in ${modal}`).not.toBeNull();
      const submitAt = body.indexOf('onSubmit(');
      const returnAt = body.indexOf('return', submitAt);
      const closeAt = body.indexOf('onClose()', submitAt);
      expect(submitAt).toBeGreaterThan(-1);
      expect(returnAt).toBeGreaterThan(-1);
      expect(closeAt).toBeGreaterThan(returnAt);
    },
  );

  test.each([
    ['handleMuteSubmit', 'onMute'],
    ['handleUnmuteSubmit', 'onUnmute'],
    ['handlePauseSubmit', 'onPause'],
    ['handleResumeSubmit', 'onResume'],
    ['handleKickSubmit', 'onKick'],
  ])('ParticipantControlMenu.%s gates closeModal on %s', (handler, callback) => {
    const body = bodyOf(codeOf(MENU), handler);
    expect(body, `${handler} not found`).not.toBeNull();
    expect(body).toContain(`if (!${callback}(`);
    const guardAt = body.indexOf(`if (!${callback}(`);
    const closeAt = body.indexOf('closeModal()');
    expect(closeAt).toBeGreaterThan(guardAt);
  });

  test('UserPromptInput clears the composer only after a delivered send', () => {
    // `bodyOf` stops at the inner `submit()`'s closing brace, which is exactly
    // the region of interest.
    const body = bodyOf(codeOf(MULTI_AGENT_TAB), 'UserPromptInput');
    expect(body).toContain('if (!props.onSend(trimmed)) return;');
    const guardAt = body.indexOf('if (!props.onSend(trimmed)) return;');
    const clearAt = body.indexOf("setText('')");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(guardAt);
  });
});
