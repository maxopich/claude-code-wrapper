import { describe, expect, test } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { getDb } from '../db.js';
import { appendSafetyAudit } from './safety_audit.js';
import { appendForensics, getForensicsByAuditId } from '../repo/controllability_forensics.js';
import { captureSingleAgentForensics } from './forensic_snapshot.js';

/**
 * Register D18: the forensics table was the ONE surface over these bytes with
 * no redactor. `forensic_snapshot.ts` imported `node:crypto`, `node:fs`,
 * `node:path` and a type — nothing from `redact` — and stored the SDK
 * envelope and the pending tool input verbatim.
 *
 * That matters more than the other surfaces, not less: bundles are written on
 * Stop and on kick, i.e. exactly when something has gone wrong and a
 * credential is most likely in flight; the rows are permanent (append-only by
 * design, and they survive session deletion); and they replay to the browser
 * through `get_kick_forensics`.
 */

withTempDataDir('cebab-forensics-redaction-');

/** A parent audit row, so the forensics FK is satisfied. */
function seedAudit(): string {
  return appendSafetyAudit({
    ts: 1_700_000_000_000,
    sessionId: 'sess-1',
    kind: 'session.stopped',
    reasonCode: 'operator',
    payload: {},
  }).id;
}

function storedRow(auditId: string) {
  const row = getForensicsByAuditId(auditId);
  expect(row).toBeDefined();
  return row!;
}

describe('[security] nothing enters controllability_forensics unredacted', () => {
  test('a pending tool input carrying a credential is masked on the way in', () => {
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
      pendingToolCalls: [
        {
          requestId: 'r1',
          toolName: 'Bash',
          toolInput: { command: 'deploy --key AKIAIOSFODNN7EXAMPLE' },
        },
      ],
    });

    const json = storedRow(auditId).pending_tool_calls_json!;
    expect(json).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(json).toContain('<redacted>');
  });

  test('a key-named field inside the prompt is masked too', () => {
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'captured', text: 'go', api_key: 'plain-value-here' },
      eventsLastN: [],
    });

    const json = storedRow(auditId).effective_prompt_json;
    expect(json).not.toContain('plain-value-here');
    expect(json).toContain('<redacted>');
  });

  test('the mask is at the WRITE, so a caller that forgets is still covered', () => {
    // The point of putting `redactColumn` in `appendForensics` rather than in
    // the two capture helpers: a future third caller inherits the guarantee.
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: null,
      eventsLastN: [],
      busInboxOutbox: { inbox: [{ textPreview: 'token: AKIAIOSFODNN7EXAMPLE' }], outbox: [] },
      mutationRationale: { recentMutations: [{ summary: 'ran AKIAIOSFODNN7EXAMPLE' }] },
    });

    const row = storedRow(auditId);
    expect(row.bus_inbox_outbox_json).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(row.mutation_rationale_json).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('Cebab-generated metadata is NOT masked — it is not agent bytes', () => {
    // The negative control. Over-masking here would destroy the bundle's
    // usefulness: the workdir hash and the ids are how an operator correlates
    // it with anything else.
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
      workdirTreeHash: 'deadbeefcafe',
      snapshotFailedReason: 'workdir_hash_failed: EACCES',
    });

    const row = storedRow(auditId);
    expect(row.workdir_tree_hash).toBe('deadbeefcafe');
    expect(row.snapshot_failed_reason).toBe('workdir_hash_failed: EACCES');
    expect(row.session_id).toBe('sess-1');
  });
});

describe('[security] a serialised SDK envelope is masked by KEY NAME, not just by value', () => {
  test('captureSingleAgentForensics parses raw before masking it', () => {
    // The reason `redactRawEventJson` exists. `eventsLastN[].raw` is a JSON
    // STRING, and a key name inside a serialised blob is just characters —
    // only the inline value patterns could reach it, i.e. the weaker half of
    // the policy applied to the largest payload in the bundle.
    const bundle = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [
        {
          seq: 1,
          ts: 1_700_000_000_000,
          type: 'assistant',
          subtype: null,
          // `hunter2` matches NO inline value pattern. It is caught only
          // because `api_key` is a sensitive KEY — which requires parsing.
          raw: JSON.stringify({ message: { content: [{ api_key: 'hunter2' }] } }),
        },
      ],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: 'default' },
      projectCwd: undefined,
    });

    const events = bundle.eventsLastN as Array<{ raw: string }>;
    expect(events[0]!.raw).not.toContain('hunter2');
    expect(events[0]!.raw).toContain('<redacted>');
  });

  test('the raw column is still a JSON string, so downstream parsers survive', () => {
    // `parseBusEvents` / the forensic viewer read this as a string. Masking
    // must not change the shape.
    const bundle = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [
        {
          seq: 1,
          ts: 1_700_000_000_000,
          type: 'assistant',
          subtype: null,
          raw: JSON.stringify({ password: 'p', keep: 'visible' }),
        },
      ],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: 'default' },
      projectCwd: undefined,
    });

    const events = bundle.eventsLastN as Array<{ raw: string }>;
    const reparsed = JSON.parse(events[0]!.raw) as Record<string, unknown>;
    expect(reparsed.password).toBe('<redacted>');
    expect(reparsed.keep).toBe('visible');
  });

  test('an unparseable raw column degrades to value-pattern masking, not to nothing', () => {
    const bundle = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [
        {
          seq: 1,
          ts: 1_700_000_000_000,
          type: 'assistant',
          subtype: null,
          raw: 'not json at all AKIAIOSFODNN7EXAMPLE',
        },
      ],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: 'default' },
      projectCwd: undefined,
    });

    const events = bundle.eventsLastN as Array<{ raw: string }>;
    expect(events[0]!.raw).toBe('<redacted>');
  });
});

describe('the forensics row survives its own redaction', () => {
  test('a bundle with nothing sensitive is stored byte-identical', () => {
    // Anti-vacuity for the whole suite: if `redactColumn` masked everything,
    // every assertion above would pass and the table would be useless.
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'captured', text: 'refactor the parser', projectId: 3 },
      eventsLastN: [{ seq: 1, ts: 2, type: 'assistant', subtype: null, raw: '{"ok":true}' }],
    });

    const row = storedRow(auditId);
    expect(JSON.parse(row.effective_prompt_json)).toEqual({
      source: 'captured',
      text: 'refactor the parser',
      projectId: 3,
    });
    expect(row.events_last_n_json).toContain('{\\"ok\\":true}');
    expect(row.events_last_n_json).not.toContain('<redacted>');
  });

  test('the table is reachable at all — anti-vacuity on the seed', () => {
    const auditId = seedAudit();
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    const count = getDb().prepare('SELECT COUNT(*) AS c FROM controllability_forensics').get() as {
      c: number;
    };
    expect(count.c).toBeGreaterThan(0);
  });
});
