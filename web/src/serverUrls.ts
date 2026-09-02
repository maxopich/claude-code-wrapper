import { DEFAULT_PORT } from '@cebab/shared/net';

/**
 * Where the client talks to the API — and it is not one answer, because Cebab
 * runs two ways.
 *
 *   `npm run dev`   Vite serves this bundle on :5173, the API is on :4319.
 *                   Cross-origin, so the port has to be known, and it is baked
 *                   in at build time by `vite.config.ts`'s `define`.
 *   `npm start`     The API server serves this bundle itself, one port, one
 *                   origin (`server/src/static_web.ts`).
 *
 * The second case is why this module exists. The baked-in port is a BUILD-time
 * constant, but the port `npm start` binds is a RUN-time choice (`CEBAB_PORT`),
 * so a bundle built with the default and started on 4332 asked :4319 for its
 * token and got `ERR_CONNECTION_REFUSED` — a working page, correctly served,
 * that could never connect. Same-origin serving must therefore read the port
 * off `window.location` rather than trust what was compiled in.
 *
 * `import.meta.env.DEV` is the discriminator: Vite sets it true only for `vite
 * dev`, so a built bundle is by definition one the server is serving. (A bundle
 * served some other way — `vite preview`, a foreign static host — would read as
 * same-origin and be wrong, but nothing in the repo does that and the dev
 * server is the supported cross-origin path.)
 */
export const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? String(DEFAULT_PORT);

/** The parts of `window.location` this needs, so tests need no jsdom navigation. */
export type LocationParts = { protocol: string; hostname: string; host: string };

/**
 * @param sameOrigin true when this bundle is served by the API server itself.
 * @param location   `window.location` (or the three fields of it).
 * @param serverPort the build-time API port, used only when NOT same-origin.
 */
export function resolveServerUrls(opts: {
  sameOrigin: boolean;
  location: LocationParts;
  serverPort: string;
}): { httpBase: string; wsUrl: string } {
  const { sameOrigin, location, serverPort } = opts;
  if (sameOrigin) {
    // `host` not `hostname`: it carries the port, which is the whole point.
    // And follow the page's scheme — a future https deployment must not have
    // its WS silently downgraded to ws://, which browsers block anyway.
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return {
      httpBase: `${location.protocol}//${location.host}`,
      wsUrl: `${wsScheme}//${location.host}`,
    };
  }
  return {
    httpBase: `http://${location.hostname}:${serverPort}`,
    wsUrl: `ws://${location.hostname}:${serverPort}`,
  };
}
