import type { Express, Request, Response } from 'express';
import { getAuthToken } from './auth.js';
import { buildAllowedOrigins, isAllowedHost } from './origin.js';
import { recordRejection } from './notifications/origin_rejections.js';

/**
 * `GET /auth-token` — hands the per-launch WS token to the browser app.
 *
 * Extracted from `index.ts` so the Origin posture is unit-testable (mirrors
 * `mountSessionLogExport`), because this endpoint is the one place a caller
 * can OBTAIN the token rather than merely present it.
 *
 * Origin posture, and why it differs from every other local surface:
 *
 *   - WS upgrade      — empty Origin ALLOWED. Browsers always set Origin on a
 *                       WS upgrade, so an absent one can't be a CSWSH; the
 *                       `?token=` param is the real gate there.
 *   - `/session-log`  — empty Origin ALLOWED. It requires `verifyToken`, so an
 *                       empty-Origin caller already holds the secret; the
 *                       endpoint hands out nothing new.
 *   - `/auth-token`   — empty Origin allowed ONLY for a same-origin browser
 *                       fetch, proven by `Sec-Fetch-Site` (below). Every other
 *                       empty-Origin caller is rejected and expected to read
 *                       `~/.cebab/auth-token` off disk instead, as ci_smoke and
 *                       the local live smokes already do.
 *
 * THE TRAP THIS FILE PREDICTED, AND WHAT IT COST TO RESOLVE. The previous
 * version of this comment warned that browsers omit `Origin` on same-origin
 * GETs, so serving the SPA from the Node server's own port would make this
 * route 403 the app itself — and it recommended inlining the token into the
 * served HTML rather than "loosening this gate back to 'empty Origin is fine'".
 * Single-port serving landed (`static_web.ts`), so the trap fired. Both of the
 * obvious fixes turned out to be the SAME exposure, which is the part worth
 * recording:
 *
 *   - inlining the token into `index.html` hands it to anything that can
 *     `curl http://127.0.0.1:PORT/`, because serving the page is ungated;
 *   - accepting empty Origin whenever `Host` is ours hands it to anything that
 *     can `curl http://127.0.0.1:PORT/auth-token`, because curl sets `Host`
 *     itself. The Host check does not distinguish a browser from a script and
 *     was never going to.
 *
 * `Sec-Fetch-Site` is the one signal that does. It is a forbidden header name,
 * so page JS cannot set or override it via `fetch()`, and browsers emit it on
 * every request; a non-browser client does not send it by default. That is the
 * same CLASS of protection this route always had — note that today
 * `curl -H 'Origin: http://127.0.0.1:PORT'` already satisfies the check below,
 * because `buildAllowedOrigins()` allow-lists the port Cebab binds. So this is
 * still a convenience-path removal rather than a boundary, exactly as the
 * paragraph after this one has always said; what changed is that it now also
 * holds when the app and the API share an origin.
 *
 * A process running as the operator's uid can still read the token file — see
 * the residual documented in `auth.ts`.
 */
export function mountAuthTokenRoute(app: Express): void {
  const allowedOrigins = buildAllowedOrigins();

  app.get('/auth-token', (req: Request, res: Response): void => {
    const origin = String(req.headers.origin ?? '');
    const host = String(req.headers.host ?? '');
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '');

    const reject = (reason: 'origin_not_allowed' | 'host_not_allowed'): void => {
      recordRejection({
        origin: origin || null,
        host: host || null,
        reason,
        channel: 'http',
      });
      res.setHeader('X-Cebab-Reject-Reason', reason);
      res.status(403).end();
    };

    if (!origin) {
      // The single-port case. `same-origin` is the only accepted value: a
      // cross-site or cross-origin request would say so here, and `none` means
      // a user-typed address bar rather than the app's own fetch.
      if (fetchSite !== 'same-origin') {
        console.warn('[http] /auth-token reject: empty origin (non-browser client)');
        reject('origin_not_allowed');
        return;
      }
    } else if (!allowedOrigins.has(origin)) {
      console.warn(`[http] /auth-token reject: bad origin ${JSON.stringify(origin)}`);
      reject('origin_not_allowed');
      return;
    }
    if (!isAllowedHost(host)) {
      console.warn(`[http] /auth-token reject: bad host ${JSON.stringify(host)}`);
      reject('host_not_allowed');
      return;
    }

    // CORS: in dev the web origin is :5173 but the API is :4319, so a bare
    // fetch fails the browser's same-origin check. Echo back the Origin — by
    // this line it is allow-listed, which is the canonical safe form of
    // reflective CORS. Semgrep's generic rule can't see the upstream checks.
    // No preflight is involved (the fetch sends no custom headers).
    //
    // The echo is skipped when Origin was absent: there is no value to echo,
    // and `Access-Control-Allow-Origin: ` (empty) is a header a same-origin
    // response has no use for.
    // `Vary` is set either way: the response body is the same, but WHICH
    // requests are answered depends on Origin, and a cache keyed without it
    // could hand a same-origin answer to a cross-origin asker.
    res.setHeader('Vary', 'Origin');
    if (origin) {
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.type('text/plain').send(getAuthToken());
  });
}
