/**
 * Per-launch WebSocket authentication token: generated at boot, written to
 * `~/.cebab/auth-token`, fetched by the browser from the Origin+Host-gated
 * `/auth-token` endpoint, and checked by the WS `verifyClient` gate. That
 * mechanism is held by `auth.test.ts`; SECURITY.md's threat-model table is
 * where it, and everything it does and does not close, is stated in full.
 *
 * THE POSTURE IS DETECT, NOT PREVENT, and that is the one thing to know before
 * changing anything here. The token is a boundary against other local users and
 * against browser tabs. It is not one against the agents Cebab itself runs:
 * they have the operator's own uid and can read the file. No control added to
 * THIS module can become that boundary, so hardening happens per control-plane
 * verb instead — `set_trusted` audits before it writes, `mcp_trust_decision`
 * persists only against a live parked gate entry. Reach for those, not for this.
 *
 * The Windows residual — the 0600 mode is deliberately NOT passed there — lives
 * in `tokenWriteOptions` below, which takes the platform as an argument so the
 * decision is assertable from a machine that is not Windows.
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
 * Write options for the token file, as a function of the platform rather than
 * of ambient `process.platform`, so BOTH branches are assertable from either
 * one. That signature is the whole point of this function existing.
 *
 * POSIX gets `mode: 0o600` — owner-only read is the cross-uid protection.
 * Windows gets nothing: Node maps only the write bit to the read-only
 * attribute there, so `0o600` would buy no ACL guarantee while making the code
 * read as though it had. SECURITY.md carries that as a stated residual.
 *
 * Why it is pinned rather than left inline: `auth.test.ts`'s mode assertions
 * skip on win32, so the branch was asserted on no platform at all. Measured —
 * with `process.platform === 'win32' ? {} : …` replaced by an unconditional
 * `{ mode: 0o600 }`, the entire 1,349-test `[security]` suite stayed green and
 * SECURITY.md's "deliberately not passed" line became false with nothing to
 * notice. An edit that reads as hardening is exactly the shape that gets made.
 */
export function tokenWriteOptions(platform: NodeJS.Platform = process.platform): { mode?: number } {
  return platform === 'win32' ? {} : { mode: 0o600 };
}

/**
 * Write the cached token to disk (mode 0600 on POSIX). THE DESTRUCTIVE HALF —
 * it unlinks any existing file first — so call it only once the server is
 * actually listening (`index.ts` does it from `startListening`'s `onBound`).
 *
 * Throws if no token has been generated: writing an empty file here would
 * lock out every client while looking like a successful boot.
 *
 * `platform` is injected for the same reason as in `tokenWriteOptions`, and is
 * what lets a POSIX runner observe the resulting FILE MODE of the win32
 * decision — the pure function alone could be correct and simply not called.
 */
export function persistAuthToken(platform: NodeJS.Platform = process.platform): string {
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
  fs.writeFileSync(p, current, tokenWriteOptions(platform));
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
