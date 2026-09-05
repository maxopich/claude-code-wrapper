import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from './config.js';
import {
  _resetTokenForTests,
  authTokenPath,
  generateAuthToken,
  getAuthToken,
  initAuthToken,
  persistAuthToken,
  tokenWriteOptions,
  verifyToken,
} from './auth.js';

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

  test('rejects a same-code-unit-length candidate whose utf8 byte length differs', () => {
    // Cebab-ygu.23: `String.length` is UTF-16 code units but `timingSafeEqual`
    // compares utf8 Buffers. The 64-hex-char token has `.length === 64`, and so
    // does `'é' + 'a'.repeat(63)` — but that candidate is 65 utf8 bytes, so a
    // `.length`-based guard let it through and `timingSafeEqual` threw
    // `RangeError: Input buffers must have the same byte length`. In the WS
    // upgrade gate (arity-2 `verifyClient`, no try/catch in ws) that throw
    // escaped to the process `uncaughtException` handler and leaked the upgrade
    // socket instead of returning a clean 401. verifyToken must return false.
    const tok = initAuthToken();
    const multibyte = 'é' + 'a'.repeat(tok.length - 1);
    expect(multibyte.length).toBe(tok.length); // equal in UTF-16 code units...
    expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(Buffer.byteLength(tok, 'utf8')); // ...but not in utf8 bytes
    expect(() => verifyToken(multibyte)).not.toThrow();
    expect(verifyToken(multibyte)).toBe(false);
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

// ---- Cebab-ygu.41: generating a token must not touch the file on disk ----

describe('[security][Cebab-ygu.41] generateAuthToken / persistAuthToken', () => {
  test('generateAuthToken writes NO file and still answers every reader', () => {
    // The fix, stated as behaviour. `index.ts` calls this during boot, before
    // it knows whether it can even bind its port; both readers take the token
    // at request time, so the in-memory value is all that is needed until the
    // socket exists.
    const tok = generateAuthToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(authTokenPath())).toBe(false);
    expect(getAuthToken()).toBe(tok);
    expect(verifyToken(tok)).toBe(true);
  });

  test('A DOOMED BOOT LEAVES THE RUNNING SERVER’S TOKEN FILE INTACT', () => {
    // The regression, without needing two servers and a port. Server A is
    // live and its token is on disk; server B boots, generates its own, and
    // then fails to bind — so it must never reach `persistAuthToken`.
    //
    // Before the split this was `initAuthToken()`, which unlinked and rewrote
    // the file: the live server kept working (it compares against its own
    // in-memory copy) while `ws_smoke.ts`, which reads the FILE, started
    // failing 401 against it.
    const serverA = initAuthToken();
    const onDisk = fs.readFileSync(authTokenPath(), 'utf8');
    expect(onDisk).toBe(serverA);

    const serverB = generateAuthToken();
    expect(serverB).not.toBe(serverA);

    expect(fs.readFileSync(authTokenPath(), 'utf8')).toBe(serverA);
  });

  test('persistAuthToken writes the cached token at mode 0600', () => {
    const tok = generateAuthToken();
    persistAuthToken();
    expect(fs.readFileSync(authTokenPath(), 'utf8')).toBe(tok);
    if (process.platform !== 'win32') {
      expect(fs.statSync(authTokenPath()).mode & 0o777).toBe(0o600);
    }
  });

  test('persistAuthToken replaces a pre-existing loose-moded file', () => {
    // Same guarantee `initAuthToken` had: the unlink-first pattern is what
    // makes 0600 hold for a file an earlier build left at 0644.
    fs.mkdirSync(path.dirname(authTokenPath()), { recursive: true });
    fs.writeFileSync(authTokenPath(), 'stale', { mode: 0o644 });
    const tok = generateAuthToken();
    persistAuthToken();
    expect(fs.readFileSync(authTokenPath(), 'utf8')).toBe(tok);
    if (process.platform !== 'win32') {
      expect(fs.statSync(authTokenPath()).mode & 0o777).toBe(0o600);
    }
  });

  test('persistAuthToken refuses to write when nothing was generated', () => {
    // An empty file here would lock out every client while looking like a
    // clean boot — the same class of silent-wrong-state this bead is about.
    _resetTokenForTests();
    expect(() => persistAuthToken()).toThrowError(/not initialized/);
    expect(fs.existsSync(authTokenPath())).toBe(false);
  });
});

describe('[security] the Windows residual is a decision, not an accident', () => {
  // Every mode assertion above skips on win32, so before this block the branch
  // was asserted on NO platform: the full 1,349-test [security] suite stayed
  // green with `process.platform === 'win32' ? {} : …` replaced by a flat
  // `{ mode: 0o600 }`, silently falsifying SECURITY.md's stated residual.
  //
  // These pass the platform in, which is what makes them run identically on a
  // Mac, a Linux runner and a Windows runner.

  test('POSIX platforms get owner-only 0600', () => {
    for (const platform of ['darwin', 'linux', 'freebsd'] as NodeJS.Platform[]) {
      expect(tokenWriteOptions(platform)).toEqual({ mode: 0o600 });
    }
  });

  test('win32 gets NO mode key at all — not a mode that happens to be absent', () => {
    // `toEqual({})` alone would pass for `{ mode: undefined }`, which reads as
    // deliberate omission and is not: `writeFileSync` treats that as 0o666.
    expect(tokenWriteOptions('win32')).toEqual({});
    expect('mode' in tokenWriteOptions('win32')).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'and the WRITE uses it — a win32 write really does land without 0600',
    () => {
      // The pure function above could be correct and simply never called. This
      // drives the real write path twice, with only the platform differing, and
      // observes the mode the file actually ends up with. umask is pinned so
      // the non-0600 outcome is deterministic rather than runner-dependent.
      const priorUmask = process.umask(0o022);
      try {
        generateAuthToken();
        persistAuthToken('linux');
        expect(fs.statSync(authTokenPath()).mode & 0o777).toBe(0o600);

        generateAuthToken();
        persistAuthToken('win32');
        expect(fs.statSync(authTokenPath()).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(priorUmask);
      }
    },
  );
});
