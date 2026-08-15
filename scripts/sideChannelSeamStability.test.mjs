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

/**
 * Locate one `const <name> = useCallback(…)` and split it into body + deps.
 *
 * Prettier writes the terminator two ways depending on whether the dependency
 * array still fits on the closing line — `}, []);` when it does, and a
 * wrapped `},\n    [dep],\n  );` when it does not. Both are matched, because
 * adding a single dependency flips one into the other and an extractor that
 * knows only the first shape reports a failure in the wrong function.
 */
function seamOf(code, name) {
  const start = code.indexOf(`const ${name} = useCallback(`);
  if (start === -1) return null;
  const ends = [code.indexOf('\n  }, [', start), code.indexOf('\n    },\n    [', start)].filter(
    (i) => i !== -1,
  );
  if (ends.length === 0) return null;
  const bodyEnd = Math.min(...ends);
  const open = code.indexOf('[', bodyEnd);
  const close = code.indexOf(']', open);
  if (open === -1 || close === -1) return null;
  return {
    body: code.slice(start, bodyEnd),
    deps: code
      .slice(open + 1, close)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
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

  test('both close over refs only, so the dependency array is honest', () => {
    // The wrap is only safe because neither body reads component state — they
    // touch `wsRef.current` / `msgSubscribersRef.current`. If one grows a
    // state read, the memo becomes a stale closure and this is the reminder.
    //
    // Cebab-1uk widened this from "the EMPTY dependency array" to "the
    // dependency array": turning on `react-hooks/exhaustive-deps` made the rule
    // demand `wsRef` in `readLastRunForTemplate`, because the refs arrive as
    // AppShell props and the rule cannot see the `useRef` behind them. A ref
    // dependency is still honest — a ref object's identity never changes — so
    // the invariant is unchanged; what changed is that `[]` is no longer the
    // only shape it can take. The dep entries are now checked to BE refs,
    // which is a stronger claim than the old literal-`[]` match.
    const code = codeOf(APP);
    for (const name of SEAMS) {
      const seam = seamOf(code, name);
      expect(seam, `${name}: could not locate the useCallback`).not.toBeNull();
      // Every identifier the body reads from the enclosing scope must be a ref.
      expect(seam.body).toMatch(/Ref\.current/);
      expect(seam.body).not.toMatch(/\bstate\./);
      for (const dep of seam.deps) {
        expect(dep, `${name} dependency must be a ref`).toMatch(/Ref$/);
      }
      // Anti-vacuity: the previous version of this test anchored on the literal
      // `\n  }, []);` and, the moment a dependency was added, ran past the end
      // of the function to the NEXT `[]` in the file. The slice then covered
      // unrelated code and the `no state.` assertion failed on someone else's
      // function. A bounded region is the guard against that reading — and
      // against its silent twin, a region so short it asserts nothing.
      expect(seam.body.length).toBeGreaterThan(80);
      expect(seam.body.length).toBeLessThan(1500);
    }
  });
});
