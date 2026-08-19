/**
 * A probe whose runner cannot even be CONSTRUCTED must resolve to "no
 * snapshot", never reject (Cebab-ys9).
 *
 * WHY ITS OWN FILE. The case needs `pickRunner` itself to throw, which means
 * mocking the module — and `vi.mock` is file-scoped, so putting it beside the
 * happy-path cases would mock the runner they depend on.
 *
 * WHY THE CASE EXISTS AT ALL. Both runners throw SYNCHRONOUSLY on this path.
 * `runMock` throws on a missing fixture; on the live path `query()` spawns the
 * CLI, and on Windows spawning a `.cmd` shim without `shell: true` throws
 * `EINVAL` before any promise exists — the same CVE-2024-27980 behaviour
 * `scripts/bootstrap.mjs` had to work around. The probe originally built its
 * runner ABOVE its `try`, so that throw propagated out and rejected the WS
 * handler that asked for an authority refresh. Windows is also the platform
 * this bug was reported from, so the failure mode and the reporter's OS are
 * the same one.
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('./index.js', () => ({
  pickRunner: () => {
    // Shaped like the real thing: Node's spawn EINVAL is a plain synchronous
    // throw with a `code`, not a rejected promise.
    const err = new Error('spawn EINVAL') as Error & { code?: string };
    err.code = 'EINVAL';
    throw err;
  },
}));

const { probeSessionStarted } = await import('./probe.js');
const { inFlightCount, __resetForTests } = await import('./lifecycle.js');

describe('probeSessionStarted when the runner cannot be constructed', () => {
  test('resolves to null rather than rejecting', async () => {
    __resetForTests();
    await expect(
      probeSessionStarted({ cwd: process.cwd(), projectId: 1, settingSources: ['user'] }),
    ).resolves.toBeNull();
  });

  test('registers nothing, so a failed probe leaves no lifecycle entry', async () => {
    __resetForTests();
    await probeSessionStarted({ cwd: process.cwd(), projectId: 1, settingSources: ['user'] });
    // The construction threw before `registerQuery`, so the `finally` must
    // cope with an unregister callback that was never created.
    expect(inFlightCount()).toBe(0);
    __resetForTests();
  });
});
