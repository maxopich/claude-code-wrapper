import { describe, expect, test } from 'vitest';
import { classifyArtifact } from './artifact.js';

const CWD = '/work/proj';

describe('classifyArtifact — promotes via directory globs', () => {
  test.each([
    'artifacts/spec.md',
    'deliverables/draft.pdf',
    'plans/q1.md',
    'docs/plans/q1.md',
    'reviews/pr-123.md',
    'reports/coverage.html',
    'specs/api.md',
    'decisions/auth.md',
    'adr/0001-foo.md',
    'rfcs/new-protocol.md',
    'summaries/launch.md',
    'notes/meeting.md',
    // Nested under a promoted directory still counts.
    'plans/subdir/v2.md',
  ])('promotes %s', (rel) => {
    expect(classifyArtifact(rel, CWD)).toBe('promoted');
  });
});

describe('classifyArtifact — promotes via canonical filename globs', () => {
  test.each([
    'PLAN.md',
    'PLAN-v2.md',
    'REVIEW.md',
    'REPORT.md',
    'SPEC.md',
    'SUMMARY.md',
    'DECISIONS.md',
    'TODO.md',
    'NOTES.md',
    'ADR-0001.md',
    'RFC-001.md',
    'ONBOARDING.md',
    'HANDOFF.md',
    // Buried deep — still promoted.
    'src/lib/PLAN.md',
    'a/b/c/ADR-0042.md',
  ])('promotes %s', (rel) => {
    expect(classifyArtifact(rel, CWD)).toBe('promoted');
  });

  test('case-insensitive on canonical filenames', () => {
    expect(classifyArtifact('plan.md', CWD)).toBe('promoted');
    expect(classifyArtifact('Plan-v2.md', CWD)).toBe('promoted');
  });
});

describe('classifyArtifact — operator-locked root exclusions win over default promote', () => {
  test.each(['CLAUDE.md', 'README.md', 'foo.md', 'bar.md'])('root %s is excluded', (rel) => {
    expect(classifyArtifact(rel, CWD)).toBe('excluded');
  });

  test('canonical promote filenames at root still PROMOTE (not excluded)', () => {
    expect(classifyArtifact('PLAN.md', CWD)).toBe('promoted');
    expect(classifyArtifact('HANDOFF.md', CWD)).toBe('promoted');
  });

  test('non-root .md files are NOT auto-excluded by the root rule', () => {
    // `src/notes.md` would match the NOTES*.md canonical regex, so we use a
    // name that hits no canonical pattern.
    expect(classifyArtifact('src/musings.md', CWD)).toBe('scratch');
    expect(classifyArtifact('src/CLAUDE.md', CWD)).toBe('scratch');
  });
});

describe('classifyArtifact — hard excludes override includes', () => {
  test.each([
    'node_modules/lib/foo.md',
    '.git/HEAD',
    'dist/output.md',
    'build/x.html',
    'coverage/index.html',
    '.cebab/cache/x.md',
    '.cebab-session-xyz/orchestrator/PLAN.md',
    '.cebab-scratch/draft.md',
    'iterations/042/x.md',
    'fixtures/sample.json',
    'package-lock.json',
    'pnpm-lock.lock',
    'thing.lock',
    '.DS_Store',
    'dir/.DS_Store',
  ])('excludes %s', (rel) => {
    expect(classifyArtifact(rel, CWD)).toBe('excluded');
  });

  test('promoted dir buried under excluded dir is still excluded', () => {
    expect(classifyArtifact('node_modules/plans/foo.md', CWD)).toBe('excluded');
    expect(classifyArtifact('.git/plans/PLAN.md', CWD)).toBe('excluded');
  });
});

describe('classifyArtifact — scratch default', () => {
  test.each(['src/index.ts', 'src/main.tsx', 'foo/bar/baz.js', 'config.yaml', 'data.json'])(
    '%s is scratch (no glob match)',
    (rel) => {
      expect(classifyArtifact(rel, CWD)).toBe('scratch');
    },
  );
});

describe('classifyArtifact — path resolution against cwd', () => {
  test('absolute path inside cwd is treated as relative', () => {
    expect(classifyArtifact('/work/proj/plans/q1.md', CWD)).toBe('promoted');
  });
  test('absolute path OUTSIDE cwd is scratch (not promoted, even if name matches)', () => {
    // Defensive: an agent writing to /tmp/PLAN.md isn't producing a project
    // deliverable. We surface it inside the agent's lane (scratch) but never
    // bubble it up to Artifacts.
    expect(classifyArtifact('/tmp/PLAN.md', CWD)).toBe('scratch');
    expect(classifyArtifact('/etc/plans/foo.md', CWD)).toBe('scratch');
  });
  test('relative path with ./ prefix normalizes', () => {
    expect(classifyArtifact('./plans/q1.md', CWD)).toBe('promoted');
  });
  test('null cwd: absolute paths fall through as-is', () => {
    // Without a cwd we can't compute relative, but the path can still match
    // canonical filename globs at the leaf.
    expect(classifyArtifact('/whatever/PLAN.md', null)).toBe('promoted');
  });
  test('backslash paths (Windows) normalize to forward slashes', () => {
    expect(classifyArtifact('plans\\q1.md', CWD)).toBe('promoted');
  });
});
