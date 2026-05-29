import { describe, expect, test } from 'vitest';
import type { WsCloseInfo } from '../../ws';
import {
  formatDiagnostic,
  resolveFromAuthTokenResponse,
  resolveFromCloseInfo,
  type ConnectionLostDiagnostic,
} from './connectionLostReason';

// Cluster G E3 UI: reason resolver + diagnostic formatter. These are
// pure functions, so the tests focus on:
//
//   1. Close-code → reason mapping (4001/4002/1006/1011/1000/1001 + a
//      forward-compat default).
//   2. Auth-token HTTP response → reason mapping (403 + X-Cebab-Reject-
//      Reason header values; null → server_unreachable; 5xx →
//      server_unreachable).
//   3. Diagnostic formatter stability (deterministic field order, no
//      credentials in output by construction).

const ws = (overrides: Partial<WsCloseInfo>): WsCloseInfo => ({
  code: 1006,
  reason: '',
  wasClean: false,
  ...overrides,
});

describe('resolveFromCloseInfo', () => {
  test('4001 → auth_token_invalid', () => {
    expect(resolveFromCloseInfo(ws({ code: 4001 }))).toBe('auth_token_invalid');
  });
  test('4002 → session_revoked', () => {
    expect(resolveFromCloseInfo(ws({ code: 4002 }))).toBe('session_revoked');
  });
  test('1006 → server_unreachable (abnormal close, transport drop)', () => {
    expect(resolveFromCloseInfo(ws({ code: 1006, wasClean: false }))).toBe('server_unreachable');
  });
  test('1011 (server error) → unknown', () => {
    // 1011 is too ambiguous to map confidently; we route to `unknown`
    // and surface the code in the diagnostic. Pin this so a future
    // change to map 1011 → some specific reason is deliberate.
    expect(resolveFromCloseInfo(ws({ code: 1011 }))).toBe('unknown');
  });
  test('1000 (normal closure) → unknown (page-unload races would also hit this)', () => {
    expect(resolveFromCloseInfo(ws({ code: 1000, wasClean: true }))).toBe('unknown');
  });
  test('1001 (going away) → unknown', () => {
    expect(resolveFromCloseInfo(ws({ code: 1001 }))).toBe('unknown');
  });
  test('unknown future code → unknown (forward-compat default)', () => {
    expect(resolveFromCloseInfo(ws({ code: 4099 }))).toBe('unknown');
  });
});

describe('resolveFromAuthTokenResponse', () => {
  const respWith = (status: number, header: string | null) => ({
    status,
    headers: { get: (n: string) => (n === 'X-Cebab-Reject-Reason' ? header : null) },
  });

  test('null response (fetch threw) → server_unreachable', () => {
    expect(resolveFromAuthTokenResponse(null)).toBe('server_unreachable');
  });
  test('403 + X-Cebab-Reject-Reason: origin_not_allowed → origin_not_allowed', () => {
    expect(resolveFromAuthTokenResponse(respWith(403, 'origin_not_allowed'))).toBe(
      'origin_not_allowed',
    );
  });
  test('403 + X-Cebab-Reject-Reason: host_not_allowed → host_not_allowed', () => {
    expect(resolveFromAuthTokenResponse(respWith(403, 'host_not_allowed'))).toBe(
      'host_not_allowed',
    );
  });
  test('403 with no header (pre-E3 server or generic proxy 403) → unknown', () => {
    expect(resolveFromAuthTokenResponse(respWith(403, null))).toBe('unknown');
  });
  test('403 with unrecognized header value → unknown (forward-compat)', () => {
    expect(resolveFromAuthTokenResponse(respWith(403, 'some_future_reason'))).toBe('unknown');
  });
  test('502 (stale proxy / gateway error) → server_unreachable', () => {
    expect(resolveFromAuthTokenResponse(respWith(502, null))).toBe('server_unreachable');
  });
  test('500 → server_unreachable (same operator action: check the server)', () => {
    expect(resolveFromAuthTokenResponse(respWith(500, null))).toBe('server_unreachable');
  });
});

describe('formatDiagnostic', () => {
  const baseDiag = (overrides: Partial<ConnectionLostDiagnostic> = {}): ConnectionLostDiagnostic =>
    ({ ts: 1_700_000_000_000, ...overrides }) as ConnectionLostDiagnostic;

  test('minimal — only reason + ts', () => {
    expect(formatDiagnostic('unknown', baseDiag())).toBe(
      ['reason: unknown', 'ts: 2023-11-14T22:13:20.000Z'].join('\n'),
    );
  });
  test('full — all optional fields present, stable field order', () => {
    const out = formatDiagnostic(
      'origin_not_allowed',
      baseDiag({
        url: 'http://localhost:4319/auth-token',
        rejectReason: 'origin_not_allowed',
        closeCode: 4001,
        wasClean: false,
      }),
    );
    expect(out).toBe(
      [
        'reason: origin_not_allowed',
        'ts: 2023-11-14T22:13:20.000Z',
        'url: http://localhost:4319/auth-token',
        'reject_reason: origin_not_allowed',
        'close_code: 4001',
        'was_clean: false',
      ].join('\n'),
    );
  });
  test('partial — only some fields → others omitted (not "url: undefined")', () => {
    const out = formatDiagnostic(
      'server_unreachable',
      baseDiag({ url: 'http://localhost:4319/auth-token' }),
    );
    expect(out).toBe(
      [
        'reason: server_unreachable',
        'ts: 2023-11-14T22:13:20.000Z',
        'url: http://localhost:4319/auth-token',
      ].join('\n'),
    );
  });
  test('does not include credentials/headers/tokens by construction', () => {
    // The input shape doesn't carry headers/cookies/tokens. This is a
    // shape-pinning test — anyone adding a new field to
    // ConnectionLostDiagnostic must also update the formatter AND
    // think about whether it's safe to paste into a bug report. The
    // test forces a deliberate compile + test change to widen.
    const out = formatDiagnostic('unknown', baseDiag());
    expect(out).not.toMatch(/token/i);
    expect(out).not.toMatch(/cookie/i);
    expect(out).not.toMatch(/authorization/i);
  });
});
