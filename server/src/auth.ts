/**
 * Per-launch WebSocket authentication token.
 *
 * Generated once at server boot and written to `~/.cebab/auth-token`
 * (mode 0600). Browsers fetch the token via the Origin+Host-gated
 * `/auth-token` HTTP endpoint mounted alongside `/health`, then pass
 * it as a `?token=` query param on the WS upgrade. The WS verifyClient
 * gate rejects upgrades whose token doesn't match.
 *
 * What this closes: browser-tab Cross-Site WebSocket Hijacking (a
 * cross-origin tab can't pass the Origin gate to fetch the token) and
 * OTHER local users on POSIX (mode 0600 = owner-only read; see the
 * Windows caveat below).
 *
 * What this does NOT close — and cannot: a bus agent runs as the
 * operator's own uid, so it can read `~/.cebab/auth-token` off disk and
 * open its own WS connection. There is no same-uid boundary to build
 * here. Origin/Host are not one either — a Node client sets any header it
 * likes — which is why `/auth-token` requiring an Origin (index.ts) only
 * removes the convenience path, not the capability.
 *
 * So the posture is DETECT, not prevent, and the control-plane verbs are
 * hardened where an ungated call was never legitimate in the first place:
 *
 *   - `mcp_trust_decision` only persists `trust`/`trust_pinned` when a
 *     live gate entry is parked, so a trust row can never be pre-seeded to
 *     silently pass the operator's next session-start gate. Denials stay
 *     ungated (reducing authority needs no prompt).
 *   - `set_trusted` writes a `project.trust_decided` row to the
 *     hash-chained audit log before it flips anything, and refuses if that
 *     append fails.
 *
 * Everything else a token-holder can reach (starting sessions, reading
 * transcripts, template CRUD) is inside what the operator's own uid could
 * do regardless. Treat the token as a boundary against other local users
 * and browser tabs, never against the agents Cebab itself runs.
 *
 * Windows: the 0600 mode below is deliberately NOT passed (`win32` gets
 * `{}` — see `initAuthToken`), because it is meaningless without an ACL
 * call. On a multi-user Windows box the token file is readable by other
 * users of that machine. SECURITY.md records this as a known residual.
 *
 * Bus identity spoofing is closed by construction in the pure-SDK
 * model: a worker's `source` is pinned by Cebab in the per-agent
 * `bus_send` tool closure (`bus/runner.ts`), not read from a
 * worker-controlled env var or file, so a worker cannot forge another
 * participant's identity. The F2/F3 source-allowlist drop filters in
 * the routers are kept verbatim as defense-in-depth (source ∈
 * {orchestrator, workers}; sentinels `user`/`_sink` and Cebab's own
 * `cebab` identity rejected as senders).
 *
 * Single-process, single-token: regenerated on every boot. There's no
 * persistence to disk beyond the file itself, and the in-process value
 * lives in module-level state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let token: string | null = null;

export function authTokenPath(): string {
  return path.join(config.dataDir, 'auth-token');
}

/**
 * Generate a fresh token, write it to disk (mode 0600), and cache it.
 * Idempotent: subsequent calls overwrite the file with a new random
 * value. Always call once at server boot before mounting routes.
 */
export function initAuthToken(): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  token = crypto.randomBytes(32).toString('hex');
  const p = authTokenPath();
  // writeFileSync + mode: ensure file is created 0600 even if it pre-exists
  // with looser permissions (writeFileSync doesn't chmod existing files,
  // so unlink-first is the safe pattern).
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  // POSIX-only: `mode: 0o600` is the cross-uid protection (owner-only read
  // of ~/.cebab/auth-token). Windows ignores POSIX mode bits — Node maps
  // only the write bit to the read-only attribute, so 0o600 there grants
  // no ACL guarantee. The file still lives under the operator's profile;
  // multi-user Windows hardening (per-user ACLs) is a documented residual,
  // not enforced here. Passing the mode on Windows is harmless but
  // misleading, so gate it.
  const writeOpts = process.platform === 'win32' ? {} : { mode: 0o600 };
  fs.writeFileSync(p, token, writeOpts);
  return token;
}

export function getAuthToken(): string {
  if (!token) throw new Error('auth token not initialized — call initAuthToken() first');
  return token;
}

/**
 * Constant-time compare of a candidate token against the in-memory value.
 * Falls back to `false` for null/empty inputs or length mismatch (which
 * `timingSafeEqual` would otherwise throw on).
 */
export function verifyToken(candidate: string | null | undefined): boolean {
  if (!token) return false;
  if (typeof candidate !== 'string' || candidate.length !== token.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(candidate);
  return crypto.timingSafeEqual(a, b);
}
