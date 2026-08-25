import { describe, expect, test } from 'vitest';
import { CONTROL_REASON_CODES, type ControlReasonCode } from '@cebab/shared/protocol';
import { reasonOptionsFor, type ControlVerb } from './controlReasons';

/**
 * `Cebab-vie.5` — the vocabulary's own rules.
 *
 * Three separate claims, and this file only covers the first: what the
 * vocabulary SAYS. `scripts/controlReasonVocabulary.test.mjs` covers where it
 * lives (one home, no fourth copy), and each modal's `.test.tsx` covers what
 * reaches the screen. A string that is correct here and never rendered is the
 * same defect as a wrong one.
 *
 * Caveats are asserted as EXACT SETS in both directions. "a caveat is shown"
 * is satisfied by showing one on all eight, which would be wallpaper; "no
 * caveat on topology_repair" is satisfied by having none at all.
 */

const VERBS: readonly ControlVerb[] = ['mute', 'unmute', 'pause', 'resume', 'kick'];

/** Codes carrying a caveat under `verb`, sorted. */
function caveated(verb: ControlVerb): ControlReasonCode[] {
  return reasonOptionsFor(verb)
    .filter((o) => o.caveat !== undefined)
    .map((o) => o.code)
    .sort();
}

describe('the vocabulary is never filtered per verb', () => {
  test.each(VERBS)('%s offers every ControlReasonCode', (verb) => {
    // Derived from the shared set, not a retyped list: a ninth code added to
    // the protocol and forgotten here fails rather than being silently
    // unrenderable. And the filter this reddens is a tempting edit — the bead
    // itself floated it — so the reason it is wrong lives in `CAVEATS`' header.
    const offered = reasonOptionsFor(verb).map((o) => o.code);
    expect([...offered].sort()).toEqual([...CONTROL_REASON_CODES].sort());
    // No duplicates: a merge that appended instead of replacing would still
    // satisfy a set comparison.
    expect(offered).toHaveLength(CONTROL_REASON_CODES.size);
  });
});

describe('forensics no longer promises a capability', () => {
  const helpOf = (verb: ControlVerb) =>
    reasonOptionsFor(verb).find((o) => o.code === 'forensics')!.help;

  test('the freeze promise is gone, and something replaced it', () => {
    for (const verb of VERBS) {
      expect(helpOf(verb).toLowerCase(), verb).not.toContain('freeze');
      expect(helpOf(verb).toLowerCase(), verb).not.toContain('without further mutation');
      // Not merely absent — the entry still describes the operator's want, so
      // deleting the help outright does not pass.
      expect(helpOf(verb), verb).toContain('captured for later review');
    }
  });

  test('only Kick claims a bundle; Mute and Pause say so', () => {
    // The half the bead missed: the forensic BUNDLE is kick-only, so on Mute
    // and Pause this entry promised TWO things neither verb does. Reddens if
    // the caveat is made verb-blind — the three must not agree here.
    const mute = reasonOptionsFor('mute').find((o) => o.code === 'forensics')!.caveat!;
    const pause = reasonOptionsFor('pause').find((o) => o.code === 'forensics')!.caveat!;
    const kick = reasonOptionsFor('kick').find((o) => o.code === 'forensics')!.caveat!;
    expect(mute).toContain('no bundle');
    expect(pause).toContain('no bundle');
    expect(kick).toContain('captured at the moment of the kick');
    expect(kick).not.toContain('no bundle');
  });
});

describe('caveats land on exactly the reasons the verb cannot remedy', () => {
  const EXPECTED: ControlReasonCode[] = [
    'cost_ceiling',
    'forensics',
    'runaway_loop',
    'tool_misuse',
  ];

  test.each(['mute', 'pause', 'kick'] as const)('%s', (verb) => {
    expect(caveated(verb)).toEqual(EXPECTED);
  });

  test('the undo verbs carry none', () => {
    // Deliberate, not an omission: unmute and resume REMOVE a restriction, so
    // there is no outcome to disclaim. Reddens if the caveat table is ever
    // keyed on reason alone, ignoring the verb.
    expect(caveated('unmute')).toEqual([]);
    expect(caveated('resume')).toEqual([]);
  });

  test('each verb states its own limit, not a shared one', () => {
    // The three verbs fail the operator differently — mute keeps the agent
    // running, pause and kick leave the CURRENT turn running. Reddens if the
    // caveats are collapsed into one string per reason.
    const forReason = (r: ControlReasonCode) =>
      (['mute', 'pause', 'kick'] as const).map(
        (v) => reasonOptionsFor(v).find((o) => o.code === r)!.caveat,
      );
    for (const reason of EXPECTED) {
      expect(new Set(forReason(reason)).size, reason).toBe(3);
    }
  });
});
