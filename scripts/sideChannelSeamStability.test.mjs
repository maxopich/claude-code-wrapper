/**
 * W10 — the WS side-channel seam handed down from App.tsx must be
 * identity-stable.
 *
 * `subscribeServerMsg` and `readLastRunForTemplate` are passed as props into
 * components that put them in `useEffect` dependency arrays — TemplatesPanel's
 * `multi_agent_ended` listener, `useLogStream`'s chunk/tail listener,
 * SessionSearchModal, and ArtifactContentContext's `useMemo`. As plain
 * `function` declarations inside the component body they got a new identity on
 * every App render, and App renders on every WS message: each of those
 * consumers unsubscribed and resubscribed constantly, and the memo never
 * memoised anything.
 *
 * WHY A SOURCE GATE. The behavioural half — that TemplatesPanel subscribes
 * once across N re-renders — is covered in
 * `web/src/components/MultiAgentTab.templateRoles.test.tsx`, but it passes
 * stable callbacks in itself. That test would stay green if App.tsx reverted
 * to `function`, because the component under test is not where the identity is
 * minted. PR #320's lesson exactly: a helper passing proves nothing about its
 * call site, and the source gate written there is what found two more call
 * sites nobody had looked at.
 *
 * WHY IT IS NOT IN `web/`. `web/tsconfig.json` sets `"types": []` so the web
 * program has no `@types/node`, and `web/src/nodeTypeIsolation.test.ts` fails
 * typecheck if that ever stops being true. A web-side test therefore cannot
 * read a file. `scripts/` is where this repo's source-level claims already
 * live (`busSafetyClaims`, `exportConsumers`, `scopedChecks`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(REPO_ROOT, 'web', 'src', 'App.tsx');

/**
 * Comments stripped before matching. A gate that a prose mention can satisfy
 * is the recurring hole in this repo's source scans — the comment right above
 * each of these definitions names the thing it defines.
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

describe('App.tsx side-channel seam stability (W10)', () => {
  const SEAMS = ['subscribeServerMsg', 'readLastRunForTemplate'];

  test('the file loads and still defines both seams', () => {
    // Positive control. Without it, a renamed function or a moved file would
    // make every assertion below pass by matching nothing.
    const code = codeOf(APP);
    for (const name of SEAMS) {
      expect(code).toContain(name);
    }
  });

  // Literal substrings rather than a built RegExp: the assertions are exact
  // matches anyway, and `security/detect-non-literal-regexp` is on repo-wide.
  test.each(SEAMS)('%s is useCallback-wrapped, not a plain function declaration', (name) => {
    const code = codeOf(APP);
    expect(code).toContain(`const ${name} = useCallback(`);
    expect(code).not.toContain(`function ${name}(`);
  });

  test('both close over refs only, so the empty dependency array is honest', () => {
    // The wrap is only safe because neither body reads component state — they
    // touch `wsRef.current` / `msgSubscribersRef.current`. If one grows a
    // state read, `[]` becomes a stale closure and this is the reminder.
    const code = codeOf(APP);
    for (const name of SEAMS) {
      const start = code.indexOf(`const ${name} = useCallback(`);
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, code.indexOf('\n  }, []);', start));
      // Every identifier the body reads from the enclosing scope must be a ref.
      expect(body).toMatch(/Ref\.current/);
      expect(body).not.toMatch(/\bstate\./);
    }
  });
});
