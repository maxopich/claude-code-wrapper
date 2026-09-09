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
import fs from 'node:fs';

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
 * Read `CEBAB_ALLOWED_ORIGINS` out of a dotenv file, or `[]` if the file is
 * absent, unreadable, or does not set it.
 *
 * WHY THIS EXISTS, and it is the whole of `Cebab-6fax.29`. The server child is
 * launched with `--env-file-if-exists=../.env` AND an explicit `env` object.
 * Measured: a variable already present in the parent env WINS over the env
 * file — `CEBAB_TEST_VAL=x node --env-file-if-exists=f -e ...` prints `x`, not
 * the file's value. So passing `CEBAB_ALLOWED_ORIGINS` explicitly does not
 * merely fail to include the operator's `.env` value, it SHADOWS it. The
 * "appends, never clobbers" promise below was true of the function and false
 * of the outcome, because the value it was appending to had never been read.
 *
 * Deliberately a four-line parser rather than a dotenv dependency: this reads
 * exactly one key, at launcher startup, and a dependency here would be
 * installed on every machine to do that. `export ` prefixes and surrounding
 * quotes are handled because operators write them; anything more exotic is the
 * env file's own business and reaches the child through Node's parser anyway.
 */
export function readEnvFileOrigins(envFilePath) {
  let text;
  try {
    text = fs.readFileSync(envFilePath, 'utf8');
  } catch {
    return [];
  }
  let raw = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^export\s+/, '');
    if (!t.startsWith('CEBAB_ALLOWED_ORIGINS=')) continue;
    // LAST assignment wins, matching how dotenv parsers and shells behave.
    raw = t.slice('CEBAB_ALLOWED_ORIGINS='.length).trim();
  }
  if (raw === null) return [];
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  return unquoted
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return a copy of `env` whose `CEBAB_ALLOWED_ORIGINS` also declares the dev
 * web origins.
 *
 * APPENDS, never clobbers: an operator who set the variable in `.env` (to
 * serve the built bundle from another port, say) must keep it. Order is
 * preserved and duplicates collapse, because `config.allowedOrigins` feeds a
 * Set anyway and a repeated entry would only be noise in a log line.
 *
 * `declared` is what the caller read out of the env file the child will also
 * be given — see `readEnvFileOrigins` for why the caller has to supply it
 * rather than this function trusting `env`.
 *
 * Returns a new object rather than mutating: the caller passes this to ONE
 * child (the API server), and the web child must keep the ambient env — a
 * declaration Vite reads would mean nothing and would make the wiring test
 * unable to tell the two apart.
 */
export function withDeclaredWebOrigins(env, declared = []) {
  const existing = String(env.CEBAB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...declared, ...DEV_WEB_ORIGINS])];
  return { ...env, CEBAB_ALLOWED_ORIGINS: merged.join(',') };
}
