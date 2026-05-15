import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from './config.js';
import { authTokenPath, getAuthToken, initAuthToken, verifyToken } from './auth.js';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-auth-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
});

afterEach(() => {
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[security][F4] initAuthToken', () => {
  test('writes the token to ~/.cebab/auth-token with mode 0600', () => {
    const tok = initAuthToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    // File exists at the documented path and matches the in-memory value.
    expect(fs.readFileSync(authTokenPath(), 'utf8')).toBe(tok);
    // Mode 0600 — group/world have no access. We mask permissions because
    // some filesystems also set sticky/setuid bits we don't care about.
    // Windows' fs layer doesn't carry Unix permission bits; auth.ts
    // platform-gates the 0600 write the same way, so assert off-Windows.
    if (process.platform !== 'win32') {
      const st = fs.statSync(authTokenPath());
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  test('regenerates a fresh token on each call', () => {
    const a = initAuthToken();
    const b = initAuthToken();
    expect(a).not.toBe(b);
    expect(fs.readFileSync(authTokenPath(), 'utf8')).toBe(b);
  });

  test('overwrites a pre-existing token file with looser permissions', () => {
    // Simulate an old token file with broader perms (e.g. left over from a
    // prior run or an operator-manual touch). initAuthToken must replace
    // it cleanly with 0600 — otherwise a worker that pre-creates the path
    // could keep read access.
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(authTokenPath(), 'stale', { mode: 0o644 });
    initAuthToken();
    // See note above: the Unix-mode assertion only applies off-Windows.
    if (process.platform !== 'win32') {
      expect(fs.statSync(authTokenPath()).mode & 0o777).toBe(0o600);
    }
  });
});

describe('[security][F4] verifyToken', () => {
  test('accepts the current in-memory token', () => {
    const tok = initAuthToken();
    expect(verifyToken(tok)).toBe(true);
  });

  test('rejects null, undefined, and empty input', () => {
    initAuthToken();
    expect(verifyToken(null)).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
    expect(verifyToken('')).toBe(false);
  });

  test('rejects a wrong-length candidate (would crash timingSafeEqual)', () => {
    initAuthToken();
    expect(verifyToken('short')).toBe(false);
    expect(verifyToken('x'.repeat(128))).toBe(false);
  });

  test('rejects a same-length-but-different candidate', () => {
    const tok = initAuthToken();
    const wrong = tok.split('').reverse().join('');
    expect(wrong).not.toBe(tok);
    expect(verifyToken(wrong)).toBe(false);
  });
});

describe('getAuthToken', () => {
  test('returns the active token after init', () => {
    const tok = initAuthToken();
    expect(getAuthToken()).toBe(tok);
  });
});
