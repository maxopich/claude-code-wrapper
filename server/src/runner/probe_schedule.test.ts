import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createProbeScheduler,
  activeProbeCount,
  MAX_CONCURRENT_PROBES,
  __resetProbeConcurrencyForTests,
} from './probe_schedule.js';

/**
 * Cebab-ws0.7: the scheduler decides when a project selection is worth a
 * process spawn.
 *
 * Fake timers throughout — a real sleep would make these slow AND flaky, and
 * the whole subject is a delay. The dependencies are plain functions, so
 * nothing here spawns, reads a file or touches the database; what is under
 * test is timing and bookkeeping, which is exactly what the module owns.
 *
 * The counter is process-global by design, so every case resets it on both
 * sides — a leak would otherwise make a LATER case fail for a reason it has
 * nothing to do with.
 */

let probed: number[];

function makeDeps(over: Partial<Parameters<typeof createProbeScheduler>[0]> = {}) {
  return {
    hasSnapshot: () => false,
    runProbe: async (projectId: number) => {
      probed.push(projectId);
    },
    settleMs: 400,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  probed = [];
  __resetProbeConcurrencyForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetProbeConcurrencyForTests();
});

describe('createProbeScheduler', () => {
  test('a selection that settles probes exactly once', async () => {
    const s = createProbeScheduler(makeDeps());
    s.onProjectSelected(7);
    expect(probed).toEqual([]); // nothing on arrival — the delay is the point
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([7]);
  });

  test('rapid selections probe once, for the one landed on', async () => {
    // The case the whole module exists for. Arming without clearing, or
    // probing on arrival, reddens here — and a bounded QUEUE would too, which
    // is the design this rules out: three spawns two at a time is still three
    // spawns for two projects nobody is looking at.
    const s = createProbeScheduler(makeDeps());
    s.onProjectSelected(1);
    await vi.advanceTimersByTimeAsync(100);
    s.onProjectSelected(2);
    await vi.advanceTimersByTimeAsync(100);
    s.onProjectSelected(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([3]);
  });

  test('a project the connection already has a snapshot for is never probed', async () => {
    const s = createProbeScheduler(makeDeps({ hasSnapshot: (id) => id === 7 }));
    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([]);
  });

  test('selecting a cached project also disarms a pending probe for another', async () => {
    // The operator left project 1. Probing it after they moved on is the
    // behaviour this module exists to avoid, and it is easy to miss because
    // the obvious implementation only re-arms when the NEW project needs one.
    const s = createProbeScheduler(makeDeps({ hasSnapshot: (id) => id === 2 }));
    s.onProjectSelected(1);
    await vi.advanceTimersByTimeAsync(100);
    s.onProjectSelected(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([]);
  });

  test('a snapshot that appears during the settle window cancels the probe', async () => {
    // A real turn can fill the cache inside the delay. Checking only at arm
    // time reddens here.
    let cached = false;
    const s = createProbeScheduler(makeDeps({ hasSnapshot: () => cached }));
    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(100);
    cached = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([]);
  });

  test('re-selecting a project whose probe is still running does not start a second', async () => {
    // `hasSnapshot` answers NO for the entire time a probe runs — the snapshot
    // does not exist yet — so the cache check alone cannot carry this.
    let release!: () => void;
    const s = createProbeScheduler(
      makeDeps({
        runProbe: async (projectId: number) => {
          probed.push(projectId);
          await new Promise<void>((r) => {
            release = r;
          });
        },
      }),
    );
    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([7]);

    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([7]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeProbeCount()).toBe(0);
  });

  test('cancel() disarms a pending probe', async () => {
    const s = createProbeScheduler(makeDeps());
    s.onProjectSelected(7);
    s.cancel();
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([]);
  });

  test('cancel() refuses to arm anything afterwards', async () => {
    // A close handler runs once; a selection arriving after it must not
    // resurrect the timer.
    const s = createProbeScheduler(makeDeps());
    s.cancel();
    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([]);
  });

  test('at the process cap a settled selection is skipped, and a later one runs once a slot frees', async () => {
    // The cap is global, so it is exercised through separate schedulers —
    // which is the case that motivates it being global at all (several
    // browser tabs, one machine).
    const releases: Array<() => void> = [];
    const blocking = () => ({
      hasSnapshot: () => false,
      settleMs: 400,
      runProbe: async (projectId: number) => {
        probed.push(projectId);
        await new Promise<void>((r) => releases.push(r));
      },
    });

    const schedulers = Array.from({ length: MAX_CONCURRENT_PROBES }, () =>
      createProbeScheduler(blocking()),
    );
    schedulers.forEach((s, i) => s.onProjectSelected(100 + i));
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toHaveLength(MAX_CONCURRENT_PROBES);
    expect(activeProbeCount()).toBe(MAX_CONCURRENT_PROBES);

    // One more, with every slot taken: skipped rather than queued.
    const extra = createProbeScheduler(blocking());
    extra.onProjectSelected(999);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).not.toContain(999);

    // Free a slot; a fresh selection now goes through, which proves the cap
    // RELEASES rather than being a one-way latch.
    releases[0]!();
    await vi.advanceTimersByTimeAsync(0);
    extra.onProjectSelected(999);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toContain(999);

    for (const r of releases) r();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeProbeCount()).toBe(0);
  });

  test('a runProbe that rejects still releases its slot', async () => {
    // Defensive: `probeSessionStarted` turns every failure into a null result
    // rather than a throw, so a rejection here means a caller bug — which must
    // not also cost a permanently-held slot for the rest of the process.
    const s = createProbeScheduler(
      makeDeps({
        runProbe: async (projectId: number) => {
          probed.push(projectId);
          throw new Error('caller bug');
        },
      }),
    );
    s.onProjectSelected(7);
    await vi.advanceTimersByTimeAsync(400);
    expect(probed).toEqual([7]);
    expect(activeProbeCount()).toBe(0);
  });
});
