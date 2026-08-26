/**
 * Autonomous loop — the guard over a candidate diff.
 *
 * PURE. Takes already-parsed git output and the guard config, returns every
 * breach it found. `loop.mjs` decides what a breach means; §8.2 says it never
 * blocks the work — the PR is still opened and labelled `loop-guard`, and only
 * LAND is suppressed. The maintainer decides in the morning.
 *
 * EVERY BREACH IS REPORTED, NOT THE FIRST. The list goes in the PR body, and a
 * diff that trips three rules should say so — fixing them one run at a time is
 * exactly the overnight round-trip this loop exists to avoid.
 *
 * NO RegExp ANYWHERE, DELIBERATELY. `security/detect-non-literal-regexp` and
 * `security/detect-unsafe-regex` are both live in this repo's eslint config
 * (only `detect-object-injection` and `detect-non-literal-fs-filename` are
 * turned off), and glob patterns arrive from a config FILE — the exact
 * non-literal source the first rule exists for. A linear segment matcher needs
 * no exemption, which is the better end state than earning one.
 */

/**
 * Wildcard match WITHIN one path segment: `*` (any run of characters) and `?`
 * (exactly one). Iterative with backtracking, so no catastrophic behaviour on
 * a pattern like `*a*a*a*` — the shape `detect-unsafe-regex` would reject.
 */
function segmentMatch(pattern, str) {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < str.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === str[s])) {
      p += 1;
      s += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = s;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function matchSegments(patternSegs, pathSegs, pi, si) {
  let p = pi;
  let s = si;
  while (p < patternSegs.length) {
    if (patternSegs[p] === '**') {
      // `**` spans zero or more whole segments, so `.github/**` covers
      // `.github/workflows/ci.yml` at any depth.
      for (let k = s; k <= pathSegs.length; k += 1) {
        if (matchSegments(patternSegs, pathSegs, p + 1, k)) return true;
      }
      return false;
    }
    if (s >= pathSegs.length) return false;
    if (!segmentMatch(patternSegs[p], pathSegs[s])) return false;
    p += 1;
    s += 1;
  }
  return s === pathSegs.length;
}

/**
 * Glob match against a repo-relative path. A pattern with no `/` matches only
 * a root-level file — `package-lock.json` does NOT match `web/package-lock.json`,
 * the same semantics minimatch gives. Write `**\/name` when you mean any depth.
 */
export function matchesGlob(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  return matchSegments(pattern.split('/'), path.split('/'), 0, 0);
}

const isTestPath = (path) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.includes('.test.') || base.includes('_test.');
};

const countOccurrences = (lines, needle) =>
  lines.reduce((total, line) => {
    let n = 0;
    let from = 0;
    for (;;) {
      const at = line.indexOf(needle, from);
      if (at === -1) break;
      n += 1;
      from = at + needle.length;
    }
    return total + n;
  }, 0);

const SECURITY_TAG = '[security]';

/**
 * @param {{files: Array<{path:string,insertions:number,deletions:number,status?:string}>,
 *          addedLines?: string[], removedLines?: string[]}} diff
 * @param {object} guard  the `guard` block of the resolved config
 * @returns {{passed: boolean, breaches: Array<{rule: string, detail: string}>}}
 */
export function evaluateGuard(diff, guard) {
  const files = diff.files ?? [];
  const addedLines = diff.addedLines ?? [];
  const removedLines = diff.removedLines ?? [];
  const breaches = [];

  for (const file of files) {
    const hit = (guard.denyPaths ?? []).find((pattern) => matchesGlob(pattern, file.path));
    if (hit) breaches.push({ rule: 'denyPaths', detail: `${file.path} matches ${hit}` });
  }

  if (typeof guard.maxFilesChanged === 'number' && files.length > guard.maxFilesChanged) {
    breaches.push({
      rule: 'maxFilesChanged',
      detail: `${files.length} files changed, limit ${guard.maxFilesChanged}`,
    });
  }

  const net = files.reduce((sum, f) => sum + (f.insertions ?? 0) - (f.deletions ?? 0), 0);
  if (typeof guard.maxNetLinesAdded === 'number' && net > guard.maxNetLinesAdded) {
    breaches.push({
      rule: 'maxNetLinesAdded',
      detail: `net +${net} lines, limit ${guard.maxNetLinesAdded}`,
    });
  }

  if (guard.allowTestDeletions === false) {
    for (const file of files) {
      if (file.status === 'D' && isTestPath(file.path)) {
        breaches.push({ rule: 'allowTestDeletions', detail: `deleted test file ${file.path}` });
      }
    }
    // A `[security]` tag removal is counted, not pattern-matched: `test:security`
    // selects by test NAME (`-t '[security]'`), so a tag that disappears silently
    // drops a case from the security gate while every other gate stays green.
    // Counting means a rename that keeps its tag nets to zero and does not fire.
    const removedTags = countOccurrences(removedLines, SECURITY_TAG);
    const addedTags = countOccurrences(addedLines, SECURITY_TAG);
    if (removedTags > addedTags) {
      breaches.push({
        rule: 'allowTestDeletions',
        detail: `${removedTags - addedTags} [security] tag(s) removed`,
      });
    }
  }

  for (const needle of guard.forbidInDiff ?? []) {
    const line = addedLines.find((l) => l.includes(needle));
    if (line !== undefined) {
      breaches.push({ rule: 'forbidInDiff', detail: `added line contains ${needle}` });
    }
  }

  return { passed: breaches.length === 0, breaches };
}

/**
 * `git diff --numstat` + `git diff --name-status` into the shape above.
 *
 * Binary files report `-` for both counts; they become 0 rather than NaN,
 * which would otherwise poison the net-lines sum into never tripping its cap.
 */
export function parseDiffStat(numstatText = '', nameStatusText = '') {
  const status = new Map();
  for (const line of nameStatusText.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    // Renames are `R100\told\tnew` — the post-image is the last field.
    status.set(parts[parts.length - 1], parts[0][0]);
  }

  const files = [];
  for (const line of numstatText.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const path = parts[parts.length - 1];
    const insertions = parts[0] === '-' ? 0 : Number(parts[0]);
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]);
    files.push({
      path,
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      status: status.get(path) ?? 'M',
    });
  }
  return files;
}

/** Added/removed content lines from a unified diff, excluding the `+++`/`---` headers. */
export function parseDiffLines(diffText = '') {
  const addedLines = [];
  const removedLines = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines.push(line.slice(1));
    else if (line.startsWith('-')) removedLines.push(line.slice(1));
  }
  return { addedLines, removedLines };
}
