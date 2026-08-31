/**
 * Register N27: the default server port, defined once.
 *
 * `4319` was repeated as a literal fallback in six files — the client
 * (`web/src/App.tsx`), the server config (`server/src/config.ts`), three smoke
 * scripts (`server/src/ci_smoke.ts`, `ws_smoke.ts`, `live_smoke.ts`) and the
 * Vite config (`web/vite.config.ts`). Changing the default meant finding all
 * six, and a missed one silently targeted the old port. This is the single
 * source; every site derives its fallback from it.
 *
 * A number, not a string: `config.ts` parses it as one and the string-typed
 * sites coerce with `String(DEFAULT_PORT)` at their one use each, which keeps
 * the canonical value unambiguous.
 */
export const DEFAULT_PORT = 4319;
