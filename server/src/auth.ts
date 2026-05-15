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
 * cross-uid local attackers (mode 0600 = owner-only read).
 *
 * What this does NOT close: bus workers under `bypassPermissions` run
 * as the operator's uid, so they can read `~/.cebab/auth-token`
 * directly OR call `GET /auth-token` (empty-Origin branch returns the
 * token to local non-browser clients). With the F2 source allowlist
 * (`bus/orchestrator.ts:handleEvent` source ∈ {orchestrator, workers})
 * + F6 `BUS_AGENT_NAME` shape regex (`bus/scripts/bus-send-msg.sh`)
 * in place, a token-holding worker's surface reduces to direct WS
 * control-plane abuse — primarily `set_trusted` flipping a future
 * session's Trust state.
 *
 * Residual after F2+F6+R3: a worker can still impersonate another
 * *known* worker by setting `BUS_AGENT_NAME=<other-worker-slug>` —
 * the slug is a valid shape AND is a participant, so both filters
 * accept it. R3 closes the adjacent slug-shape spoofs (protocol
 * sentinels `user`/`_sink` and Cebab's own `cebab` identity are now
 * rejected as senders), but cross-worker impersonation requires
 * Cebab-as-arbiter: a Unix-socket-mediated bus where Cebab stamps
 * `source` from tmux pane identity rather than trusting the worker's
 * env. Same-uid isolation primitives (`SO_PEERCRED`, XPC with
 * entitlements) are v2 work.
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
