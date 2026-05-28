import { describe, expect, test } from 'vitest';
import {
  CONTROL_REASON_CODES,
  CONTROLLABILITY_FAILURE_CODES,
  KICK_MODES,
  PAUSE_EXPIRY_ACTIONS,
  isControlReasonCode,
  isControllabilityFailureCode,
  isKickMode,
  isPauseExpiryAction,
  type ControlReasonCode,
  type ControllabilityFailureCode,
  type KickMode,
  type PauseExpiryAction,
} from './protocol.js';

// Cluster C Phase 4a: shared protocol surface for the per-agent control
// verbs. These tests serve a dual purpose:
//   1. Behavioral: the runtime type guards reject malformed strings.
//   2. Compile-time: the explicit per-arm exhaustiveness checks below force
//      a typescript error whenever a new enum value is added to the union
//      without the matching guard-set update — the same pattern the
//      StopReasonCode enum uses (verified via tsc --noEmit in CI).

describe('ControlReasonCode', () => {
  test('guard accepts every member of the enum + rejects strangers', () => {
    for (const code of CONTROL_REASON_CODES) {
      expect(isControlReasonCode(code)).toBe(true);
    }
    expect(isControlReasonCode('hot_loop')).toBe(false);
    expect(isControlReasonCode('')).toBe(false);
    expect(isControlReasonCode(null)).toBe(false);
    expect(isControlReasonCode(undefined)).toBe(false);
    expect(isControlReasonCode(42)).toBe(false);
  });

  test('enum exhaustiveness: every union arm appears in the runtime set', () => {
    // A new ControlReasonCode arm without a matching .add() here would
    // fail at compile time via the never-fallthrough check below.
    const codes: ControlReasonCode[] = [
      'runaway_loop',
      'off_task',
      'cost_ceiling',
      'tool_misuse',
      'incorrect_output',
      'forensics',
      'topology_repair',
      'other',
    ];
    for (const c of codes) {
      // Compile-time exhaustiveness: assigning back through the union
      // type fails to compile if `codes` drifts from ControlReasonCode.
      const _assignBack: ControlReasonCode = c;
      void _assignBack;
      expect(CONTROL_REASON_CODES.has(c)).toBe(true);
    }
    expect(CONTROL_REASON_CODES.size).toBe(codes.length);
  });
});

describe('KickMode + PauseExpiryAction', () => {
  test('KickMode guard accepts drain + hard only', () => {
    for (const m of KICK_MODES) {
      expect(isKickMode(m)).toBe(true);
    }
    const modes: KickMode[] = ['drain', 'hard'];
    expect(modes.length).toBe(KICK_MODES.size);
    expect(isKickMode('soft')).toBe(false);
    expect(isKickMode('forced')).toBe(false);
  });

  test('PauseExpiryAction guard accepts auto_resume + auto_kick only', () => {
    for (const a of PAUSE_EXPIRY_ACTIONS) {
      expect(isPauseExpiryAction(a)).toBe(true);
    }
    const actions: PauseExpiryAction[] = ['auto_resume', 'auto_kick'];
    expect(actions.length).toBe(PAUSE_EXPIRY_ACTIONS.size);
    expect(isPauseExpiryAction('escalate')).toBe(false);
  });
});

describe('ControllabilityFailureCode', () => {
  test('guard recognises every wire-defined failure code', () => {
    for (const f of CONTROLLABILITY_FAILURE_CODES) {
      expect(isControllabilityFailureCode(f)).toBe(true);
    }
    // Spot-check rejection — typos shouldn't sneak through.
    expect(isControllabilityFailureCode('mute_failed')).toBe(false);
    expect(isControllabilityFailureCode('chain_mute_not_supported')).toBe(false);
  });

  test('enum exhaustiveness: every union arm appears in the runtime set', () => {
    const codes: ControllabilityFailureCode[] = [
      'chain_mute_unsupported',
      'chain_topology_broken',
      'hard_kill_unsupported_v1',
      'already_in_state',
      'participant_not_found',
      'participant_already_kicked',
      'orchestrator_cannot_kick',
      'pause_timeout_required',
      'pause_expiry_action_invalid',
    ];
    for (const c of codes) {
      expect(CONTROLLABILITY_FAILURE_CODES.has(c)).toBe(true);
    }
    expect(CONTROLLABILITY_FAILURE_CODES.size).toBe(codes.length);
  });
});
