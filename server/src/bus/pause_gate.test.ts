import { describe, expect, it } from 'vitest';

import { decidePauseForMutation } from './pause_gate.js';

// The bus pause gate fires ONLY on dangerous-category mutations. This is the
// behavioral contract for "pause on dangerous commands, let MCP + ordinary
// edits run free" — MCP tool calls and Write/Edit classify as `mutate`.
//
// Migration 031 (register B06/B07) made it per-agent and re-arming: the two
// facts that used to live on the session (one pending slot, one session-wide
// acknowledgment) are now per-agent inputs, so worker B is gated while worker A
// is paused, and approving one command does not pre-approve the next.
describe('decidePauseForMutation [security]', () => {
  const armed = { pause_on_dangerous: 1 };
  const clean = { hasPendingPause: false, unconsumedApprovalId: null };

  it('pauses on a dangerous mutation when the gate is armed', () => {
    expect(decidePauseForMutation('dangerous', armed, clean)).toEqual({ action: 'pause' });
  });

  it('does NOT pause on a `mutate` (MCP call / ordinary edit) — runs free', () => {
    expect(decidePauseForMutation('mutate', armed, clean)).toEqual({ action: 'run' });
  });

  it('does NOT pause on a `read`', () => {
    expect(decidePauseForMutation('read', armed, clean)).toEqual({ action: 'run' });
  });

  it('does NOT pause when the operator never enabled the gate', () => {
    expect(decidePauseForMutation('dangerous', { pause_on_dangerous: 0 }, clean)).toEqual({
      action: 'run',
    });
  });

  it('does NOT pause when the session row is absent', () => {
    expect(decidePauseForMutation('dangerous', undefined, clean)).toEqual({ action: 'run' });
  });

  // B07: the old gate consulted a session-wide `mutations_acknowledged`, so the
  // first Continue disarmed it for the rest of the run. There is no such input
  // any more — an approval is a grant for ONE command, and a command with no
  // grant pauses however many the operator has already approved.
  it('re-arms: a command with no grant pauses even after other approvals', () => {
    expect(decidePauseForMutation('dangerous', armed, clean)).toEqual({ action: 'pause' });
  });

  // The grant is what stops the pause→Continue→replay→pause livelock: the
  // replayed turn re-issues the approved command and spends the grant once.
  it('consumes a matching grant instead of pausing', () => {
    expect(
      decidePauseForMutation('dangerous', armed, {
        hasPendingPause: false,
        unconsumedApprovalId: 42,
      }),
    ).toEqual({ action: 'consume-approval', approvalId: 42 });
  });

  it('a grant outranks this agent being already paused', () => {
    // Defensive ordering check: if both hold, spending the grant is right —
    // the pending row is the one the operator just released.
    expect(
      decidePauseForMutation('dangerous', armed, {
        hasPendingPause: true,
        unconsumedApprovalId: 7,
      }),
    ).toEqual({ action: 'consume-approval', approvalId: 7 });
  });

  // `Cebab-vie.13`: this `run` is only safe because the halt now holds the
  // agent's turn QUEUE as well as killing its turn (`applyPauseGate` →
  // `AgentRunner.holdForMutation`). Reached by a sibling `tool_use` block from
  // the already-dead turn; a LATER turn used to reach it too, and was waved
  // straight through.
  it('does NOT open a second pause for an agent already halted', () => {
    expect(
      decidePauseForMutation('dangerous', armed, {
        hasPendingPause: true,
        unconsumedApprovalId: null,
      }),
    ).toEqual({ action: 'run' });
  });

  // B06: the session-scoped slot meant ANY agent's pause suppressed the gate
  // for every other agent. The gate's inputs are now per-agent, so a peer's
  // pause is not even visible here — the only way to reach `run` is this
  // agent's own pending row.
  it("another worker's pause is not an input — this agent still pauses", () => {
    expect(decidePauseForMutation('dangerous', armed, clean)).toEqual({ action: 'pause' });
  });
});
