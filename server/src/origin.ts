/**
 * Origin + Host allow-list shared between the WS upgrade gate and the
 * Express `/auth-token` route. Hoisted out of `ws/server.ts` so both
 * authentication checkpoints (HTTP and WS) gate on the same rules.
 *
 * Browser threat model (per CLAUDE.md): the WS must reject cross-origin
 * connections (CSWSH) — browsers ALWAYS set `Origin` on WS upgrades, so
 * an absent Origin can't be a cross-site hijack. The same rule applies
 * to the `/auth-token` GET: a browser cross-origin fetch would carry
 * a non-allowed `Origin`, and any local non-browser client (smoke
 * tests, curl) must instead read the token directly from
 * `~/.cebab/auth-token`. See `auth.ts`.
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
