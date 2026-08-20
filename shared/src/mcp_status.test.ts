import { describe, expect, test } from 'vitest';
import { notConnected } from './mcp_status.js';

/**
 * Cebab-ws0.2. The rule under test is "not connected", not "on a list of bad
 * statuses", so the case that matters most is the one nobody has seen yet: a
 * status string this code has never heard of still has to count.
 */
describe('notConnected', () => {
  test('keeps every status that is not exactly connected, including an unknown one', () => {
    // `failed` and `needs-auth` are the two the reported incident produced;
    // `disabled` is the operator's own switch and still means zero tools; and
    // `some-future-status` stands for whatever the SDK adds next. Narrowing
    // this to an allow-list of known-bad values reddens here, on the last one
    // — which is exactly the blind spot this bead exists to close.
    const out = notConnected([
      { name: 'alpha', status: 'connected' },
      { name: 'bravo', status: 'failed' },
      { name: 'charlie', status: 'needs-auth' },
      { name: 'delta', status: 'disabled' },
      { name: 'echo', status: 'some-future-status' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['bravo', 'charlie', 'delta', 'echo']);
    // The status is carried through untouched — nothing downstream may render
    // a cause the SDK did not report.
    expect(out.map((s) => s.status)).toEqual([
      'failed',
      'needs-auth',
      'disabled',
      'some-future-status',
    ]);
  });

  test('CONTROL: an all-connected list, an empty list and an absent list all yield nothing', () => {
    // Without this the assertion above passes just as well on a function that
    // returns its input.
    expect(
      notConnected([
        { name: 'alpha', status: 'connected' },
        { name: 'bravo', status: 'connected' },
      ]),
    ).toEqual([]);
    expect(notConnected([])).toEqual([]);
    expect(notConnected(undefined)).toEqual([]);
  });

  test('reported order is preserved', () => {
    const out = notConnected([
      { name: 'zulu', status: 'failed' },
      { name: 'alpha', status: 'failed' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['zulu', 'alpha']);
  });
});
