import { describe, expect, test } from 'vitest';
import { streamPersistedHistory } from './server.js';
import type { ServerMsg } from '@cebab/shared/protocol';

/**
 * Register S16: one unrenderable row costs one row, not the session.
 *
 * `replaySession` reconstructs history with `JSON.parse(row.raw) as
 * SDKMessage` — a cast that checks nothing — and used to guard only the parse.
 * A throw from `translate` escaped the loop, so `session_history_end` never
 * shipped and the operator's session hung half-rendered: the rest of their own
 * transcript was on disk and unreachable.
 *
 * The tests below feed a corrupt row in the MIDDLE deliberately. A guard that
 * only survived a trailing bad row would still lose everything after a bad one
 * in the middle, which is the case that actually happens.
 */

const PID = 7;

/** Rows as the events table stores them: `raw` is a JSON string. */
const row = (msg: unknown) => ({ raw: JSON.stringify(msg) });

const assistant = (uuid: string, text: string) =>
  row({
    type: 'assistant',
    session_id: 's',
    uuid,
    message: { model: 'claude-opus-4-7', role: 'assistant', content: [{ type: 'text', text }] },
  });

function drain(rows: Array<{ raw: string }>): { msgs: ServerMsg[]; skipped: number } {
  const msgs: ServerMsg[] = [];
  const skipped = streamPersistedHistory(rows, PID, (m) => msgs.push(m));
  return { msgs, skipped };
}

describe('replaying a damaged transcript', () => {
  test('a benign history replays in full, skipping nothing', () => {
    // POSITIVE CONTROL. Every case below asserts something was skipped;
    // without this one, a guard that skipped everything would pass them all.
    const { msgs, skipped } = drain([assistant('a', 'one'), assistant('b', 'two')]);
    expect(skipped).toBe(0);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ blocks: [{ type: 'text', text: 'one' }] });
    expect(msgs[1]).toMatchObject({ blocks: [{ type: 'text', text: 'two' }] });
  });

  test('an unparseable row in the middle costs one row', () => {
    const { msgs, skipped } = drain([
      assistant('a', 'before'),
      { raw: '{not json at all' },
      assistant('b', 'after'),
    ]);
    expect(skipped).toBe(1);
    expect(msgs).toHaveLength(2);
    expect(msgs.at(-1)).toMatchObject({ blocks: [{ type: 'text', text: 'after' }] });
  });

  test('a row the translator throws on costs one row, not the rest of the history', () => {
    // `null` for a field the translator dereferences. `a.message?.content` now
    // absorbs the shape S16 named, so this reaches for a different one — the
    // point of the guard is that it does not need to know which.
    const { msgs, skipped } = drain([
      assistant('a', 'before'),
      { raw: JSON.stringify({ type: 'stream_event', session_id: 's', uuid: 'x', event: null }) },
      assistant('b', 'after'),
    ]);
    expect(skipped).toBe(1);
    expect(msgs.map((m) => m.type)).toEqual(['assistant_message', 'assistant_message']);
    expect(msgs.at(-1)).toMatchObject({ blocks: [{ type: 'text', text: 'after' }] });
  });

  test('the assistant shape S16 named no longer throws at all', () => {
    // It is now absorbed by the translator rather than the loop guard, so it
    // renders as an empty-blocks message instead of being skipped. Asserting
    // the count is 0 is what distinguishes "fixed" from "swallowed".
    const { msgs, skipped } = drain([
      assistant('a', 'before'),
      row({ type: 'assistant', session_id: 's', uuid: 'no-message' }),
      assistant('b', 'after'),
    ]);
    expect(skipped).toBe(0);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toMatchObject({ type: 'assistant_message', uuid: 'no-message', blocks: [] });
  });

  test('a history of nothing but damage still returns instead of throwing', () => {
    // The property the operator feels: the caller reaches its
    // `session_history_end` send. If this threw, the session would never
    // finish loading.
    let result: { msgs: ServerMsg[]; skipped: number } | undefined;
    expect(() => {
      result = drain([{ raw: '{' }, { raw: 'nope' }, { raw: '' }]);
    }).not.toThrow();
    expect(result!.msgs).toEqual([]);
    expect(result!.skipped).toBe(3);
  });

  test('the count is per row, so a caller can tell short from damaged', () => {
    const { skipped } = drain([{ raw: 'x' }, assistant('a', 'ok'), { raw: 'y' }, { raw: 'z' }]);
    expect(skipped).toBe(3);
  });
});
