/**
 * Register N27: the default server port has ONE source of truth.
 *
 * `4319` used to be repeated as a literal fallback in six files — the client
 * (`web/src/App.tsx`), the server config (`server/src/config.ts`), three smoke
 * scripts (`ci_smoke.ts`, `ws_smoke.ts`, `live_smoke.ts`) and the Vite config
 * (`web/vite.config.ts`). Changing the default meant finding all six, and a
 * missed one silently targeted the old port. `DEFAULT_PORT` in
 * `shared/src/net.ts` is now the single definition; this gate keeps it that
 * way.
 *
 * WHY A GATE. The failure this fixes is exactly the one a lint pass cannot see:
 * a seventh copy, or one of the six drifting back to a bare literal, typechecks
 * and runs fine while re-opening the maintenance hazard. Same shape as
 * `scripts/configSurfaceClaims.test.mjs` — read the files, assert a structural
 * property, keep a parser out of it.
 *
 * ANTI-VACUITY. Both checkers are exercised against verbatim pre-fix strings
 * that they MUST flag and post-fix strings they must NOT, independently of the
 * tree — so scanning the corrected tree cannot pass just because the checkers
 * measure nothing.
 *
 * THE COMMENT STRIPPER IS THE SHARED ONE, and it has to be. This file used to
 * carry its own two-line `stripComments` — block comments, then `//` to end of
 * line — which strips from the `//` of a URL onward. Measured: it turns
 * `const base = 'ws://127.0.0.1:4319';` into `const base = 'ws:`, so the check
 * below found no literal and passed. That string is the pre-fix shape this
 * gate was written to reject, and a URL is the only form a hardcoded port
 * takes in this tree, so the gate was blind to its entire subject. The copy
 * was also a fourth hand-rolled stripper outside the three that
 * `scripts/stripCommentsConformance.test.mjs` pins byte-identical — the exact
 * arrangement that file's header says the repo already paid for once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './lib/strip_comments.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The single definition and its canonical value. */
const NET_FILE = 'shared/src/net.ts';

/**
 * Files that must derive their port fallback from `DEFAULT_PORT` rather than
 * repeat the literal. `hasComment` is true only where a bare `4319` legitimately
 * survives in prose (config.ts's parser docstring), so those files are checked
 * for the import + a clean assignment line rather than for zero occurrences.
 */
const CONSUMERS = [
  { file: 'server/src/config.ts', hasComment: true },
  // Moved out of App.tsx when single-port serving landed: the client now has
  // TWO ways to reach the API (same-origin, and the dev cross-port form), and
  // the fallback constant belongs beside the code that chooses between them.
  { file: 'web/src/serverUrls.ts', hasComment: true },
  { file: 'web/vite.config.ts', hasComment: false },
  { file: 'server/src/ci_smoke.ts', hasComment: false },
  { file: 'server/src/ws_smoke.ts', hasComment: false },
  { file: 'server/src/live_smoke.ts', hasComment: false },
  { file: 'server/src/single_port_smoke.ts', hasComment: false },
];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** A consumer must import the shared constant. */
function importsDefaultPort(src) {
  return /import\s*\{[^}]*\bDEFAULT_PORT\b[^}]*\}\s*from\s*['"]@cebab\/shared(?:\/net)?['"]/.test(
    src,
  );
}

describe('register N27: default port single source', () => {
  test('shared/src/net.ts is the one definition of DEFAULT_PORT = 4319', () => {
    const src = read(NET_FILE);
    expect(src).toMatch(/export const DEFAULT_PORT = 4319;/);
  });

  for (const { file, hasComment } of CONSUMERS) {
    test(`${file} derives its port from DEFAULT_PORT`, () => {
      const src = read(file);
      expect(importsDefaultPort(src), `${file} should import DEFAULT_PORT`).toBe(true);
      // No bare 4319 literal survives in code (comments are stripped first).
      expect(stripComments(src)).not.toMatch(/4319/);
      if (!hasComment) {
        // Files with no legitimate prose mention carry no 4319 at all.
        expect(src).not.toMatch(/4319/);
      }
    });
  }

  describe('anti-vacuity: the checkers actually reject the pre-fix shapes', () => {
    test('importsDefaultPort flags a file missing the import', () => {
      expect(importsDefaultPort(`const base = 'ws://127.0.0.1:4319';`)).toBe(false);
      expect(importsDefaultPort(`import { DEFAULT_PORT } from '@cebab/shared/net';`)).toBe(true);
      expect(importsDefaultPort(`import { DEFAULT_PORT } from '@cebab/shared';`)).toBe(true);
    });

    test('stripComments leaves code literals but removes prose ones', () => {
      expect(stripComments(`const PORT = process.env.PORT ?? '4319';`)).toMatch(/4319/);
      expect(stripComments(`// Number(process.env.PORT ?? 4319) was the shape`)).not.toMatch(
        /4319/,
      );
      expect(stripComments(`/** ... ?? 4319 ... */`)).not.toMatch(/4319/);
    });

    test('a port inside a URL survives stripping — the shape the old copy ate', () => {
      // Not a style preference. The replaced local stripper cut from the `//`
      // of the scheme onward, so every one of these read as "no literal here"
      // and the per-consumer check above passed on the pre-fix source.
      for (const src of [
        `const base = 'ws://127.0.0.1:4319';`,
        `const u = "http://localhost:4319/health";`,
        'const t = `ws://127.0.0.1:4319`;',
      ]) {
        expect(stripComments(src), src).toMatch(/4319/);
      }
    });
  });
});
