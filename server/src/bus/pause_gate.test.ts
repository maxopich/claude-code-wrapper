import { describe, expect, it } from 'vitest';

import { shouldPauseForMutation } from './pause_gate.js';

// The bus pause gate fires ONLY on dangerous-category mutations. This is the
// behavioral contract for "pause on dangerous commands, let MCP + ordinary
// edits run free" — MCP tool calls and Write/Edit classify as `mutate`.
describe('shouldPauseForMutation', () => {
  const armed = {
    pause_on_dangerous: 1,
    mutations_acknowledged: 0,
    pending_mutation_id: null,
  };

  it('pauses on a dangerous mutation when the gate is armed', () => {
    expect(shouldPauseForMutation('dangerous', armed)).toBe(true);
  });

  it('does NOT pause on a `mutate` (MCP call / ordinary edit) — runs free', () => {
    expect(shouldPauseForMutation('mutate', armed)).toBe(false);
  });

  it('does NOT pause on a `read`', () => {
    expect(shouldPauseForMutation('read', armed)).toBe(false);
  });

  it('does NOT pause when the operator never enabled the gate', () => {
    expect(shouldPauseForMutation('dangerous', { ...armed, pause_on_dangerous: 0 })).toBe(false);
  });

  it('does NOT pause once mutations are acknowledged (Continue clicked)', () => {
    expect(shouldPauseForMutation('dangerous', { ...armed, mutations_acknowledged: 1 })).toBe(
      false,
    );
  });

  it('does NOT double-pause while a mutation is already pending', () => {
    expect(shouldPauseForMutation('dangerous', { ...armed, pending_mutation_id: 7 })).toBe(false);
  });

  it('does NOT pause when the session row is absent', () => {
    expect(shouldPauseForMutation('dangerous', undefined)).toBe(false);
  });
});
