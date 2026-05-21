/**
 * Artifact promotion classifier (Phase E).
 *
 * Decides whether a confirmed file mutation is a *deliverable* the operator
 * cares about (→ Artifacts tab) or a *scratch* working-file write
 * (→ "Working files" subsection inside the producing agent's lane).
 *
 * Locked glob rules (per the plan — do NOT widen without operator sign-off):
 *
 *   Promote when relative-to-cwd path matches ANY of:
 *     - directories (recursive): artifacts, deliverables, plans, docs/plans,
 *       reviews, reports, specs, decisions, adr, rfcs, summaries, notes
 *     - canonical filenames (any depth): PLAN*.md, REVIEW*.md, REPORT*.md,
 *       SPEC*.md, SUMMARY*.md, DECISIONS*.md, TODO*.md, NOTES*.md,
 *       ADR-*.md, RFC-*.md, ONBOARDING.md, HANDOFF.md
 *
 *   Override-exclude (regardless of includes):
 *     - directories: node_modules, .git, dist, build, coverage, .cebab,
 *       .cebab-session-*, .cebab-scratch, iterations, fixtures
 *     - filename suffixes: *.lock, package-lock.json, .DS_Store
 *
 *   Operator-locked exclusions (repo-root only):
 *     - plain *.md at the root, CLAUDE.md, README.md
 *
 * Under-promotion is recoverable via explicit `mark_artifact`; over-promotion
 * buries real deliverables. When in doubt, prefer `scratch`.
 *
 * Pure: no I/O, no globals — same input → same output. Browser-safe.
 */

export type ArtifactKind = 'promoted' | 'scratch' | 'excluded';

/**
 * Classify a confirmed mutation. `filePath` is the absolute or
 * cwd-relative path the tool targeted; `cwd` is the agent's working
 * directory at mutation time. Returns:
 *   - `promoted` — passes promotion globs and isn't excluded.
 *   - `scratch`  — confirmed but doesn't match any promote pattern;
 *                  appears in the "Working files" subsection.
 *   - `excluded` — matched a hard exclude (node_modules, .git, lock
 *                  files, etc.); doesn't appear in either surface.
 */
export function classifyArtifact(filePath: string, cwd: string | null): ArtifactKind {
  const rel = relativize(filePath, cwd);
  if (rel === null) {
    // Outside the agent's cwd (e.g. an absolute path to /tmp). Treat as
    // scratch — visible inside the agent's lane but never auto-promoted.
    return 'scratch';
  }

  // Hard excludes always win over includes.
  if (isExcluded(rel)) return 'excluded';

  // Repo-root-only operator-locked exclusions.
  if (isRootLockedExclusion(rel)) return 'excluded';

  if (matchesPromoteDirectory(rel) || matchesCanonicalFilename(rel)) {
    return 'promoted';
  }
  return 'scratch';
}

/**
 * Resolve `filePath` to a forward-slash, cwd-relative path. Returns:
 *   - the relative path when `filePath` is inside `cwd`, or already
 *     relative (no leading `/`);
 *   - the path as-is for absolute paths when `cwd` is null;
 *   - `null` when `filePath` is absolute and points OUTSIDE `cwd`.
 */
function relativize(filePath: string, cwd: string | null): string | null {
  const fp = filePath.replace(/\\/g, '/');
  if (!fp.startsWith('/') && !/^[a-zA-Z]:\//.test(fp)) {
    // Already relative; just strip a leading "./" if present.
    return fp.replace(/^\.\//, '');
  }
  if (!cwd) return fp;
  // Normalize separators, then strip trailing `/` runs with a loop rather
  // than `/\/+$/` — that regex is polynomial-backtracking under CodeQL
  // (`js/polynomial-redos`) on inputs like `/a///` and `cwd` is library
  // input we don't control.
  let norm = cwd.replace(/\\/g, '/');
  while (norm.length > 0 && norm.charCodeAt(norm.length - 1) === 0x2f /* '/' */) {
    norm = norm.slice(0, -1);
  }
  if (fp === norm) return '';
  const prefix = `${norm}/`;
  if (fp.startsWith(prefix)) return fp.slice(prefix.length);
  return null;
}

/** First-segment-or-anywhere directory match (recursive glob). */
const PROMOTE_DIRS: ReadonlySet<string> = new Set([
  'artifacts',
  'deliverables',
  'plans',
  'reviews',
  'reports',
  'specs',
  'decisions',
  'adr',
  'rfcs',
  'summaries',
  'notes',
]);

/** Multi-segment promote dirs that must match exactly as a path prefix. */
const PROMOTE_PATH_PREFIXES: readonly string[] = ['docs/plans/'];

/** Hard-exclude directory names — anywhere in the path. */
const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cebab',
  '.cebab-scratch',
  'iterations',
  'fixtures',
]);

/** Canonical promote filename patterns (any depth). */
const PROMOTE_FILENAME_REGEXES: readonly RegExp[] = [
  /^PLAN.*\.md$/i,
  /^REVIEW.*\.md$/i,
  /^REPORT.*\.md$/i,
  /^SPEC.*\.md$/i,
  /^SUMMARY.*\.md$/i,
  /^DECISIONS.*\.md$/i,
  /^TODO.*\.md$/i,
  /^NOTES.*\.md$/i,
  /^ADR-.*\.md$/i,
  /^RFC-.*\.md$/i,
  /^ONBOARDING\.md$/i,
  /^HANDOFF\.md$/i,
];

function segments(rel: string): string[] {
  return rel.split('/').filter(Boolean);
}

function matchesPromoteDirectory(rel: string): boolean {
  const segs = segments(rel);
  if (segs.length === 0) return false;
  // Top-level directory match.
  if (PROMOTE_DIRS.has(segs[0]!)) return true;
  // Multi-segment prefix (e.g. docs/plans/).
  for (const p of PROMOTE_PATH_PREFIXES) {
    if (rel.startsWith(p)) return true;
  }
  return false;
}

function matchesCanonicalFilename(rel: string): boolean {
  const segs = segments(rel);
  if (segs.length === 0) return false;
  const filename = segs[segs.length - 1]!;
  return PROMOTE_FILENAME_REGEXES.some((re) => re.test(filename));
}

function isExcluded(rel: string): boolean {
  const segs = segments(rel);
  if (segs.length === 0) return false;
  const filename = segs[segs.length - 1]!;
  if (filename === '.DS_Store') return true;
  if (filename === 'package-lock.json') return true;
  if (filename.endsWith('.lock')) return true;
  // Glob-style: .cebab-session-* matches any directory segment starting with
  // the literal prefix (`.cebab-session-`).
  if (segs.some((s) => s.startsWith('.cebab-session-'))) return true;
  return segs.some((s) => EXCLUDE_DIRS.has(s));
}

function isRootLockedExclusion(rel: string): boolean {
  const segs = segments(rel);
  if (segs.length !== 1) return false; // root-only
  const filename = segs[0]!;
  if (filename === 'CLAUDE.md' || filename === 'README.md') return true;
  // Plain *.md at repo root — but NOT the canonical promotions
  // (PLAN*.md etc.), which are handled by `matchesCanonicalFilename`.
  if (filename.endsWith('.md') && !PROMOTE_FILENAME_REGEXES.some((re) => re.test(filename))) {
    return true;
  }
  return false;
}
