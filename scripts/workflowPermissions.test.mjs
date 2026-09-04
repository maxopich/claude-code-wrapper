/**
 * Workflow token scope and supply-chain pinning — `Cebab-5nv`.
 *
 * WHY A TEST AND NOT THE ALERT. OpenSSF Scorecard found all of this first, and
 * its findings **annotate; they do not gate** — nothing in CI failed on them
 * and nothing surfaced them unless somebody ran
 * `gh api repos/:owner/:repo/code-scanning/alerts`. That is how seven of them
 * sat open from May to August unnoticed. An alert can also simply be dismissed,
 * which changes the alert and not the config: the two `TokenPermissionsID`
 * findings this file's rules cover were dismissed on 2026-08-15 while both
 * workflows still had the flagged scopes. A test cannot be dismissed.
 *
 * AND SCORECARD NO LONGER RUNS HERE AT ALL — `scorecard.yml` was dropped with
 * the repo-workflow automation in #520. So this file is not a redundant second
 * opinion any more; it is the only thing checking workflow token scope and
 * action pinning. The argument above is why that is survivable rather than
 * alarming: the scanner was never the control, because nothing gated on it.
 *
 * THE RULES, each measured against the tree before being written:
 *
 *   1. Every workflow declares top-level `permissions: {}` — deny by default,
 *      jobs opt in. Was 8 of 10.
 *   2. Every job declares its own `permissions:` block. Was 11 of 12.
 *   3. Every `uses:` pins a 40-hex commit SHA. Was already 10 of 10 — a
 *      ratchet, not a repair.
 *   4. Every `raw.githubusercontent.com` URL carries a 40-hex SHA. Was 0 of 1.
 *
 * RULES 1 AND 2 ARE A PAIR, AND THE PAIRING IS THE POINT. Rule 1 alone is a
 * footgun: an empty top-level block STARVES any job that never declared its
 * own needs. I would have shipped rule 1 by itself — the per-job measurement is
 * what stopped that, by turning up exactly one such job
 * (`dependabot-auto-merge.yml`'s `auto-merge`, which was living on the
 * top-level grant). Rule 2 is what makes rule 1 safe to enforce, so a
 * revert-check case pins that rule 1 alone would pass on a `codeql.yml` with
 * BOTH blocks removed.
 *
 * WHY RULE 4 IS SO NARROW. It covers one line, and that is honest: the repo
 * pins every `uses:`, so the only unpinned dependency left was a `curl | bash`
 * of an installer script from a mutable tag. A broader "no unpinned network
 * fetch" rule would need to model shell, and would over-fire on every `npm ci`.
 * `raw.githubusercontent.com` is the shape that actually occurred.
 *
 * WHAT IT DOES NOT COVER, stated rather than left implicit:
 *   - The release BINARY that pinned installer script downloads. Rule 4 removes
 *     the mutable-ref hop, not the whole chain.
 *   - Whether a job's declared scopes are MINIMAL. Rule 2 requires a block, not
 *     a small one; `permissions: write-all` on a job would pass. Scorecard
 *     judges that and a text scan cannot.
 *   - Reusable workflows called via `uses:` at job level, of which this repo
 *     has none today.
 *
 * PARSING is line-oriented by indentation, not a YAML library: `js-yaml` is an
 * unhoisted transitive here and would break on a clean `npm ci`, which is the
 * same constraint every other gate in `scripts/` works under.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = '.github/workflows';

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a scan should not assume its
 * input: a contributor with a global `core.autocrlf=true` reads `\r` at every
 * line end, and this repo has lost CI round-trips to that
 * (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ===========================================================================
// 1. The checkers. Each takes a {file: content} map, never a path.
// ===========================================================================

const SHA = /^[0-9a-f]{40}$/;

/** The top-level `permissions:` value, or null when there is no such key.
 *
 * Column 0 is what makes it top-level — a job's block is indented four spaces
 * and an indented match would make the rule pass on the wrong thing. */
function topLevelPermissions(src) {
  const m = src.match(/^permissions:(.*)$/m);
  if (!m) return null;
  return m[1].trim();
}

/** Job names in a workflow, paired with whether each declares `permissions:`. */
function jobs(src) {
  const at = src.indexOf('\njobs:');
  if (at === -1) return [];
  const body = src.slice(at);
  const names = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return names.map((m, i) => {
    const start = m.index;
    const end = i + 1 < names.length ? names[i + 1].index : body.length;
    const block = body.slice(start, end);
    return { name: m[1], hasPermissions: /^ {4}permissions:/m.test(block) };
  });
}

/**
 * Every `uses:` ref in a workflow, as `{ action, ref }`.
 *
 * The whole token is captured once and split on its LAST `@`, rather than
 * matched as `(\S+)@(\S+)`. Two adjacent unbounded classes around a literal
 * are what `security/detect-unsafe-regex` rejects — they can trade characters
 * across the `@` on a non-matching line. Splitting is linear, and the last `@`
 * is also the correct boundary for a scoped name that contains one.
 */
function actionRefs(src) {
  const out = [];
  for (const raw of src.split('\n')) {
    // Trim first, so the pattern needs no leading `\s*` beside the optional
    // `- ` — `\s*` adjacent to `\s+` is the other shape the rule rejects.
    const line = raw.trim().replace(/^-\s+/, '');
    if (!line.startsWith('uses:')) continue;
    const token = line.slice('uses:'.length).trim().split(' ')[0];
    if (!token) continue;
    const at = token.lastIndexOf('@');
    // No `@` at all means an unpinned local/reusable path — report it with an
    // empty ref so rule 3 flags it rather than skipping it silently.
    out.push({
      action: at === -1 ? token : token.slice(0, at),
      ref: at === -1 ? '' : token.slice(at + 1),
    });
  }
  return out;
}

/**
 * Every `raw.githubusercontent.com` ref in a workflow — the `<ref>` in
 * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`.
 *
 * Split rather than matched. The natural pattern
 * (`\/[^/\s]+\/[^/\s]+\/([^/\s]+)\/`) chains three adjacent unbounded
 * character classes, which `security/detect-unsafe-regex` rejects as
 * backtracking-prone — correctly, since they can trade characters on a
 * non-matching input. Splitting is linear and needs no exemption.
 */
const RAW_HOST = 'raw.githubusercontent.com/';
function rawGithubRefs(src) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(RAW_HOST, from);
    if (at === -1) return out;
    from = at + RAW_HOST.length;
    // owner / repo / ref — stop at whitespace so a truncated URL yields
    // nothing rather than swallowing the rest of the line.
    const rest = src.slice(from).split(/\s/, 1)[0];
    const parts = rest.split('/');
    if (parts.length >= 3) out.push(parts[2]);
  }
}

/** `{file, …}` for every workflow breaking one of the four rules. */
function violations(sources) {
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    const top = topLevelPermissions(src);
    if (top === null) out.push({ file, rule: 'top-level-permissions', detail: 'no block' });
    else if (top !== '{}') out.push({ file, rule: 'top-level-permissions', detail: top });

    for (const j of jobs(src)) {
      if (!j.hasPermissions) out.push({ file, rule: 'job-permissions', detail: j.name });
    }
    for (const { action, ref } of actionRefs(src)) {
      if (!SHA.test(ref)) out.push({ file, rule: 'unpinned-action', detail: `${action}@${ref}` });
    }
    for (const ref of rawGithubRefs(src)) {
      if (!SHA.test(ref)) out.push({ file, rule: 'unpinned-raw-fetch', detail: ref });
    }
  }
  return out.sort((a, b) =>
    `${a.file}${a.rule}${a.detail}` < `${b.file}${b.rule}${b.detail}` ? -1 : 1,
  );
}

// ===========================================================================
// 2. Anti-vacuity: prove each rule fires, independent of the tree.
// ===========================================================================

describe('the workflow checker catches what it is for', () => {
  test('rule 1: flags codeql.yml verbatim as it was before this fix', () => {
    // `git show ca33847:.github/workflows/codeql.yml`, trimmed to the shape.
    const src = [
      'name: CodeQL',
      'on:',
      '  push:',
      '    branches: [main]',
      '',
      'jobs:',
      '  analyze:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      security-events: write',
    ].join('\n');
    expect(violations({ 'codeql.yml': src })).toEqual([
      { file: 'codeql.yml', rule: 'top-level-permissions', detail: 'no block' },
    ]);
  });

  test('rule 1: flags a NON-EMPTY top-level block, not just a missing one', () => {
    // dependabot-auto-merge.yml's exact pre-fix shape. A checker testing only
    // for presence would have passed this file — the whole finding there was
    // that the block existed and granted writes.
    const src = [
      'on: pull_request_target',
      '',
      'permissions:',
      '  contents: write',
      '  pull-requests: write',
      '',
      'jobs:',
      '  auto-merge:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: write',
    ].join('\n');
    expect(violations({ 'd.yml': src })).toEqual([
      { file: 'd.yml', rule: 'top-level-permissions', detail: '' },
    ]);
  });

  test('rule 2: flags a job with no permissions block', () => {
    const src = [
      'permissions: {}',
      '',
      'jobs:',
      '  auto-merge:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    expect(violations({ 'd.yml': src })).toEqual([
      { file: 'd.yml', rule: 'job-permissions', detail: 'auto-merge' },
    ]);
  });

  test('rule 2: finds EVERY job, not only the first', () => {
    // `pr-label.yml` and `workflow-lint.yml` have two jobs each; `ci.yml` has
    // three (`checks`, `tests`, and the `required` aggregator added later). A
    // matcher that stopped after the first would silently halve the corpus.
    const src = [
      'permissions: {}',
      '',
      'jobs:',
      '  first:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '  second:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    expect(jobs(src).map((j) => j.name)).toEqual(['first', 'second']);
    expect(violations({ 'a.yml': src })).toEqual([
      { file: 'a.yml', rule: 'job-permissions', detail: 'second' },
    ]);
  });

  test('rule 3: flags a tag-pinned action, accepts a SHA-pinned one', () => {
    const bad = { 'a.yml': '      - uses: actions/checkout@v4' };
    expect(violations(bad).map((v) => v.rule)).toContain('unpinned-action');
    const good = {
      'a.yml': [
        'permissions: {}',
        'jobs:',
        '  j:',
        '    permissions:',
        '      contents: read',
        '    steps:',
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      ].join('\n'),
    };
    expect(violations(good)).toEqual([]);
  });

  test('rule 4: flags the verbatim pre-fix actionlint fetch', () => {
    const src =
      '          bash <(curl -sSf \\\n' +
      '            https://raw.githubusercontent.com/rhysd/actionlint/v1.7.12/scripts/download-actionlint.bash) 1.7.12';
    expect(violations({ 'w.yml': src }).filter((v) => v.rule === 'unpinned-raw-fetch')).toEqual([
      { file: 'w.yml', rule: 'unpinned-raw-fetch', detail: 'v1.7.12' },
    ]);
  });

  test('rule 4: accepts the SHA-pinned form this fix ships', () => {
    const src =
      '            https://raw.githubusercontent.com/rhysd/actionlint/914e7df21a07ef503a81201c76d2b11c789d3fca/scripts/download-actionlint.bash) 1.7.12';
    expect(violations({ 'w.yml': src }).filter((v) => v.rule === 'unpinned-raw-fetch')).toEqual([]);
  });

  test('an INDENTED permissions key is not the top-level one', () => {
    // The job's own block sits at four spaces. If `^permissions:` lost its
    // column-0 anchor, every workflow would "have" a top-level block and rule
    // 1 would pass on all of them — including the two this fix repairs.
    const src = ['jobs:', '  j:', '    permissions:', '      contents: read'].join('\n');
    expect(topLevelPermissions(src)).toBeNull();
  });

  test('a fully conforming workflow produces nothing', () => {
    // Over-fire control. Without it, a checker that flagged everything would
    // satisfy every positive case above.
    const src = [
      'name: Fine',
      'on: push',
      'permissions: {}',
      '',
      'jobs:',
      '  only:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '    steps:',
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    ].join('\n');
    expect(violations({ 'fine.yml': src })).toEqual([]);
  });
});

// ===========================================================================
// 3. The scan.
// ===========================================================================

describe('every workflow denies by default and pins what it fetches', () => {
  const sources = collectWorkflows();

  test('the scan reaches the workflow directory', () => {
    // A glob matching nothing looks exactly like a clean tree.
    const files = Object.keys(sources);
    // 8 today, down from 10 when `scorecard.yml` and `dependabot-auto-merge.yml`
    // left with the repo-workflow automation. The floor moves WITH the set on
    // purpose: a floor kept comfortably below the real count stops being able
    // to notice the next removal, which is the whole job of this case.
    expect(files.length).toBeGreaterThan(6);
    for (const f of ['ci.yml', 'codeql.yml', 'semgrep.yml', 'workflow-lint.yml']) {
      expect(files, `${f} is not in the scanned set`).toContain(f);
    }
  });

  test('the corpus is the jobs and actions, not an empty set', () => {
    // 12 jobs / 10+ action refs today. Floors well below catch a matcher that
    // stopped matching, which would make the scan below pass on nothing.
    const allJobs = Object.values(sources).flatMap((s) => jobs(s));
    const allUses = Object.values(sources).flatMap((s) => actionRefs(s));
    expect(allJobs.length).toBeGreaterThan(8);
    expect(allUses.length).toBeGreaterThan(8);
  });

  test('exactly one raw.githubusercontent fetch is in the corpus', () => {
    // Rule 4 covers one line. If that line moves or is deleted, this fails
    // rather than the rule quietly becoming unable to fire
    // (`project_semgrep_rule_liveness`: a rule with no target stays green).
    const refs = Object.values(sources).flatMap((s) => rawGithubRefs(s));
    expect(refs.length).toBe(1);
  });

  test('no workflow violates any of the four rules', () => {
    expect(
      violations(sources),
      'A workflow breaks one of: top-level `permissions: {}` (deny by ' +
        'default), a per-job `permissions:` block (so the empty top level ' +
        'starves nothing), a SHA-pinned `uses:`, or a SHA-pinned ' +
        'raw.githubusercontent fetch. OpenSSF Scorecard flags all four, but ' +
        'its alerts annotate rather than gate and can be dismissed without ' +
        'changing the config — which is why this is a test. See ' +
        '.github/workflows/codeql.yml for the top-level form (Cebab-5nv).',
    ).toEqual([]);
  });
});

function collectWorkflows() {
  const dir = path.join(repoRoot, WORKFLOW_DIR);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.yml') || name.endsWith('.yaml'))
      out[name] = read(`${WORKFLOW_DIR}/${name}`);
  }
  return out;
}

// ── ci.yml's two matrix jobs must install dependencies identically ─────────
//
// `checks` and `tests` are two jobs ONLY because of a wall-clock budget
// (Cebab-zyu), so any difference in how they install dependencies would make a
// red on one of them mean something different from a red on the other.
//
// The obvious fix is a local composite action, and rule 3 above forbids it:
// every `uses:` must be SHA-pinned, and GitHub has no syntax that pins a `./`
// local action. Weakening a supply-chain rule to tidy a workflow is the wrong
// trade, so the steps are duplicated and pinned HERE instead — which is the
// stronger guarantee, because drift fails loudly rather than the two jobs
// silently agreeing on whatever the shared copy happens to say.
describe('ci_setup_steps_match', () => {
  const src = fs.readFileSync(path.join(repoRoot, WORKFLOW_DIR, 'ci.yml'), 'utf8');
  const blocks = [
    ...src.matchAll(/ {6}- name: Setup Node\.js\n[\s\S]*?--ignore-scripts=false\n/g),
  ].map((m) => m[0]);

  test('exactly two setup blocks, byte-identical, and non-empty', () => {
    // THE FLOOR IS NOT DECORATION. A regex that stopped matching would yield
    // two empty strings, which are equal — the comparison alone would pass on
    // nothing at all.
    //
    // Measured 2026-09-04: 2624 chars per block, not the ~1.1k this comment
    // claimed. The blocks grew when #523 added the native-binary verification
    // and its reasoning, and a floor left at 600 would no longer notice a block
    // cut to a fifth of itself. A floor that drifts this far below its subject
    // has stopped being a floor, so it moves with the measurement.
    expect(blocks.length).toBe(2);
    expect(blocks[0].length).toBeGreaterThan(2000);
    expect(blocks[1]).toBe(blocks[0]);
  });

  test('both blocks actually carry the three steps they claim to', () => {
    // Names the content, so shortening a block to a stub cannot satisfy the
    // length floor above by padding a comment.
    for (const b of blocks) {
      expect(b).toContain('actions/setup-node@');
      expect(b).toContain('npm ci --ignore-scripts');
      expect(b).toContain('npm rebuild better-sqlite3');
    }
  });
});

describe('the strict workflow audit runs where someone will see it (Cebab-tbpb)', () => {
  // WHAT WENT WRONG. `workflow-lint.yml` ran zizmor's default persona on
  // PR/push and its stricter `auditor` persona ONLY on the weekly cron. The
  // auditor run failed on 2026-08-17, 2026-08-24 and 2026-08-31 and nobody saw
  // it: a `schedule` event has no PR to redden, and this workflow is not one
  // of the seven required contexts on `main`. Three weeks of a red gate that
  // reached no one.
  //
  // The split was justified as "too noisy as a required PR check" — a claim
  // about the tree, which then carried 14 findings. It carries zero now, so the
  // persona runs on every event and the cron is a backstop rather than the only
  // signal.

  const src = read('.github/workflows/workflow-lint.yml');

  test('the auditor persona is not gated on the event that hides it', () => {
    // The exact shape that produced the three-week blind spot.
    expect(src).not.toMatch(/if:\s*github\.event_name\s*==\s*'schedule'/);
  });

  test('the auditor persona is actually the one that runs', () => {
    // Without this the assertion above passes for a workflow that dropped the
    // auditor persona altogether — which would also make the cron green, and
    // for the worse reason.
    expect(src).toContain('--persona auditor');
    const steps = src.split('--persona auditor').length - 1;
    expect(steps, 'exactly one auditor invocation').toBe(1);
  });

  test('zizmor stays pinned to an exact version', () => {
    // The reason a strict audit is safe to run on every PR: a new audit cannot
    // arrive on its own and redden an unrelated change. It arrives only with a
    // deliberate bump, in front of whoever makes it. `pipx install zizmor==X`,
    // never `>=` and never bare.
    expect(src).toMatch(/pipx install zizmor==\d+\.\d+\.\d+/);
    expect(src).not.toMatch(/pipx install zizmor(\s|$|[^=])/);
  });
});
