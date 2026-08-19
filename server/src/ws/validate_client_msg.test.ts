/**
 * Register S17 — inbound frame shape validation.
 *
 * Three things need proving, and they are independent:
 *
 *   1. The table COVERS the union. `Table` makes that a typecheck failure, but
 *      a typecheck failure is only a gate while the annotation is still there;
 *      loosening `SHAPES` to `Record<string, …>` would compile fine. So the
 *      first block re-derives the discriminants from `shared/src/protocol.ts`
 *      as a second, independent witness.
 *   2. The validator ACCEPTS everything the real client sends. This is the
 *      riskiest half of the change: marking an optional field required breaks
 *      the app at runtime while every other test stays green. `SAMPLES` is
 *      annotated `ClientMsg[]`, so the compiler proves each sample is a legal
 *      message, and each one deliberately OMITS its optional fields.
 *   3. The validator REJECTS the shapes that made handlers misbehave.
 */
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ClientMsg } from '@cebab/shared';
import { CLIENT_MSG_TYPES, validateClientMsg } from './validate_client_msg.js';

/**
 * Every ClientMsg variant, with optional fields omitted.
 *
 * Typed as `ClientMsg[]`, so `npm run typecheck` refuses a sample that is not
 * a legal message — which is what stops this from being a restatement of the
 * table it is checking.
 */
const SAMPLES: ClientMsg[] = [
  { type: 'list_projects' },
  { type: 'open_project', projectId: 1 },
  { type: 'send_message', projectId: 1, text: 'hi' },
  { type: 'interrupt', sessionId: 's' },
  { type: 'permission_decision', sessionId: 's', requestId: 'r', decision: 'allow' },
  { type: 'set_trusted', projectId: 1, trusted: false },
  { type: 'set_project_model', projectId: 1, model: null },
  { type: 'set_project_start_permission_mode', projectId: 1, mode: null },
  { type: 'get_model_catalogue' },
  { type: 'load_session', projectId: 1, sessionId: 's' },
  { type: 'get_settings' },
  { type: 'set_workspace_root', path: '/tmp/agents' },
  { type: 'set_default_hop_budget', value: 8 },
  { type: 'set_default_max_turns', value: 20 },
  { type: 'set_permission_mode', sessionId: 's', mode: 'acceptEdits' },
  { type: 'rename_session', sessionId: 's', title: null },
  { type: 'install_bus_integration', projectId: 1 },
  { type: 'uninstall_bus_integration', projectId: 1 },
  { type: 'start_multi_agent', mode: 'chain', participants: [1, 2], initialPrompt: 'go' },
  { type: 'stop_multi_agent', sessionId: 's' },
  { type: 'resume_multi_agent', sessionId: 's' },
  { type: 'continue_multi_agent', sessionId: 's' },
  { type: 'retry_worker', sessionId: 's' },
  { type: 'abandon_session', sessionId: 's' },
  { type: 'continue_through_mutation', sessionId: 's', mutationId: 7 },
  { type: 'multi_agent_user_prompt', sessionId: 's', text: 'hi' },
  { type: 'multi_agent_ask_user_answer', sessionId: 's', agent: 'a', toolUseId: 't', answers: {} },
  { type: 'list_iterations' },
  { type: 'clear_iterations' },
  { type: 'archive_session', sessionId: 's' },
  { type: 'reopen_session', sessionId: 's' },
  { type: 'reopen_session_confirmed', sessionId: 's', acknowledgedWorkspaceDiff: true },
  { type: 'set_multi_agent_lifecycle', sessionId: 's', lifecycle: 'temp' },
  { type: 'add_multi_agent_participant', sessionId: 's', projectId: 1 },
  { type: 'list_templates' },
  { type: 'save_template', name: 'n', mode: 'chain', lifecycle: 'temp', participants: [1] },
  { type: 'delete_template', id: 'i' },
  { type: 'load_session_log', sessionId: 's', offset: 0, limit: 50 },
  { type: 'read_project_facts', projectId: 1 },
  { type: 'get_last_run_for_template', templateId: 't' },
  { type: 'ack_notification', id: 'n' },
  { type: 'request_inbox_snapshot' },
  { type: 'clear_dismissed_inbox' },
  { type: 'get_project_authority', projectId: 1, mode: 'cache' },
  { type: 'mcp_trust_decision', serverName: 'm', originPath: '/p', decision: 'trust' },
  { type: 'bus_trust_decision', pendingId: 'p', projectId: 1, decision: 'trust' },
  { type: 'acknowledge_and_start', pendingStartId: 'p', typedAcknowledgment: 'inject' },
  { type: 'cancel_gate', kind: 'mcp', pendingId: 'p' },
  { type: 'retry_rate_limited', sessionId: 's' },
  { type: 'start_auth_refresh' },
  { type: 'cancel_auth_refresh', runId: 'r' },
  { type: 'get_recovery_log_snapshot' },
  { type: 'get_storage_stats' },
  { type: 'get_stray_session_folders' },
  { type: 'delete_stray_session_folders', names: ['.cebab-session-abc'] },
  { type: 'get_kick_forensics', sessionId: 's', agentSlug: 'a' },
  { type: 'stop_reason', sessionId: 's', interruptAckId: 'i', reasonCode: 'off_task' },
  { type: 'mute_participant', sessionId: 's', projectId: 1, reasonCode: 'off_task' },
  { type: 'unmute_participant', sessionId: 's', projectId: 1, reasonCode: 'off_task' },
  {
    type: 'pause_participant',
    sessionId: 's',
    projectId: 1,
    reasonCode: 'off_task',
    timeoutMs: 60_000,
    expiryAction: 'auto_resume',
  },
  { type: 'resume_participant', sessionId: 's', projectId: 1, reasonCode: 'off_task' },
  { type: 'kick_participant', sessionId: 's', projectId: 1, reasonCode: 'off_task', mode: 'drain' },
  { type: 'bulk_session_op', sessionIds: ['a', 'b'], op: 'archive' },
  { type: 'search_sessions', query: 'q', scope: 'all_projects' },
  { type: 'get_artifact_content', mutationId: 3 },
];

/** A round-trip through the wire, since that is the only way frames arrive. */
function overTheWire(v: unknown): ReturnType<typeof validateClientMsg> {
  return validateClientMsg(JSON.parse(JSON.stringify(v)));
}

describe('the table covers the ClientMsg union', () => {
  // Independent witness: parse the discriminants out of the type definition
  // rather than trusting the annotation on SHAPES. Split on /\r?\n/ so a CRLF
  // checkout on Windows reads the same as a LF one.
  const declaredTypes = (): Set<string> => {
    const src = fs.readFileSync(
      new URL('../../../shared/src/protocol.ts', import.meta.url),
      'utf8',
    );
    const lines = src.split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith('export type ClientMsg ='));
    expect(start, 'ClientMsg union not found in protocol.ts').toBeGreaterThan(-1);
    const out = new Set<string>();
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      // The union ends where the next top-level declaration begins.
      if (/^(export |declare |type |const )/.test(line)) break;
      // Peeled by hand rather than with one regex: `\s*(?:\|\s*\{\s*)?` puts
      // three variable-length runs next to each other, which eslint's
      // `security/detect-unsafe-regex` rejects (and the repo lints at
      // --max-warnings 0). A variant is either `| { type: 'x'; … }` on one
      // line or `| {` with `type: 'x';` on the next.
      const body = line.trim().replace(/^\|/, '').trim();
      const m = /^type: '([a-z_]+)'/.exec(body.replace(/^\{/, '').trim());
      if (m) out.add(m[1]!);
    }
    return out;
  };

  test('every declared message type has a shape entry, and vice versa', () => {
    const declared = declaredTypes();
    // Anti-vacuity: a parser that found nothing would make both directions
    // below trivially true.
    expect(declared.size).toBeGreaterThan(50);
    expect([...declared].sort()).toEqual([...CLIENT_MSG_TYPES].sort());
  });

  test('[security] every message type has a sample, so no entry is unexercised', () => {
    expect(SAMPLES).toHaveLength(CLIENT_MSG_TYPES.length);
    expect(SAMPLES.map((s) => s.type).sort()).toEqual([...CLIENT_MSG_TYPES].sort());
  });
});

describe('accepts what the real client sends', () => {
  test.each(SAMPLES.map((s) => [s.type, s] as const))(
    '%s, with every optional field omitted',
    (_type, sample) => {
      const r = overTheWire(sample);
      expect(r.ok ? null : r.reason).toBeNull();
    },
  );

  test('optional fields are also accepted when present', () => {
    expect(
      overTheWire({ type: 'send_message', projectId: 1, sessionId: 's', text: 'hi', maxTurns: 5 })
        .ok,
    ).toBe(true);
    expect(
      overTheWire({
        type: 'search_sessions',
        query: 'q',
        scope: 'this_project',
        projectId: 2,
        includeArchived: true,
        raw: false,
        limit: 10,
      }).ok,
    ).toBe(true);
  });

  test('unknown extra fields are ignored, not rejected', () => {
    // Forward compatibility: an older server must not refuse a newer client's
    // additive field.
    expect(overTheWire({ type: 'interrupt', sessionId: 's', futureField: 1 }).ok).toBe(true);
  });

  test('the three frames ws_smoke.ts sends all validate', () => {
    // These are literal copies of `server/src/ws_smoke.ts`. If the validator
    // ever rejects one, `npm run smoke`'s WS counterpart breaks in CI with a
    // silent hang rather than a failed assertion.
    expect(overTheWire({ type: 'list_projects' }).ok).toBe(true);
    expect(overTheWire({ type: 'open_project', projectId: 1 }).ok).toBe(true);
    expect(
      overTheWire({ type: 'send_message', projectId: 1, text: 'irrelevant in mock mode' }).ok,
    ).toBe(true);
  });
});

describe('rejects malformed frames', () => {
  test.each([
    ['null', null],
    ['an array', []],
    ['a bare string', 'interrupt'],
    ['a number', 7],
    ['an object with no type', { sessionId: 's' }],
    ['a non-string type', { type: 7 }],
    ['an unknown type', { type: 'drop_database' }],
  ])('%s', (_label, frame) => {
    expect(validateClientMsg(frame).ok).toBe(false);
  });

  test('a starting permission mode must be one of the two, or null', () => {
    // Both directions. Too NARROW (plain `permissionMode`, rejecting null)
    // would leave the operator able to set a starting mode and never unset
    // one; too WIDE (plain `'string|null'`, no guard) would let
    // `bypassPermissions` — a real SDK mode Cebab deliberately never exposes —
    // through the wire and into a spawn's seed.
    const ok = (mode: unknown) =>
      overTheWire({ type: 'set_project_start_permission_mode', projectId: 1, mode }).ok;
    expect(ok(null)).toBe(true);
    expect(ok('default')).toBe(true);
    expect(ok('acceptEdits')).toBe(true);

    expect(ok('bypassPermissions')).toBe(false);
    expect(ok('plan')).toBe(false);
    expect(ok('dontAsk')).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok(1)).toBe(false);

    const bad = overTheWire({
      type: 'set_project_start_permission_mode',
      projectId: 1,
      mode: 'plan',
    });
    expect(bad.ok ? '' : bad.reason).toContain('set_project_start_permission_mode.mode');
    // A missing projectId must not write to project `undefined`.
    expect(overTheWire({ type: 'set_project_start_permission_mode', mode: null }).ok).toBe(false);
  });

  test('a model choice must be a string or null, and null must survive', () => {
    // `null` is the CLEAR operation, and it is the one a loose spec breaks:
    // widening the kind to plain 'string' would reject it, leaving the
    // operator able to set a model and never able to unset one. Both
    // directions are asserted because too-narrow and too-wide are different
    // bugs and each passes the other's test.
    expect(overTheWire({ type: 'set_project_model', projectId: 1, model: null }).ok).toBe(true);
    expect(overTheWire({ type: 'set_project_model', projectId: 1, model: 'sonnet' }).ok).toBe(true);

    const bad = overTheWire({ type: 'set_project_model', projectId: 1, model: 42 });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.reason).toContain('set_project_model.model');
    expect(overTheWire({ type: 'set_project_model', projectId: 1, model: { v: 'x' } }).ok).toBe(
      false,
    );
    // A missing projectId cannot be allowed to write to project `undefined`.
    expect(overTheWire({ type: 'set_project_model', model: 'sonnet' }).ok).toBe(false);
  });

  test('get_model_catalogue accepts the bare form and rejects a mistyped refresh', () => {
    // Both fields optional: a plain cache read needs neither. `refresh` is what
    // decides whether this SPAWNS a CLI, so a truthy string must not reach it.
    expect(overTheWire({ type: 'get_model_catalogue' }).ok).toBe(true);
    expect(overTheWire({ type: 'get_model_catalogue', projectId: 3, refresh: true }).ok).toBe(true);
    expect(overTheWire({ type: 'get_model_catalogue', refresh: 'true' }).ok).toBe(false);
    expect(overTheWire({ type: 'get_model_catalogue', projectId: '3' }).ok).toBe(false);
  });

  test('[security] a truthy string does not become a trust decision', () => {
    // The finding's concrete case. `msg.trusted` reaches
    // `setProjectTrusted(projectId, trusted)` and the audit payload's `to`
    // field; `"false"` is truthy, so this frame used to TRUST the project
    // while recording `to: "false"` in the hash-chained log — a value that is
    // neither of the field's two legal states.
    const r = overTheWire({ type: 'set_trusted', projectId: 1, trusted: 'false' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toContain('set_trusted.trusted');
    // …and the legitimate frame still gets through, both ways round.
    expect(overTheWire({ type: 'set_trusted', projectId: 1, trusted: false }).ok).toBe(true);
    expect(overTheWire({ type: 'set_trusted', projectId: 1, trusted: true }).ok).toBe(true);
  });

  test('[security] a prototype-chain name is not a known message type', () => {
    // `SHAPES[type]` with a bare `in` or lookup would resolve these to
    // functions on Object.prototype.
    for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const r = validateClientMsg({ type });
      expect(r.ok, `${type} must not validate`).toBe(false);
    }
  });

  test('a missing required field is rejected', () => {
    expect(overTheWire({ type: 'open_project' }).ok).toBe(false);
    expect(overTheWire({ type: 'send_message', projectId: 1 }).ok).toBe(false);
    expect(overTheWire({ type: 'load_session_log', sessionId: 's', offset: 0 }).ok).toBe(false);
  });

  test('a wrong-typed field is rejected even when present', () => {
    expect(overTheWire({ type: 'open_project', projectId: '1' }).ok).toBe(false);
    expect(overTheWire({ type: 'interrupt', sessionId: 42 }).ok).toBe(false);
    expect(overTheWire({ type: 'set_default_hop_budget', value: '8' }).ok).toBe(false);
  });

  test('an optional field present with the wrong type is rejected', () => {
    // The easy thing to get wrong: "optional" must mean absent-or-right, not
    // absent-or-anything.
    expect(overTheWire({ type: 'archive_session', sessionId: 's', removeArtifacts: 1 }).ok).toBe(
      false,
    );
    expect(overTheWire({ type: 'send_message', projectId: 1, text: 't', maxTurns: 'all' }).ok).toBe(
      false,
    );
  });

  test('arrays are checked element by element, not just as arrays', () => {
    expect(overTheWire({ type: 'bulk_session_op', sessionIds: 'a', op: 'archive' }).ok).toBe(false);
    expect(overTheWire({ type: 'bulk_session_op', sessionIds: ['a', 2], op: 'archive' }).ok).toBe(
      false,
    );
    expect(
      overTheWire({
        type: 'start_multi_agent',
        mode: 'chain',
        participants: [1, '2'],
        initialPrompt: 'go',
      }).ok,
    ).toBe(false);
  });

  test('a nullable field takes null or a string, and nothing else', () => {
    expect(overTheWire({ type: 'rename_session', sessionId: 's', title: null }).ok).toBe(true);
    expect(overTheWire({ type: 'rename_session', sessionId: 's', title: 'x' }).ok).toBe(true);
    expect(overTheWire({ type: 'rename_session', sessionId: 's', title: 7 }).ok).toBe(false);
    // Absent is NOT the same as null here — the field is required.
    expect(overTheWire({ type: 'rename_session', sessionId: 's' }).ok).toBe(false);
  });

  test('an object field rejects arrays and null', () => {
    const base = {
      type: 'multi_agent_ask_user_answer',
      sessionId: 's',
      agent: 'a',
      toolUseId: 't',
    };
    expect(overTheWire({ ...base, answers: {} }).ok).toBe(true);
    expect(overTheWire({ ...base, answers: [] }).ok).toBe(false);
    expect(overTheWire({ ...base, answers: null }).ok).toBe(false);
    expect(overTheWire({ ...base, answers: 'q=a' }).ok).toBe(false);
  });

  test('NaN and Infinity are not numbers here', () => {
    // Unreachable through JSON.parse, reachable from any non-browser client
    // that builds the object directly. `timeoutMs` and `limit` both reach
    // arithmetic.
    expect(validateClientMsg({ type: 'open_project', projectId: NaN }).ok).toBe(false);
    expect(validateClientMsg({ type: 'get_artifact_content', mutationId: Infinity }).ok).toBe(
      false,
    );
  });

  test('fields whose union ships a runtime guard are checked against it', () => {
    // The five that cost no second copy. Everything else in the union is
    // checked as `string` on purpose — see the file header.
    expect(overTheWire({ type: 'set_permission_mode', sessionId: 's', mode: 'bypass' }).ok).toBe(
      false,
    );
    expect(
      overTheWire({ type: 'set_permission_mode', sessionId: 's', mode: 'acceptEdits' }).ok,
    ).toBe(true);

    const kick = { type: 'kick_participant', sessionId: 's', projectId: 1, reasonCode: 'off_task' };
    expect(overTheWire({ ...kick, mode: 'obliterate' }).ok).toBe(false);
    expect(overTheWire({ ...kick, mode: 'hard' }).ok).toBe(true);
    expect(overTheWire({ ...kick, reasonCode: 'because', mode: 'hard' }).ok).toBe(false);

    const pause = {
      type: 'pause_participant',
      sessionId: 's',
      projectId: 1,
      reasonCode: 'off_task',
      timeoutMs: 1000,
    };
    expect(overTheWire({ ...pause, expiryAction: 'auto_delete' }).ok).toBe(false);
    expect(overTheWire({ ...pause, expiryAction: 'auto_kick' }).ok).toBe(true);

    const stop = { type: 'stop_reason', sessionId: 's', interruptAckId: 'i' };
    expect(overTheWire({ ...stop, reasonCode: 'vibes' }).ok).toBe(false);
    expect(overTheWire({ ...stop, reasonCode: 'runaway_loop' }).ok).toBe(true);
  });
});

describe('the rejection reason is safe to log', () => {
  test('it names the field but never the value', () => {
    const secret = 'sk-ant-not-a-real-key-0000';
    const r = validateClientMsg({ type: 'send_message', projectId: 1, text: 7, secret });
    expect(r.ok).toBe(false);
    const reason = r.ok ? '' : r.reason;
    expect(reason).toContain('send_message.text');
    expect(reason).not.toContain(secret);
  });

  test('an absurd type is truncated rather than logged whole', () => {
    const r = validateClientMsg({ type: 'x'.repeat(5000) });
    expect(r.ok).toBe(false);
    expect((r.ok ? '' : r.reason).length).toBeLessThan(100);
  });
});
