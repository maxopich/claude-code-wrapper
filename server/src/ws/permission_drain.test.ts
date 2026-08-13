import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { listEvents } from '../repo/events.js';
import { persistMessage } from '../runner/orchestrator.js';
import {
  cleanupPendingPermissionsForSession,
  drainAllPendingPermissions,
  recordDrainedPermission,
  type PendingPermission,
} from './server.js';
import { translate } from './translate.js';
import type { ServerMsg } from '@cebab/shared/protocol';

/**
 * Register S06: a permission request nobody answered must not replay as a card
 * that still looks answerable.
 *
 * The request row is persisted the moment the card is raised, and `translate`
 * maps it straight back to a live `permission_request` on replay. Both drain
 * paths — socket close, and the interrupt cleanup — settled the promise and
 * dropped the map entry while persisting nothing, so reopening the session
 * rendered working-looking Allow/Deny buttons whose click reached
 * `if (!pending) return` and did nothing at all.
 *
 * These tests assert the pairing invariant over the REPLAYED STREAM rather
 * than the presence of a row: every `permission_request` a replay emits is
 * followed by a `permission_decided` for the same requestId. That is the
 * property the operator experiences, and it is what a future refactor of
 * either the persist shape or the translator has to keep true.
 */

withTempDataDir('cebab-permission-drain-');

const SESSION = 'sess-drain';

function seedSession(sessionId = SESSION): void {
  const project = upsertProject('drain-proj', '/tmp/drain-proj');
  createSession(sessionId, project.id, null);
}

/** Persist a permission_request exactly as the `canUseTool` handler does. */
async function seedRequest(requestId: string, sessionId = SESSION): Promise<void> {
  await persistMessage(sessionId, {
    type: 'wrapper',
    subtype: 'permission_request',
    session_id: sessionId,
    uuid: requestId,
    requestId,
    toolName: 'Bash',
    input: { command: 'echo hi' },
  } as never);
}

function pendingEntry(sessionId: string): PendingPermission {
  return {
    sessionId,
    resolve: () => {},
    toolInput: { command: 'echo hi' },
    toolName: 'Bash',
  } as PendingPermission;
}

/** Run the persisted rows through the same pipeline `replaySession` uses. */
function replay(sessionId = SESSION): ServerMsg[] {
  const out: ServerMsg[] = [];
  for (const row of listEvents(sessionId)) {
    const msg = translate(JSON.parse(row.raw) as SDKMessage, 1);
    if (msg) out.push(msg);
  }
  return out;
}

/** requestIds that a replay would render as still-answerable cards. */
function undecidedCards(stream: ServerMsg[]): string[] {
  const decided = new Set(
    stream.filter((m) => m.type === 'permission_decided').map((m) => m.requestId),
  );
  return stream
    .filter((m) => m.type === 'permission_request')
    .map((m) => m.requestId)
    .filter((id) => !decided.has(id));
}

/**
 * The drains return their in-flight bookkeeping writes; awaiting them is what
 * makes these tests deterministic AND what keeps `withTempDataDir` from
 * deleting the data directory while `persistMessage` still holds the session's
 * JSONL open. On Windows that race is an `ENOTEMPTY` at teardown, which is
 * exactly how the first version of this file failed CI.
 */
const settle = (writes: Promise<void>[]) => Promise.all(writes);

describe('[security] a drained permission replays as decided, not as a live card', () => {
  test('socket close: every open card is answered in the transcript', async () => {
    seedSession();
    await seedRequest('req-1');
    await seedRequest('req-2');

    // Before the drain, replay would strand both — this is the state the bug
    // left behind, asserted so the fix below is measured against it.
    expect(undecidedCards(replay()).sort()).toEqual(['req-1', 'req-2']);

    const pending = new Map<string, PendingPermission>([
      ['req-1', pendingEntry(SESSION)],
      ['req-2', pendingEntry(SESSION)],
    ]);
    await settle(drainAllPendingPermissions(pending));

    expect(undecidedCards(replay())).toEqual([]);
    const decisions = replay().filter((m) => m.type === 'permission_decided');
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(d).toMatchObject({ decision: 'deny', reason: 'client_disconnected' });
    }
  });

  test('interrupt: the drained session is answered, an untouched one is left alone', async () => {
    seedSession();
    seedSession('sess-other');
    await seedRequest('req-mine');
    await seedRequest('req-theirs', 'sess-other');

    const pending = new Map<string, PendingPermission>([
      ['req-mine', pendingEntry(SESSION)],
      ['req-theirs', pendingEntry('sess-other')],
    ]);
    await settle(cleanupPendingPermissionsForSession(pending, SESSION));

    expect(undecidedCards(replay())).toEqual([]);
    expect(replay().filter((m) => m.type === 'permission_decided')[0]).toMatchObject({
      decision: 'deny',
      reason: 'interrupted',
    });

    // The other session's card is untouched: the interrupt drain is
    // session-scoped, and recording a decision for a request nobody drained
    // would be its own lie.
    expect(undecidedCards(replay('sess-other'))).toEqual(['req-theirs']);
  });

  test('the recorded denial says Cebab decided it, not the operator', async () => {
    // The reason is the whole point of the row. A bare `deny` would clear the
    // dead card and replace it with a different falsehood — a transcript
    // asserting the operator refused a tool call they never saw.
    seedSession();
    await seedRequest('req-1');
    await recordDrainedPermission(SESSION, 'req-1', 'client_disconnected');

    const decided = replay().find((m) => m.type === 'permission_decided');
    expect(decided).toMatchObject({ reason: 'client_disconnected' });
  });

  test('an operator-answered request still records no reason', async () => {
    // POSITIVE CONTROL. Every case above asserts a reason appears; without
    // this one, a change that stamped a reason on every decision would pass
    // them all while destroying the distinction the field exists to make.
    seedSession();
    await seedRequest('req-1');
    await persistMessage(SESSION, {
      type: 'wrapper',
      subtype: 'permission_decided',
      session_id: SESSION,
      uuid: 'decision-1',
      requestId: 'req-1',
      decision: 'allow',
    } as never);

    const decided = replay().find((m) => m.type === 'permission_decided') as Record<
      string,
      unknown
    >;
    expect(decided).toMatchObject({ decision: 'allow' });
    expect('reason' in decided).toBe(false);
    expect(undecidedCards(replay())).toEqual([]);
  });

  test('draining nothing writes nothing', async () => {
    seedSession();
    await seedRequest('req-1');
    const before = listEvents(SESSION).length;

    const a = drainAllPendingPermissions(new Map(), () => {
      throw new Error('recorder called for an empty drain');
    });
    const b = cleanupPendingPermissionsForSession(new Map(), SESSION, () => {
      throw new Error('recorder called for an empty drain');
    });
    expect([...a, ...b]).toEqual([]);

    expect(listEvents(SESSION)).toHaveLength(before);
  });
});
