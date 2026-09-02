/**
 * The bug this pins was invisible to every gate the repo had.
 *
 * `npm start` serves the built bundle from the API's own port, but the port was
 * compiled into the bundle at BUILD time while `npm start` binds whatever
 * `CEBAB_PORT` says at RUN time. Started on anything but the default, the page
 * loaded perfectly and then asked :4319 for its auth token —
 * `ERR_CONNECTION_REFUSED`, an app that renders and can never connect.
 *
 * Nothing caught it: typecheck and lint see two valid template strings, the
 * server-side tests never run the client, and `App.tsx` has no test file at
 * all. It was found by loading the page in a browser. So the derivation moved
 * into `serverUrls.ts` to be pinnable, and this is the pin.
 */
import { describe, expect, test } from 'vitest';
import { resolveServerUrls } from './serverUrls';

const AT = (host: string, protocol = 'http:') => ({
  protocol,
  host,
  hostname: host.split(':')[0],
});

describe('resolveServerUrls', () => {
  test('same-origin uses the port the page was served from, not the built-in one', () => {
    // The regression itself: built for 4319, served on 4332.
    const urls = resolveServerUrls({
      sameOrigin: true,
      location: AT('127.0.0.1:4332'),
      serverPort: '4319',
    });
    expect(urls.httpBase).toBe('http://127.0.0.1:4332');
    expect(urls.wsUrl).toBe('ws://127.0.0.1:4332');
    expect(urls.httpBase).not.toContain('4319');
    expect(urls.wsUrl).not.toContain('4319');
  });

  test('dev mode keeps the cross-port form — the API is NOT on Vite´s port', () => {
    const urls = resolveServerUrls({
      sameOrigin: false,
      location: AT('127.0.0.1:5173'),
      serverPort: '4319',
    });
    expect(urls.httpBase).toBe('http://127.0.0.1:4319');
    expect(urls.wsUrl).toBe('ws://127.0.0.1:4319');
  });

  test('same-origin on the default port still resolves to that port', () => {
    // The case that made the bug survivable in testing: when the served port
    // happens to equal the built-in one, both branches agree. A test using
    // only this port would pass against the broken implementation.
    const urls = resolveServerUrls({
      sameOrigin: true,
      location: AT('127.0.0.1:4319'),
      serverPort: '4319',
    });
    expect(urls.httpBase).toBe('http://127.0.0.1:4319');
  });

  test('same-origin follows the page scheme so https never yields ws://', () => {
    // Browsers block a ws:// connection from an https page outright, so a
    // hardcoded scheme would be a hard failure rather than a warning.
    const urls = resolveServerUrls({
      sameOrigin: true,
      location: AT('cebab.local:8443', 'https:'),
      serverPort: '4319',
    });
    expect(urls.httpBase).toBe('https://cebab.local:8443');
    expect(urls.wsUrl).toBe('wss://cebab.local:8443');
  });

  test('same-origin on a default-port URL carries no port segment', () => {
    // `location.host` omits :80/:443, and appending one from `hostname` would
    // produce a different origin than the page's own.
    const urls = resolveServerUrls({
      sameOrigin: true,
      location: { protocol: 'http:', host: 'cebab.local', hostname: 'cebab.local' },
      serverPort: '4319',
    });
    expect(urls.httpBase).toBe('http://cebab.local');
    expect(urls.wsUrl).toBe('ws://cebab.local');
  });
});
