import { describe, expect, test } from 'vitest';
import type { InFlightMeta } from '../runner/lifecycle.js';
import { buildActiveRunsMsg } from './active_runs.js';

// Cluster G Phase 3 (G1): `buildActiveRunsMsg` is a pure projection from
// the lifecycle registry snapshot onto the wire envelope. These tests pin
// the projection rule for each field so a future refactor (e.g. dedup by
// sessionId, or sorting by startedAt server-side) doesn't silently change
// the wire shape.

const fakeNow = 1_700_000_100_000;

function meta(overrides: Partial<InFlightMeta>): InFlightMeta {
  return {
    sessionId: 'sess-default',
    projectId: 1,
    kind: 'single',
    startedAt: fakeNow - 5_000,
    ...overrides,
  };
}

const noProject = (): string | undefined => undefined;
const projects =
  (table: Record<number, string>) =>
  (id: number): string | undefined =>
    table[id];

describe('buildActiveRunsMsg / wire shape (Phase 3)', () => {
  test('empty snapshot → empty runs array (sent verbatim so the client clears stale state)', () => {
    expect(buildActiveRunsMsg([], noProject, fakeNow)).toEqual({
      type: 'active_runs',
      runs: [],
    });
  });

  test('single-agent run with project → name resolved, elapsedMs computed', () => {
    const msg = buildActiveRunsMsg(
      [meta({ sessionId: 's-a', projectId: 1, startedAt: fakeNow - 3_000 })],
      projects({ 1: 'reviewer' }),
      fakeNow,
    );
    expect(msg).toEqual({
      type: 'active_runs',
      runs: [
        {
          sessionId: 's-a',
          projectId: 1,
          projectName: 'reviewer',
          kind: 'single',
          startedAt: fakeNow - 3_000,
          elapsedMs: 3_000,
        },
      ],
    });
  });

  test('bus run with mixed-mode participants → kind=bus-worker, project name per row', () => {
    const msg = buildActiveRunsMsg(
      [meta({ sessionId: 'bus-1', projectId: 2, kind: 'bus-worker', startedAt: fakeNow - 1_000 })],
      projects({ 2: 'planner' }),
      fakeNow,
    );
    expect(msg.runs).toHaveLength(1);
    expect(msg.runs[0]).toMatchObject({
      sessionId: 'bus-1',
      projectId: 2,
      projectName: 'planner',
      kind: 'bus-worker',
      elapsedMs: 1_000,
    });
  });

  test('missing projectId → projectId AND projectName omitted (spread-omit shape)', () => {
    // A registered query without a resolved projectId (defensive — happens
    // briefly during teardown if a project is renamed mid-run). The wire
    // envelope must omit both fields rather than ship `projectId: undefined`
    // — additive-optional contract, JSON-minimal common path.
    const msg = buildActiveRunsMsg(
      [
        {
          sessionId: 'sess-no-proj',
          kind: 'single',
          startedAt: fakeNow - 500,
        },
      ],
      noProject,
      fakeNow,
    );
    expect(msg.runs[0]).toEqual({
      sessionId: 'sess-no-proj',
      kind: 'single',
      startedAt: fakeNow - 500,
      elapsedMs: 500,
    });
    expect('projectId' in msg.runs[0]!).toBe(false);
    expect('projectName' in msg.runs[0]!).toBe(false);
  });

  test('unknown projectId in registry → projectId kept, projectName omitted', () => {
    // The registry has a projectId but the resolver doesn't find it
    // (transient state during a project rename / DB-row deletion race).
    // We surface the id so the operator can still see "session in project
    // 99" rather than silently dropping the row.
    const msg = buildActiveRunsMsg(
      [meta({ projectId: 99 })],
      projects({ 1: 'a', 2: 'b' }), // no 99
      fakeNow,
    );
    expect(msg.runs[0]).toMatchObject({ projectId: 99 });
    expect('projectName' in msg.runs[0]!).toBe(false);
  });

  test('elapsedMs floor at 0 when registered AFTER `now` (NTP slew defence)', () => {
    // System-clock walk-back between register and emit must not surface a
    // negative duration. The UI's countdown ticker would render "−2s
    // running" or similar, which looks like a bug. Floor it.
    const msg = buildActiveRunsMsg([meta({ startedAt: fakeNow + 2_000 })], noProject, fakeNow);
    expect(msg.runs[0]!.elapsedMs).toBe(0);
  });

  test('insertion order preserved across multiple registrations', () => {
    // Map iteration order is the registry's contract; this test pins it so
    // a future swap to a Set (which would lose the order) is caught.
    const msg = buildActiveRunsMsg(
      [
        meta({ sessionId: 'first', startedAt: fakeNow - 9_000 }),
        meta({ sessionId: 'second', startedAt: fakeNow - 5_000 }),
        meta({ sessionId: 'third', startedAt: fakeNow - 1_000 }),
      ],
      noProject,
      fakeNow,
    );
    expect(msg.runs.map((r) => r.sessionId)).toEqual(['first', 'second', 'third']);
  });

  test('orchestrator kind passes through verbatim (reserved slot)', () => {
    // No caller passes `'orchestrator'` yet (Phase 4 will refine the
    // distinction). This test pins that the projection rule has no
    // implicit kind-mapping — the slot is reserved and round-trips.
    const msg = buildActiveRunsMsg(
      [meta({ kind: 'orchestrator', sessionId: 'orch-x' })],
      noProject,
      fakeNow,
    );
    expect(msg.runs[0]!.kind).toBe('orchestrator');
  });
});
