import { describe, expect, test } from 'vitest';
import appSource from './App.tsx?raw';
import { stripComments } from './sourceScan.js';

/**
 * `Cebab-6fax.36` — the model picker must read the catalogue Cebab already
 * captured, not make the operator pay a process for it.
 *
 * WHAT WENT WRONG. `probeSessionStarted` captures the CLI's own model list as
 * a free side effect of the authority probe and writes it to the account-wide
 * `settings.model_catalogue` key; the WS handler serves that cache for a
 * request WITHOUT `refresh`, and spawns only when `refresh: true`. The client
 * only ever sent the second form. Measured 2026-09-08: the new-chat preview
 * said "No model list captured yet" thirteen seconds after a successful probe,
 * while the setting held 810 bytes of entries — and clicking Refresh spawned a
 * process to display them. CLAUDE.md's "captured as a free side effect" was
 * true of the capture and false of the display.
 *
 * WHY A SOURCE TEST. `App.tsx` has no test file and its `onOpen` callback is
 * not reachable without mounting the whole shell
 * (`project_web_test_harness_traps`), so the thing to pin is the one
 * decision that matters: a cache read is issued at all, and the spawn form is
 * still reserved for the explicit Refresh.
 */

const src = stripComments(appSource);

/** Every `get_model_catalogue` send, with whatever follows it on the line. */
function catalogueSends(source: string): string[] {
  return source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes("type: 'get_model_catalogue'"));
}

describe('the client asks for the cached model catalogue', () => {
  test('the scan finds the sends — anti-vacuity', () => {
    // A rename would otherwise turn both assertions below into scans of an
    // empty list (`project_gates_pass_vacuously`).
    // Deliberately >= 1, not >= 2: this case must pass with or without the
    // fix, or it is a second copy of the assertion below rather than a check
    // that the scan reaches the source at all.
    expect(catalogueSends(src).length).toBeGreaterThanOrEqual(1);
  });

  test('at least one send is a CACHE read — no refresh, no spawn', () => {
    const cacheReads = catalogueSends(src).filter((l) => !l.includes('refresh'));
    expect(
      cacheReads.length,
      'Every get_model_catalogue send carries `refresh: true`, which spawns a ' +
        'process. Nothing reads the catalogue the authority probe already ' +
        'captured, so the picker renders empty until the operator pays for a ' +
        'refresh.',
    ).toBeGreaterThanOrEqual(1);
  });

  test('the refresh form still exists — Refresh must stay the spawn path', () => {
    // The opposite failure: "fix" this by dropping `refresh: true` everywhere
    // and the operator loses the only way to re-measure after installing a
    // new model.
    expect(catalogueSends(src).some((l) => l.includes('refresh: true'))).toBe(true);
  });
});
