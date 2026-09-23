import { describe, expect, test } from 'vitest';

import { chainStartMsg, initialState } from './store';
import type { MultiAgentState } from './store';

/**
 * `Cebab-3wt3`: the chain execute-mode toggle must reach the wire. The draft
 * UI test sees the checkbox; only this sees what `startChain` sends, because
 * App.tsx has no test file and the message is built here.
 */
describe('chainStartMsg carries the execute-mode grant (Cebab-3wt3)', () => {
  const draft = (over: Partial<MultiAgentState>): MultiAgentState => ({
    ...initialState.multiAgent,
    draftParticipants: [1, 2],
    draftPrompt: 'do the thing',
    ...over,
  });

  test('execute mode ON is sent; OFF is sent as false (control, same case)', () => {
    expect(chainStartMsg(draft({ draftExecuteMode: true }))).toMatchObject({
      type: 'start_multi_agent',
      mode: 'chain',
      executeMode: true,
    });
    expect(chainStartMsg(draft({ draftExecuteMode: false }))?.executeMode).toBe(false);
  });

  test('a draft that cannot start sends nothing', () => {
    expect(chainStartMsg(draft({ draftPrompt: '   ' }))).toBeNull();
    expect(chainStartMsg(draft({ draftParticipants: [1] }))).toBeNull();
  });
});
