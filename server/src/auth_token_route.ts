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
 *   - `/auth-token`   — empty Origin REJECTED (here). It is the token-issuing
 *                       endpoint. Its only client is the browser, which always
 *                       sets Origin; any other local client is expected to read
 *                       `~/.cebab/auth-token` off disk instead (as ws_smoke,
 *                       live_smoke and ci_smoke already do).
 *
 * This is a convenience-path removal, not a boundary. A process running as the
 * operator's uid can still read the file — see the residual documented in
 * `auth.ts`. What it buys is that obtaining the token now requires filesystem
 * access, and that the code matches what `origin.ts` always claimed.
 *
 * TRAP for a future change: browsers omit `Origin` on SAME-origin GETs. Today
 * the SPA is always served by Vite on :5173 while this API is on :PORT, so the
 * fetch is cross-origin and carries an Origin. If the Node server is ever made
 * to serve the built SPA on its own port, that fetch becomes same-origin, loses
 * the header, and this route starts 403ing the app itself. At that point the
 * token should be inlined into the served HTML (or handed over the WS) rather
 * than loosening this gate back to "empty Origin is fine".
 */
export function mountAuthTokenRoute(app: Express): void {
  const allowedOrigins = buildAllowedOrigins();

  app.get('/auth-token', (req: Request, res: Response): void => {
    const origin = String(req.headers.origin ?? '');
    const host = String(req.headers.host ?? '');

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
      console.warn('[http] /auth-token reject: empty origin (non-browser client)');
      reject('origin_not_allowed');
      return;
    }
    if (!allowedOrigins.has(origin)) {
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
    // this line it is both non-empty and allow-listed, which is the canonical
    // safe form of reflective CORS. Semgrep's generic rule can't see the
    // upstream checks. No preflight is involved (the fetch sends no custom
    // headers).
    // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.type('text/plain').send(getAuthToken());
  });
}
