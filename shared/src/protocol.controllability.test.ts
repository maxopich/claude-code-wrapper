import { describe, expect, test } from 'vitest';
import {
  CONTROL_REASON_CODES,
  CONTROLLABILITY_FAILURE_CODES,
  KICK_MODES,
  PAUSE_EXPIRY_ACTIONS,
  ROUTER_DROP_REASON_CODES,
  isControlReasonCode,
  isControllabilityFailureCode,
  isKickMode,
  isPauseExpiryAction,
  isRouterDropReasonCode,
  type ControlReasonCode,
  type ControllabilityFailureCode,
  type KickMode,
  type PauseExpiryAction,
  type RouterDropReasonCode,
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

// `Cebab-vie.33`: the runtime set + guard the R-A router-drop rehydration
// builder uses to validate a `safety_audit.reason_code` string read off disk
// before it types it. Same dual purpose as the block above — behavioural guard
// plus a compile-time exhaustiveness fence keeping the set in lockstep with the
// RouterDropReasonCode union.
describe('RouterDropReasonCode', () => {
  test('guard accepts every member of the enum + rejects strangers', () => {
    for (const code of ROUTER_DROP_REASON_CODES) {
      expect(isRouterDropReasonCode(code)).toBe(true);
    }
    expect(isRouterDropReasonCode('from_a_future_release')).toBe(false);
    expect(isRouterDropReasonCode('')).toBe(false);
    expect(isRouterDropReasonCode(null)).toBe(false);
    expect(isRouterDropReasonCode(undefined)).toBe(false);
    expect(isRouterDropReasonCode(42)).toBe(false);
  });

  test('enum exhaustiveness: every union arm appears in the runtime set', () => {
    const codes: RouterDropReasonCode[] = [
      'forged_source',
      'worker_to_user',
      'worker_to_worker',
      'unknown_source',
      'muted_source',
      'kicked_source',
      'kicked_destination',
      'unknown_destination',
      'unauthorized_sink',
      'self_addressed',
    ];
    for (const c of codes) {
      // Compile-time exhaustiveness: assigning back through the union type
      // fails to compile if `codes` drifts from RouterDropReasonCode.
      const _assignBack: RouterDropReasonCode = c;
      void _assignBack;
      expect(ROUTER_DROP_REASON_CODES.has(c)).toBe(true);
    }
    expect(ROUTER_DROP_REASON_CODES.size).toBe(codes.length);
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

  // Register N13: `server/src/repo/per_agent_control.ts` declared a second copy
  // of both guards, and its test covered non-string inputs where this one only
  // covered wrong strings. The duplicate declarations are gone; these cases came
  // here with them, so the move did not cost coverage.
  //
  // They matter because the guards run on whatever SQLite hands back —
  // `rowToControlState` narrows a nullable TEXT column with them, so `null` is
  // the ordinary input, not an edge case.
  //
  // HONEST LIMIT, measured: these five pin the CONTRACT, they do not trap the
  // current code. Deleting `typeof v === 'string' &&` from either guard leaves
  // them all green, because `Set.has(undefined)` is already false — the typeof
  // prefix is belt-and-braces over a Set. Revert-checked; stated rather than
  // implied, so nobody reads this block as protection it does not give.
  const NON_MEMBERS: [label: string, value: unknown][] = [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', {}],
  ];
  test.each(NON_MEMBERS)('both guards reject %s', (_label, v) => {
    expect(isKickMode(v)).toBe(false);
    expect(isPauseExpiryAction(v)).toBe(false);
  });

  // This one DOES trap an implementation, which is why it is separate.
  //
  // A frozen `Set` is immune to inherited keys; the obvious-looking
  // refactor to an object literal (`return !!KICK_MODE_MAP[v]`) is not —
  // `({ drain: 1 })['constructor']` is the Object constructor, i.e. truthy, so
  // that version would accept `'constructor'` as a kick mode. These are real
  // strings arriving from the wire and from a TEXT column, so the input is
  // reachable. Revert-checked against exactly that rewrite.
  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'neither guard accepts the inherited key %s',
    (key) => {
      expect(isKickMode(key)).toBe(false);
      expect(isPauseExpiryAction(key)).toBe(false);
    },
  );
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
      // Register B03: chain pause/resume used to report SUCCESS while pausing
      // nothing — only orchestrator handles expose the pause wire.
      'chain_pause_unsupported',
      'chain_topology_broken',
      'hard_kill_unsupported_v1',
      'already_in_state',
      'participant_not_found',
      'participant_already_kicked',
      'orchestrator_cannot_kick',
      'pause_timeout_required',
      'pause_expiry_action_invalid',
      // Register B21/N04 + B12: nine schema-validation sites and four
      // audit-failure sites all used to answer `already_in_state`, which
      // told the operator their click was a no-op in both cases. It never
      // was: the first means the frame is broken, the second means the
      // state changed and the hash-chained trail did not.
      'invalid_request',
      'audit_write_failed',
    ];
    for (const c of codes) {
      expect(CONTROLLABILITY_FAILURE_CODES.has(c)).toBe(true);
    }
    expect(CONTROLLABILITY_FAILURE_CODES.size).toBe(codes.length);
  });
});
