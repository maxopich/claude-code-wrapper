/**
 * Register W29: the call sites that carry an operator DECISION must route
 * through `sendThenApply`, so the UI cannot show a decision that never went
 * out.
 *
 * WHY A SOURCE GATE. `web/src/sendThenApply.test.ts` proves the helper honours
 * the ordering, and it would stay green if `decidePermission` went back to
 * dispatching its optimistic `permission_decided` first and calling `send`
 * afterwards — which is precisely how the defect shipped. PR #320 and #322
 * both learned this the same way: a helper passing proves nothing about its
 * call sites, and the source gate written for #320 is what turned up two more
 * nobody had looked at.
 *
 * WHY IT IS NOT IN `web/`. `web/tsconfig.json` sets `"types": []` so the web
 * program has no `@types/node`, and `web/src/nodeTypeIsolation.test.ts` fails
 * typecheck if that ever stops being true. A web-side test therefore cannot
 * read a file. `scripts/` is where this repo's source-level claims already
 * live (`busSafetyClaims`, `exportConsumers`, `sideChannelSeamStability`).
 *
 * SCOPE, stated so a later reader does not mistake it for more than it is:
 * this checks the two sends that apply optimistic state or have no other
 * feedback. The ~59 other `send` call sites in App.tsx are deliberately not
 * covered — their failure is now at least visible in the console, and forcing
 * every list-refresh through a decision helper would be noise.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(REPO_ROOT, 'web', 'src', 'App.tsx');

/**
 * Comments stripped before matching. Every function below is named in the
 * prose right above it, so a scan over raw text would be satisfied by the
 * explanation rather than the code.
 */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** The body of `function <name>(...)` up to the first line that dedents to `}`. */
function bodyOf(code, name) {
  const start = code.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const end = code.indexOf('\n  }', start);
  return end === -1 ? code.slice(start) : code.slice(start, end);
}

describe('App.tsx optimistic sends go through sendThenApply (W29)', () => {
  const SITES = ['decidePermission', 'interruptSession'];

  test('the helper and both call sites still exist', () => {
    // Positive control. Without it, a rename would make every assertion below
    // pass by matching nothing.
    const code = codeOf(APP);
    expect(code).toContain('export function sendThenApply(');
    for (const name of SITES) {
      expect(bodyOf(code, name), `${name} not found in App.tsx`).not.toBeNull();
    }
  });

  test.each(['decidePermission', 'interruptSession'])('%s routes through sendThenApply', (name) => {
    const body = bodyOf(codeOf(APP), name);
    expect(body).toContain('sendThenApply({');
  });

  test('decidePermission does not dispatch its optimistic update outside the helper', () => {
    // The exact regression: `dispatch({ type: 'server', msg: { type:
    // 'permission_decided' … } })` sitting at the top of the function, before
    // the send, is what left the buttons claiming a decision that never
    // landed. Inside `apply:` it can only run after a successful send.
    const body = bodyOf(codeOf(APP), 'decidePermission');
    const helperAt = body.indexOf('sendThenApply({');
    const dispatchAt = body.indexOf('permission_decided');
    expect(helperAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(helperAt);
  });
});
