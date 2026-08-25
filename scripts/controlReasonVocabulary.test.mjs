/**
 * `Cebab-vie.5`: the per-agent control verbs share ONE reason vocabulary.
 *
 * It used to be three inlined copies — one each in `MuteReasonModal`,
 * `PauseReasonModal` and `KickModal` — and `PauseReasonModal`'s header argued
 * for keeping them that way: "the lists are short, identical strings show up in
 * one place per file (and grep-able for code review)". The premise was already
 * false when it was measured: Kick's `topology_repair` help had diverged from
 * the other two, silently, because "identical" was an assertion nobody was
 * checking.
 *
 * SO THIS IS THE CHECK. The vocabulary now lives in
 * `web/src/components/agentControl/controlReasons.ts`; a fourth copy — or one
 * modal quietly reverting to a local list — is the failure mode, and it looks
 * exactly like working code.
 *
 * WHY IT IS NOT IN `web/`. `web/tsconfig.json` sets `"types": []` (and
 * `web/src/nodeTypeIsolation.test.ts` fails typecheck if that stops being
 * true), so a web-side test cannot read a file. `scripts/` is where this
 * repo's source-level claims already live.
 *
 * WHY A SOURCE GATE AND NOT A UNIT TEST. `controlReasons.test.ts` asserts what
 * the vocabulary says; it stays green while a modal ignores it entirely. The
 * two answer different questions and the render tests in each modal's own
 * `.test.tsx` answer a third — what reaches the screen.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_CONTROL = join(REPO_ROOT, 'web', 'src', 'components', 'agentControl');
const MODALS = ['MuteReasonModal.tsx', 'PauseReasonModal.tsx', 'KickModal.tsx'];
const VOCABULARY = 'controlReasons.ts';

/** Comments stripped: the prose below names the very identifiers being
 *  matched, so a raw-text scan would be satisfied by the explanation. */
function codeOf(file) {
  return readFileSync(join(AGENT_CONTROL, file), 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('the control-verb reason vocabulary has one home (Cebab-vie.5)', () => {
  test('no modal declares a reason list of its own', () => {
    for (const file of MODALS) {
      const code = codeOf(file);
      // The old shape, by name, because that is what a revert or a fourth
      // modal would reintroduce — a `const REASON_OPTIONS = [` beside the
      // markup that renders it.
      expect(code, file).not.toMatch(/const\s+REASON_OPTIONS\s*[:=]/);
      // And the general shape, so a rename to `REASONS` does not slip past.
      expect(code, file).not.toMatch(/code:\s*'runaway_loop'/);
    }
  });

  test('all three modals import the shared vocabulary', () => {
    // The positive control. Without it, deleting `controlReasons.ts` and every
    // reference to it would satisfy the negative assertions above.
    for (const file of MODALS) {
      expect(codeOf(file), file).toMatch(/from '\.\/controlReasons'/);
    }
  });

  test('the vocabulary file is where the entries actually live', () => {
    // Guards against the inverse vacuity: a shared module that exists, is
    // imported, and is empty.
    const code = codeOf(VOCABULARY);
    for (const codeName of [
      'runaway_loop',
      'off_task',
      'cost_ceiling',
      'tool_misuse',
      'incorrect_output',
      'forensics',
      'topology_repair',
      'other',
    ]) {
      expect(code, codeName).toContain(`code: '${codeName}'`);
    }
  });
});
