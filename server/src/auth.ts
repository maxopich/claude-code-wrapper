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
import { ensureDataDir } from './data_perms.js';

let token: string | null = null;

export function authTokenPath(): string {
  return path.join(config.dataDir, 'auth-token');
}

/**
 * Generate a fresh token and cache it IN MEMORY. No file is written.
 *
 * Cebab-ygu.41 split this out of `initAuthToken`, and the split is the fix.
 * `initAuthToken` ran before `server.listen()` and is destructive — it unlinks
 * and rewrites `~/.cebab/auth-token` — so a boot that then failed to bind its
 * port (a second server on an occupied 4319) invalidated the HEALTHY server's
 * on-disk token on its way to doing nothing. The live server kept working,
 * because `verifyToken` compares against this in-memory value; what broke was
 * every reader of the FILE, including `ws_smoke.ts`, which started failing 401
 * against a perfectly good server.
 *
 * Generating early is safe and deliberate: both readers take the token at
 * REQUEST time (`auth_token_route` calls `getAuthToken()` inside its handler,
 * the WS upgrade calls `verifyToken`), and no request can arrive before the
 * socket is bound. Doing it here rather than in the bound callback means
 * `getAuthToken()` can never throw and `verifyToken` can never see a null,
 * even in an ordering nobody has thought of.
 */
export function generateAuthToken(): string {
  token = crypto.randomBytes(32).toString('hex');
  return token;
}

/**
 * Write the cached token to disk (mode 0600). THE DESTRUCTIVE HALF — it
 * unlinks any existing file first — so call it only once the server is
 * actually listening (`index.ts` does it from `startListening`'s `onBound`).
 *
 * Throws if no token has been generated: writing an empty file here would
 * lock out every client while looking like a successful boot.
 */
export function persistAuthToken(): string {
  const current = getAuthToken();
  // See the db.ts call site: either of the two can be first depending on boot
  // order, so both go through `ensureDataDir` (Cebab-ws0.8).
  ensureDataDir();
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
  fs.writeFileSync(p, current, writeOpts);
  return current;
}

/**
 * Generate a fresh token, write it to disk (mode 0600), and cache it.
 * Idempotent: subsequent calls overwrite the file with a new random value.
 *
 * The composition of the two halves above, kept because it is the honest
 * contract for every caller that is not the boot path — a test, or any future
 * caller that wants a token on disk now. `index.ts` deliberately does NOT use
 * it: the two halves happen at different moments there, and the gap between
 * them is the whole point (Cebab-ygu.41).
 */
export function initAuthToken(): string {
  generateAuthToken();
  return persistAuthToken();
}

/**
 * Test-only: forget the cached token so a case can reach the "boot generated
 * nothing" state. Nothing in production may call this — the token's lifetime
 * is the process's. Same shape as `_resetOperatorIdCache` and
 * `__resetProbeConcurrencyForTests`.
 */
export function _resetTokenForTests(): void {
  token = null;
}

export function getAuthToken(): string {
  if (!token) throw new Error('auth token not initialized — call initAuthToken() first');
  return token;
}

/**
 * Constant-time compare of a candidate token against the in-memory value.
 * Falls back to `false` for null/empty inputs or length mismatch (which
 * `timingSafeEqual` would otherwise throw on).
 *
 * The length guard compares BYTE lengths, not `String.length`: the latter
 * counts UTF-16 code units while `timingSafeEqual` compares the utf8 Buffers,
 * so a same-code-unit-length candidate carrying any multibyte character (e.g.
 * `'é' + 'a'.repeat(63)` against a 64-hex-char token — 64 code units, 65 bytes)
 * would slip past a `.length` check and make `timingSafeEqual` throw
 * `RangeError: Input buffers must have the same byte length`. That throw
 * escapes the arity-2 `verifyClient` gate (no try/catch inside ws's
 * `handleUpgrade`) and leaks the upgrade socket instead of returning 401
 * (Cebab-ygu.23). Building both Buffers first and comparing `.length` keeps
 * the guard and the compare on the same units.
 */
export function verifyToken(candidate: string | null | undefined): boolean {
  if (!token) return false;
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
