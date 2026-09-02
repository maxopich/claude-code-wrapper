import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

/**
 * Serves the built web bundle from the same origin as the API, so Cebab runs
 * without Vite — the difference between "clone it and develop" and "download it
 * and use it".
 *
 * ONE candidate path, unlike `assistantKbRoot()` in `assistant/identity.ts`
 * which walks two. That module is nested a directory deeper, so `src` and
 * `dist` bottom out at different depths; this file sits at the top of both, and
 * `../..` is the repo root either way. A second candidate here would be a
 * path that can never match — an exemption nobody uses, which is the shape the
 * bounded-reads gate refuses for its own allowlist.
 */
export function webDistPath(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');
}

/**
 * `webDistPath()` when a build is actually there, else null.
 *
 * Split from the path math above so the resolution can be tested on a checkout
 * that has never run `npm run build` — a single function returning null would
 * leave the only interesting assertion (did the `..` count land in the repo
 * root?) unreachable exactly where CI runs it.
 */
export function resolveWebDist(): string | null {
  const dist = webDistPath();
  return fs.existsSync(path.join(dist, 'index.html')) ? dist : null;
}

/**
 * API paths the SPA fallback must never answer for.
 *
 * Express matches in registration order, so the routes mounted before this
 * middleware already win — this list is the second line, and what it actually
 * buys is that a TYPO in a future route is not masked. Without it `/helth`
 * returns the SPA's HTML with status 200 and a caller parses that as a health
 * response; with it, an unmatched path under a known API prefix 404s as itself.
 */
const API_PREFIXES = ['/health', '/auth-token', '/session-log'] as const;

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Mount static serving of `web/dist` plus an SPA history fallback.
 *
 * Call AFTER every API route, for the ordering reason above.
 *
 * Returns the directory being served, or null when there is nothing to serve —
 * the ordinary state of a checkout that has never run `npm run build`, which is
 * why this is a no-op rather than an error.
 */
export function mountWebApp(app: Express, dist: string | null = resolveWebDist()): string | null {
  if (!dist) return null;

  // `index: false` because the fallback below owns index.html. Leaving the
  // default would serve it from two code paths — here for `/`, there for
  // everything else — which could drift apart in the headers they set.
  app.use(express.static(dist, { index: false, redirect: false }));

  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isApiPath(req.path)) return next();
    // `{ root }` rather than an absolute path, and it is not a style choice.
    // `send` refuses any path with a dot-segment in it, and with no `root` it
    // applies that rule to the WHOLE absolute path — so an install under
    // `~/.local/share/cebab` (or a git worktree under `.claude/`) 404s every
    // client route while serving assets fine, i.e. a blank page with a working
    // network tab. With `root` set, the rule applies only to the part after
    // it, which is the literal 'index.html'. Found by `single_port_smoke.ts`
    // on the first real boot; no unit test using a tmpdir would have, because
    // `os.tmpdir()` has no dot-segment.
    res.sendFile('index.html', { root: dist });
  });

  return dist;
}
