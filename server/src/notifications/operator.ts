import os from 'node:os';

/**
 * Cluster A Phase 1 / OQ-1 resolution: operator identity for the
 * `safety_audit.operator_id` column and `safety_audit_ack.acked_by`.
 *
 * Cebab is single-user-local in v1, but the schema retrofit later is
 * painful (XCT-1) so we lock in an identity string now. `os.userInfo()`
 * gives meaningful forensic value with zero config; the `'local-user'`
 * fallback covers sandboxed CI where `userInfo()` can throw with ENOSYS or
 * a missing passwd entry.
 *
 * Cached at first call so a repository in a hot loop doesn't pay the
 * syscall per row. Module-scoped — no DI — because there is exactly one
 * operator per process in v1.
 */
let cached: string | undefined;

export function getOperatorId(): string {
  if (cached !== undefined) return cached;
  try {
    const username = os.userInfo().username;
    cached = username && username.length > 0 ? username : 'local-user';
  } catch {
    cached = 'local-user';
  }
  return cached;
}

/** Test-only: reset the memoised value so test isolation isn't compromised. */
export function _resetOperatorIdCache(): void {
  cached = undefined;
}
