/**
 * Origin + Host allow-list shared between the WS upgrade gate and the
 * Express `/auth-token` route. Hoisted out of `ws/server.ts` so both
 * authentication checkpoints (HTTP and WS) gate on the same rules.
 *
 * Browser threat model (per CLAUDE.md): the WS must reject cross-origin
 * connections (CSWSH) — browsers ALWAYS set `Origin` on WS upgrades, so
 * an absent Origin can't be a cross-site hijack, and the WS upgrade
 * therefore ALLOWS an empty Origin (the `?token=` param is the real gate
 * there).
 *
 * `/auth-token` is stricter and REQUIRES a non-empty allow-listed Origin.
 * Its only job is handing the token to the browser, which always sets one;
 * a local non-browser client (smoke tests, curl) must read
 * `~/.cebab/auth-token` directly instead. Serving the token to empty-Origin
 * callers would hand out WS control-plane access to any local process
 * without it even needing filesystem access. See `auth.ts` for the residual
 * this does and does not close.
 */
import { config } from './config.js';

/** Origins permitted to upgrade to a WS or fetch the auth token.
 *  Built once, eagerly — `config.allowedOrigins` is set from
 *  `CEBAB_ALLOWED_ORIGINS` at boot, so no need to re-read. */
export function buildAllowedOrigins(): Set<string> {
  const base = new Set<string>([
    `http://127.0.0.1:5173`,
    `http://localhost:5173`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  for (const o of config.allowedOrigins) base.add(o);
  return base;
}

export function isAllowedHost(host: string): boolean {
  return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
}
