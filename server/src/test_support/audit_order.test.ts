/**
 * Register Cebab-34l. The three call sites this helper replaces are
 * individually unreddenable — reverting any one of them to `ORDER BY ts`
 * leaves its test passing, because the query plan already returns rowid order
 * today. That is precisely what makes them dangerous: they will flip silently
 * on an index change and never flake first to warn anyone.
 *
 * So the guarantee is defended HERE, with rows whose `ts` deliberately
 * contradicts their write order. This is the case that reddens.
 */
import { describe, expect, test } from 'vitest';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { withTempDataDir } from './temp_data_dir.js';
import { auditKindsInWriteOrder, auditRowsInWriteOrder } from './audit_order.js';

withTempDataDir('cebab-audit-order-');

describe('auditRowsInWriteOrder', () => {
  // Every case filters rather than reading the whole table: `getDb()` writes
  // its own `audit.chain_reset` genesis rows on init, so an unfiltered read
  // is never just the rows the test wrote. The call sites all filter too.
  const MINE =
    "kind IN ('first.written','second.written','third.row') OR kind LIKE 'pause.%' OR kind = 'agent_control.kicked'";

  test('write order wins over ts when ts CONTRADICTS it', () => {
    // A is written first but stamped LATER; B is written second, stamped
    // EARLIER. `ORDER BY ts` returns [B, A]; write order is [A, B]. This is
    // the case that reddens if the helper reverts to ordering by ts.
    appendSafetyAudit({ ts: 5_000, kind: 'first.written', reasonCode: 'a', payload: {} });
    appendSafetyAudit({ ts: 1_000, kind: 'second.written', reasonCode: 'b', payload: {} });

    expect(auditKindsInWriteOrder(MINE)).toEqual(['first.written', 'second.written']);
  });

  test('write order is stable when every ts is IDENTICAL', () => {
    // The frozen-clock case: under fake timers `Date.now()` does not move, so
    // a trigger and its consequence tie by construction rather than by luck.
    //
    // MEASURED: this case does NOT redden when the helper reverts to
    // `ORDER BY ts` — on a tie the current plan returns rowid order anyway,
    // which is exactly why the three call sites looked fine for so long. It
    // documents the scenario; the case ABOVE is what actually defends it.
    for (const kind of ['pause.expired_without_resume', 'agent_control.kicked', 'third.row']) {
      appendSafetyAudit({ ts: 42, kind, reasonCode: 'x', payload: {} });
    }

    expect(auditKindsInWriteOrder(MINE)).toEqual([
      'pause.expired_without_resume',
      'agent_control.kicked',
      'third.row',
    ]);
  });

  test('the WHERE fragment filters and binds positionally', () => {
    appendSafetyAudit({
      ts: 1,
      kind: 'pause.expired_without_resume',
      reasonCode: 'r',
      payload: {},
    });
    appendSafetyAudit({ ts: 1, kind: 'unrelated.event', reasonCode: 'r', payload: {} });
    appendSafetyAudit({ ts: 1, kind: 'agent_control.kicked', reasonCode: 'r', payload: {} });

    expect(
      auditKindsInWriteOrder('kind LIKE ? OR kind = ?', 'pause.%', 'agent_control.kicked'),
    ).toEqual(['pause.expired_without_resume', 'agent_control.kicked']);
  });

  test('rows carry the columns the call sites read', () => {
    appendSafetyAudit({
      ts: 1,
      kind: 'agent_control.kicked',
      reasonCode: 'operator_kick',
      payload: { mode: 'drain' },
      sessionId: 'sess-1',
      agentId: 'worker-slug',
    });

    const [row] = auditRowsInWriteOrder('kind = ?', 'agent_control.kicked');
    expect(row).toMatchObject({
      kind: 'agent_control.kicked',
      reason_code: 'operator_kick',
      session_id: 'sess-1',
      agent_id: 'worker-slug',
    });
    expect(JSON.parse(row!.payload_json)).toEqual({ mode: 'drain' });
  });

  // CONTROL. A single-row read cannot distinguish a correct ordering from a
  // broken one, so it must keep working either way — this is the shape
  // `reveal_audit.security.test.ts` uses, and the reason that site is a
  // LATENT trap rather than a live flake.
  test('a single-row read is unaffected', () => {
    appendSafetyAudit({ ts: 1, kind: 'session.revealed', reasonCode: 'revealed_raw', payload: {} });
    expect(auditKindsInWriteOrder('kind = ?', 'session.revealed')).toEqual(['session.revealed']);
  });

  test('no matching rows is an empty array, not a throw', () => {
    expect(auditKindsInWriteOrder('kind = ?', 'nothing.here')).toEqual([]);
  });
});
