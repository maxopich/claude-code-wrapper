import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from './config.js';
import { buildAllowedOrigins, isAllowedHost } from './origin.js';

// F5: Origin + Host gate on WS upgrade and the /auth-token GET. Without
// these, any tab the operator has open could connect to the local server
// (Cross-Site WebSocket Hijacking) and read the per-launch auth token,
// then pivot through the WS as if it were the browser app.
//
// Plan reference: T2.4. The verifyClient handler in ws/server.ts:96-128
// composes these two functions plus verifyToken (covered separately in
// auth.test.ts). Unit-testing the building blocks here lets a refactor
// of the handler that *uses* them stay safe.

let originalAllowedOrigins: string[];

beforeEach(() => {
  originalAllowedOrigins = [...config.allowedOrigins];
});

afterEach(() => {
  config.allowedOrigins.length = 0;
  config.allowedOrigins.push(...originalAllowedOrigins);
});

describe('[security][F5] buildAllowedOrigins', () => {
  test('includes dev (5173) and configured port for both 127.0.0.1 and localhost', () => {
    const origins = buildAllowedOrigins();
    expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(origins.has(`http://127.0.0.1:${config.port}`)).toBe(true);
    expect(origins.has(`http://localhost:${config.port}`)).toBe(true);
  });

  test('includes extras from config.allowedOrigins (CEBAB_ALLOWED_ORIGINS)', () => {
    config.allowedOrigins.push('http://other-host:8080');
    const origins = buildAllowedOrigins();
    expect(origins.has('http://other-host:8080')).toBe(true);
  });

  test('excludes evil cross-origin hosts', () => {
    const origins = buildAllowedOrigins();
    expect(origins.has('http://evil.com')).toBe(false);
    expect(origins.has('https://127.0.0.1:5173')).toBe(false); // https mismatch
    expect(origins.has('http://127.0.0.1')).toBe(false); // missing port
  });
});

describe('[security][F5] isAllowedHost', () => {
  test('accepts 127.0.0.1:<port> and localhost:<port> on the configured port', () => {
    expect(isAllowedHost(`127.0.0.1:${config.port}`)).toBe(true);
    expect(isAllowedHost(`localhost:${config.port}`)).toBe(true);
  });

  test('rejects wrong host', () => {
    expect(isAllowedHost(`evil.com:${config.port}`)).toBe(false);
    expect(isAllowedHost(`0.0.0.0:${config.port}`)).toBe(false);
  });

  test('rejects wrong port', () => {
    expect(isAllowedHost('127.0.0.1:1')).toBe(false);
    expect(isAllowedHost(`127.0.0.1:${config.port + 1}`)).toBe(false);
  });

  test('rejects missing port', () => {
    expect(isAllowedHost('127.0.0.1')).toBe(false);
    expect(isAllowedHost('localhost')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isAllowedHost('')).toBe(false);
  });
});
