/**
 * [security] Register C12 — Node builtins must not resolve in the web program.
 *
 * `web/` is browser code. If `@types/node` reaches its TypeScript program, a
 * component can `import fs from 'node:fs'`, typecheck cleanly, and fail at
 * runtime in the browser — the class of bug where the compiler is the only
 * thing that could have caught it and didn't.
 *
 * THE INTERESTING PART IS THE DIRECTIVE BELOW, not the assertions.
 * `@ts-expect-error` is an inverted check: it passes while the next line is an
 * error, and TypeScript reports `TS2578: Unused '@ts-expect-error' directive`
 * the moment that line starts compiling. So if Node types ever leak back into
 * this program, `npm run typecheck` fails on THIS file, naming it.
 *
 * That is deliberately not a config assertion. Reading `web/tsconfig.json` and
 * checking for `"types": []` would pass just as happily if some other
 * mechanism — a stray `typeRoots`, a hoisted `@types` folder, a future
 * `tsconfig.base.json` edit — put Node's globals back. The directive tests the
 * thing that matters (can this import resolve?) rather than one configuration
 * that currently causes it.
 *
 * Both directions were measured before relying on it: as written the directive
 * is USED (so `node:fs` does not resolve today), and adding `"types": ["node"]`
 * to `web/tsconfig.json` produces exactly the TS2578 error above.
 */
import { describe, expect, test } from 'vitest';

// @ts-expect-error — Node builtins must not resolve in the web program. If
// this line ever compiles, the directive becomes unused and typecheck fails.
import type { Stats } from 'node:fs';

// Reference the import so `noUnusedLocals` (were it ever enabled) and readers
// both see it is load-bearing. Type-only, so nothing survives to runtime.
export type NodeStatsMustNotResolve = Stats;

describe('[security] web is isolated from Node types', () => {
  test('the vite client types still reach the program', () => {
    // Anti-vacuity for `"types": []` in web/tsconfig.json: emptying it would
    // also be "correct" if it broke `import.meta.env`, and the failure would
    // surface as a confusing type error in App.tsx rather than here.
    // `vite/client` arrives via the triple-slash reference in vite-env.d.ts,
    // which `types` does not govern — this pins that it still works.
    expect(typeof import.meta.env).toBe('object');
  });
});
