/**
 * The web origin `npm run dev` starts, and how it is declared to the server.
 *
 * WHY THIS EXISTS (register H09). `server/src/origin.ts` used to hardcode
 * `http://127.0.0.1:5173` and `http://localhost:5173` into the allow-list
 * unconditionally. That is not Cebab's port to trust: 5173 is *Vite's default
 * for every Vite project*, so any other project the operator runs serves pages
 * at exactly that origin — and an allow-listed origin can read the per-launch
 * WS token from `GET /auth-token` (the route echoes CORS back to it), i.e. the
 * whole control plane.
 *
 * The rule the allow-list now follows:
 *
 *   An origin is allow-listed only when Cebab BINDS that port (`config.port`)
 *   or a launcher/operator DECLARES it (`CEBAB_ALLOWED_ORIGINS`).
 *
 * `npm run dev` is a launcher: it starts the Vite server itself, so it is
 * entitled to declare that origin to the API child. That entitlement rests on
 * `web/vite.config.ts` setting `strictPort: true` — Vite then either binds
 * DEV_WEB_PORT or exits, and `dev.mjs` tears the server down when either child
 * exits. Without `strictPort` Vite silently shifts to the next free port, the
 * declaration becomes a lie, and the trusted origin belongs to whoever got
 * there first. `scripts/devOrigins.test.mjs` pins that coupling.
 *
 * Running the two halves in separate terminals (`npm run dev:server` +
 * `npm run dev:web`) makes no declaration — nothing there started Vite — so
 * that path needs `CEBAB_ALLOWED_ORIGINS` in `.env`. Documented in
 * `.env.example` and the README.
 */

/** The port `npm run dev` starts Vite on. Must equal `server.port` in
 *  `web/vite.config.ts`; the gate fails if they drift. */
export const DEV_WEB_PORT = 5173;

/** Both loopback spellings of the dev web origin. A browser sends whichever
 *  one the operator typed, and the README points at 127.0.0.1 while Vite's
 *  own banner prints localhost. */
export const DEV_WEB_ORIGINS = Object.freeze([
  `http://127.0.0.1:${DEV_WEB_PORT}`,
  `http://localhost:${DEV_WEB_PORT}`,
]);

/**
 * Return a copy of `env` whose `CEBAB_ALLOWED_ORIGINS` also declares the dev
 * web origins.
 *
 * APPENDS, never clobbers: an operator who set the variable in `.env` (to
 * serve the built bundle from another port, say) must keep it. Order is
 * preserved and duplicates collapse, because `config.allowedOrigins` feeds a
 * Set anyway and a repeated entry would only be noise in a log line.
 *
 * Returns a new object rather than mutating: the caller passes this to ONE
 * child (the API server), and the web child must keep the ambient env — a
 * declaration Vite reads would mean nothing and would make the wiring test
 * unable to tell the two apart.
 */
export function withDeclaredWebOrigins(env) {
  const existing = String(env.CEBAB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...DEV_WEB_ORIGINS])];
  return { ...env, CEBAB_ALLOWED_ORIGINS: merged.join(',') };
}
