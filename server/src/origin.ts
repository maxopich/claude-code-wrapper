/**
 * Origin + Host allow-list shared between the WS upgrade gate, the Express
 * `/auth-token` route and `/session-log`. Hoisted out of `ws/server.ts` so
 * every authentication checkpoint (HTTP and WS) gates on the same rules.
 *
 * Browser threat model (see `docs/safety-and-security.md`): the WS must reject cross-origin
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

/**
 * Origins permitted to upgrade to a WS or fetch the auth token.
 *
 * The rule, and it is the whole point of this function (register H09):
 *
 *   An origin is allow-listed only when Cebab BINDS that port, or when a
 *   launcher/operator DECLARES it via `CEBAB_ALLOWED_ORIGINS`.
 *
 * So there is exactly one port literal reachable from here — `config.port`,
 * which `index.ts` binds — and everything else arrives declared.
 *
 * This file used to also hardcode `:5173` unconditionally. That port is
 * *Vite's default for every Vite project*, so it is not Cebab's to trust: any
 * other local project the operator runs serves pages at that exact origin, and
 * an allow-listed origin gets the per-launch WS token handed to it by
 * `/auth-token` (with a CORS echo, so browser JS can read it). The dev origin
 * is now declared by `npm run dev`, which starts that Vite itself — see
 * `scripts/dev-origins.mjs` for why starting it is what earns the trust, and
 * `.env.example` for the two-terminal workflow that has to declare it by hand.
 *
 * NOTE that `http://localhost:${config.port}` is included on the strength of
 * Cebab binding `127.0.0.1:${config.port}` — `index.ts` listens on
 * `config.host`, and nothing binds `::1`. On a host that resolves `localhost`
 * to `::1` that is not quite the same claim. Tracked as `Cebab-y7d`; the
 * options there are a trade (bind both, drop the entry, or resolve at boot),
 * not a typo fix, which is why it is not folded in here.
 *
 * Built once, eagerly — `config.allowedOrigins` is set from
 * `CEBAB_ALLOWED_ORIGINS` at boot, so no need to re-read.
 */
export function buildAllowedOrigins(): Set<string> {
  const base = new Set<string>([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  for (const o of config.allowedOrigins) base.add(o);
  return base;
}

export function isAllowedHost(host: string): boolean {
  return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
}
