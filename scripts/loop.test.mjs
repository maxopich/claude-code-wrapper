/**
 * Autonomous loop — unit tests for the pure core (Cebab-qd2.1).
 *
 * Everything under test here is I/O-free: `config`, `machine`, `guard`,
 * `select` and `ledger` take plain objects and return plain objects. No repo,
 * no network, no model, no clock — `parseUntil` and `buildRecord` take `now`
 * as an argument precisely so the overnight paths (stop at 07:00, reserve 45
 * minutes before a deadline) are testable without sleeping through them.
 *
 * WHAT EACH CASE MUST REDDEN. Per `project_revert_check_harness`, a case that
 * cannot name the mutation it catches is decoration. The four that matter most,
 * and the revert that must turn each red:
 *
 *   - drop `--exclude-label` from `readyArgv`      -> "argv carries the exclusions"
 *   - make `evaluateGuard` return on first breach  -> "reports every breach at once"
 *   - let `resolveConfig` accept an unknown key    -> "unknown key is refused by name"
 *   - make `buildRecord` require a complete parts  -> "builds a valid record from nothing"
 *
 * Predicates are tested in BOTH directions. A deny glob that matches
 * everything and one that matches nothing are different bugs, and a case that
 * only asserts the positive half catches just one of them.
 *
 * ONE DELIBERATE ABSENCE, and it is the point of the whole select.mjs header:
 * there is NO case here feeding `chooseBead` a bead with a `labels` array.
 * Measured — no bd JSON output carries that field, so such a fixture describes
 * an object bd cannot produce, and a test built on it would pass while the
 * real path stayed broken. Label exclusion is asserted where it actually
 * lives: in the `bd ready` argv.
 */
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  ConfigError,
  DEFAULTS,
  firstTripped,
  parseUntil,
  reserveBlocks,
  resolveConfig,
  untilTripped,
} from './lib/loop/config.mjs';
import {
  DISPOSITION,
  REASON,
  STAGE,
  STAGE_ORDER,
  countsTowardBreaker,
  next,
  resetsBreaker,
} from './lib/loop/machine.mjs';
import { evaluateGuard, matchesGlob, parseDiffLines, parseDiffStat } from './lib/loop/guard.mjs';
import {
  chooseBead,
  denyPathStems,
  readyArgv,
  readyArgvConformsToConfig,
} from './lib/loop/select.mjs';
import {
  appendRecord,
  buildRecord,
  compareVerdictToGate,
  validateRecord,
} from './lib/loop/ledger.mjs';

const GUARD = DEFAULTS.guard;

// ─── config ────────────────────────────────────────────────────────────────

describe('config: layering and unknown keys', () => {
  test('CLI overrides file overrides defaults', () => {
    const merged = resolveConfig({
      file: { loop: { maxRepairs: 5 }, guard: { maxFilesChanged: 10 } },
      cli: { loop: { maxRepairs: 9 } },
    });
    expect(merged.loop.maxRepairs).toBe(9); // CLI wins over file
    expect(merged.guard.maxFilesChanged).toBe(10); // file wins over default
    expect(merged.ci.requiredContext).toBe('Lint, Typecheck, Test'); // default survives
  });

  test('unknown key is refused BY NAME, not silently dropped', () => {
    // The mutation this must catch: `mergeLayer` ignoring keys absent from
    // DEFAULTS. A typo'd `denyPath` would then contribute nothing and the
    // guard would pass everything it was configured to stop.
    expect(() => resolveConfig({ file: { guard: { denyPath: ['x'] } } })).toThrow(ConfigError);
    try {
      resolveConfig({ file: { guard: { denyPath: ['x'] } } });
    } catch (error) {
      expect(error.message).toContain('guard.denyPath');
    }
  });

  test('every unknown key is listed, not just the first', () => {
    try {
      resolveConfig({ file: { nope: 1, guard: { alsoNope: 2 } } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toContain('nope');
      expect(error.message).toContain('guard.alsoNope');
    }
  });

  test('a known key with a falsy value is accepted, not mistaken for absent', () => {
    const merged = resolveConfig({ file: { loop: { merge: false }, limits: { reserveMs: 0 } } });
    expect(merged.loop.merge).toBe(false);
    expect(merged.limits.reserveMs).toBe(0);
  });

  test('arrays are replaced wholesale, never concatenated', () => {
    const merged = resolveConfig({ file: { guard: { denyPaths: ['only-this'] } } });
    expect(merged.guard.denyPaths).toEqual(['only-this']);
  });

  test('defaults ship every budget limit OFF and merging disabled', () => {
    expect(DEFAULTS.limits.costCeilingUsd).toBeNull();
    expect(DEFAULTS.limits.beadCostCeilingUsd).toBeNull();
    expect(DEFAULTS.limits.cooldownMsBetweenBeads).toBe(0);
    expect(DEFAULTS.build.tiers).toEqual([]);
    expect(DEFAULTS.loop.merge).toBe(false);
  });
});

describe('config: --until has four forms and no silent fallback', () => {
  const NOW = new Date(2026, 7, 25, 23, 0, 0).getTime(); // 25 Aug 2026, 23:00 local

  test('count form', () => {
    expect(parseUntil('8', NOW)).toMatchObject({ kind: 'count', count: 8 });
  });

  test('clock form resolves to the NEXT occurrence, tomorrow when already past', () => {
    const morning = parseUntil('07:00', NOW); // 07:00 is past relative to 23:00
    expect(morning.kind).toBe('deadline');
    expect(new Date(morning.at).getDate()).toBe(26);
    expect(new Date(morning.at).getHours()).toBe(7);

    const later = parseUntil('23:30', NOW); // still ahead today
    expect(new Date(later.at).getDate()).toBe(25);
  });

  test('duration forms', () => {
    expect(parseUntil('2h', NOW).at).toBe(NOW + 7200000);
    expect(parseUntil('90m', NOW).at).toBe(NOW + 5400000);
  });

  test('drain form', () => {
    expect(parseUntil('drain', NOW)).toMatchObject({ kind: 'drain' });
  });

  test('anything unrecognised throws instead of falling back to the default', () => {
    // A silent fallback to "1" is the failure the operator finds at 3am, by
    // way of a ledger with one row in it.
    for (const bad of ['8h30m', '', 'forever', '25:00', '07:99', 'drain2', '0']) {
      expect(() => parseUntil(bad, NOW), `--until ${bad}`).toThrow(ConfigError);
    }
  });

  test('first condition to trip wins, and is reported', () => {
    const conditions = [parseUntil('8', NOW), parseUntil('07:00', NOW)];
    // Eight iterations done, well before 07:00 -> the count tripped.
    expect(firstTripped(conditions, { iterations: 8, now: NOW, drained: false }).raw).toBe('8');
    // Two iterations done, but the clock has passed 07:00 -> the clock tripped.
    const past = conditions[1].at + 1000;
    expect(firstTripped(conditions, { iterations: 2, now: past, drained: false }).raw).toBe(
      '07:00',
    );
    // Neither.
    expect(firstTripped(conditions, { iterations: 2, now: NOW, drained: false })).toBeNull();
  });

  test('drain trips only when SELECT actually found nothing', () => {
    const drain = parseUntil('drain', NOW);
    expect(untilTripped(drain, { iterations: 9, now: NOW, drained: false })).toBe(false);
    expect(untilTripped(drain, { iterations: 0, now: NOW, drained: true })).toBe(true);
  });

  test('reserveMs blocks a deadline run, and is INERT for count and drain', () => {
    const deadline = parseUntil('30m', NOW); // 30 min out
    const reserve = 2700000; // 45 min
    expect(reserveBlocks([deadline], { now: NOW }, reserve)).toMatchObject({ raw: '30m' });

    const far = parseUntil('4h', NOW);
    expect(reserveBlocks([far], { now: NOW }, reserve)).toBeNull();

    // The inert half — a count or drain condition has no deadline to reserve
    // against, so no amount of reserve may stop the run. Reverting this to
    // "block whenever reserveMs is set" reddens here and nowhere else.
    expect(reserveBlocks([parseUntil('8', NOW)], { now: NOW }, reserve)).toBeNull();
    expect(reserveBlocks([parseUntil('drain', NOW)], { now: NOW }, reserve)).toBeNull();
  });
});

// ─── machine ───────────────────────────────────────────────────────────────

describe('machine: the happy path and every branch off it', () => {
  const ctx = { merge: true, attempt: 1, maxRepairs: 2, guardPassed: true };

  test('SELECT with no bead is a clean stop, not an iteration', () => {
    expect(next(STAGE.SELECT, { bead: null }, ctx)).toMatchObject({
      stage: STAGE.DONE,
      drained: true,
    });
    expect(next(STAGE.SELECT, { bead: null }, ctx).disposition).toBeUndefined();
  });

  test('SELECT -> CLAIM -> BUILD -> GATE -> PUBLISH -> WATCH -> LAND -> HARVEST', () => {
    expect(next(STAGE.SELECT, { bead: { id: 'X' } }, ctx).stage).toBe(STAGE.CLAIM);
    expect(next(STAGE.CLAIM, { ok: true }, ctx).stage).toBe(STAGE.BUILD);
    expect(next(STAGE.BUILD, { ok: true, verdict: { outcome: 'implemented' } }, ctx).stage).toBe(
      STAGE.GATE,
    );
    expect(next(STAGE.GATE, { passed: true }, ctx).stage).toBe(STAGE.PUBLISH);
    expect(next(STAGE.PUBLISH, { ok: true }, ctx).stage).toBe(STAGE.WATCH);
    expect(next(STAGE.WATCH, { outcome: 'green' }, ctx).stage).toBe(STAGE.LAND);
    expect(next(STAGE.LAND, { merged: true }, ctx)).toMatchObject({
      stage: STAGE.HARVEST,
      disposition: DISPOSITION.MERGED,
    });
    expect(next(STAGE.HARVEST, { disposition: DISPOSITION.MERGED }, ctx)).toMatchObject({
      stage: STAGE.DONE,
      disposition: DISPOSITION.MERGED,
    });
  });

  test('gate red re-enters BUILD as a repair, and parks once repairs are spent', () => {
    expect(next(STAGE.GATE, { passed: false }, { ...ctx, attempt: 1 })).toMatchObject({
      stage: STAGE.BUILD,
      repair: true,
    });
    expect(next(STAGE.GATE, { passed: false }, { ...ctx, attempt: 2 })).toMatchObject({
      stage: STAGE.BUILD,
      repair: true,
    });
    expect(next(STAGE.GATE, { passed: false }, { ...ctx, attempt: 3 })).toMatchObject({
      stage: STAGE.HARVEST,
      disposition: DISPOSITION.PARKED,
      reason: REASON.GATE_FAILED,
    });
  });

  test('CI red repairs then parks; CI absent parks immediately', () => {
    expect(next(STAGE.WATCH, { outcome: 'red' }, { ...ctx, attempt: 1 }).stage).toBe(STAGE.BUILD);
    expect(next(STAGE.WATCH, { outcome: 'red' }, { ...ctx, attempt: 3 })).toMatchObject({
      disposition: DISPOSITION.PARKED,
      reason: REASON.CI_RED,
    });
    // Absent is NOT retried: no check by that name ever appeared, which is a
    // repo or runner problem, and a rebuild cannot fix it.
    expect(next(STAGE.WATCH, { outcome: 'absent' }, ctx)).toMatchObject({
      stage: STAGE.HARVEST,
      disposition: DISPOSITION.PARKED,
      reason: REASON.CI_NEVER_STARTED,
    });
  });

  test('a guard breach opens the PR but skips LAND', () => {
    const breached = { ...ctx, guardPassed: false };
    // PUBLISH still proceeds — the breach does not abort the work.
    expect(next(STAGE.PUBLISH, { ok: true }, breached).stage).toBe(STAGE.WATCH);
    // ...and LAND is what gets withheld.
    expect(next(STAGE.WATCH, { outcome: 'green' }, breached)).toMatchObject({
      stage: STAGE.HARVEST,
      disposition: DISPOSITION.GUARD_WITHHELD,
      reason: REASON.GUARD_BREACH,
    });
  });

  test('without --merge the loop stops after WATCH, withheld rather than parked', () => {
    expect(next(STAGE.WATCH, { outcome: 'green' }, { ...ctx, merge: false })).toMatchObject({
      disposition: DISPOSITION.GUARD_WITHHELD,
      reason: REASON.MERGE_DISABLED,
    });
  });

  test('no_change_needed skips to HARVEST with no PR', () => {
    expect(
      next(STAGE.BUILD, { ok: true, verdict: { outcome: 'no_change_needed' } }, ctx),
    ).toMatchObject({ stage: STAGE.HARVEST, disposition: DISPOSITION.NO_CHANGE });
  });

  test('needs_human parks BEFORE the gate, with no gate and no PR', () => {
    const result = next(
      STAGE.BUILD,
      { ok: true, verdict: { outcome: 'implemented', needs_human: true } },
      ctx,
    );
    expect(result).toMatchObject({ stage: STAGE.HARVEST, reason: REASON.NEEDS_HUMAN });
    expect(result.stage).not.toBe(STAGE.GATE);
  });

  test('a failed BUILD parks and is NOT retried', () => {
    expect(next(STAGE.BUILD, { ok: false }, ctx)).toMatchObject({
      stage: STAGE.HARVEST,
      reason: REASON.BUILD_FAILED,
    });
  });

  test('a usage limit halts, and is not a bead failure', () => {
    const result = next(STAGE.BUILD, { usageLimit: true }, ctx);
    expect(result).toMatchObject({ stage: STAGE.DONE, disposition: DISPOSITION.HALTED });
    expect(result.disposition).not.toBe(DISPOSITION.PARKED);
    expect(countsTowardBreaker(result.disposition)).toBe(false);
  });

  test('lockfile drift is a hard park at PUBLISH', () => {
    expect(next(STAGE.PUBLISH, { lockfileDrift: true }, ctx)).toMatchObject({
      disposition: DISPOSITION.PARKED,
      reason: REASON.LOCKFILE_DRIFT,
    });
  });

  test('--dry-run stops after GATE, before any write', () => {
    expect(next(STAGE.GATE, { passed: true }, { ...ctx, dryRun: true })).toMatchObject({
      stage: STAGE.DONE,
      disposition: DISPOSITION.DRY_RUN,
    });
  });

  test('HALT is honoured at each of the eight stage boundaries', () => {
    // Reverting the halt check to fire at only some boundaries reddens here
    // with the exact stage named.
    for (const stage of STAGE_ORDER) {
      const result = next(
        stage,
        { bead: { id: 'X' }, passed: true, outcome: 'green' },
        {
          ...ctx,
          halt: true,
        },
      );
      expect(result, `halt at ${stage}`).toMatchObject({
        stage: STAGE.DONE,
        disposition: DISPOSITION.HALTED,
      });
    }
    expect(STAGE_ORDER).toHaveLength(8);
  });

  test('an unknown stage throws rather than silently ending the run', () => {
    expect(() => next('NOT_A_STAGE', {}, ctx)).toThrow(/unknown stage/);
  });
});

describe('machine: circuit breaker accounting', () => {
  test('three consecutive parks halt; a merge between them resets', () => {
    const run = (dispositions) => {
      let consecutive = 0;
      const halts = [];
      dispositions.forEach((disposition, index) => {
        if (resetsBreaker(disposition)) consecutive = 0;
        else if (countsTowardBreaker(disposition)) consecutive += 1;
        if (consecutive >= 3) halts.push(index);
      });
      return halts;
    };
    const P = DISPOSITION.PARKED;
    expect(run([P, P, P])).toEqual([2]);
    expect(run([P, P, DISPOSITION.MERGED, P])).toEqual([]);
    expect(run([P, P, DISPOSITION.NO_CHANGE, P, P, P])).toEqual([5]);
  });

  test('withheld and dry-run neither increment nor reset', () => {
    // Three successful no-merge iterations are the DEFAULT configuration; if
    // a withhold counted as a park the loop would halt on every clean run.
    expect(countsTowardBreaker(DISPOSITION.GUARD_WITHHELD)).toBe(false);
    expect(resetsBreaker(DISPOSITION.GUARD_WITHHELD)).toBe(false);
    expect(countsTowardBreaker(DISPOSITION.DRY_RUN)).toBe(false);
    expect(countsTowardBreaker(DISPOSITION.HALTED)).toBe(false);
    expect(countsTowardBreaker(DISPOSITION.PARKED)).toBe(true);
    expect(resetsBreaker(DISPOSITION.MERGED)).toBe(true);
    expect(resetsBreaker(DISPOSITION.NO_CHANGE)).toBe(true);
  });
});

// ─── guard ─────────────────────────────────────────────────────────────────

describe('guard: glob matching, both directions', () => {
  test('every shipped deny path matches what it is for', () => {
    const cases = [
      ['.github/**', '.github/workflows/ci.yml'],
      ['.husky/**', '.husky/pre-commit'],
      ['.semgrep/**', '.semgrep/cebab-bus.yaml'],
      ['.npmrc', '.npmrc'],
      ['eslint.config.js', 'eslint.config.js'],
      ['scripts/kanban-sync.mjs', 'scripts/kanban-sync.mjs'],
      ['package-lock.json', 'package-lock.json'],
    ];
    for (const [pattern, path] of cases) {
      expect(matchesGlob(pattern, path), `${pattern} vs ${path}`).toBe(true);
    }
  });

  test('and does NOT match things it should leave alone', () => {
    // The too-wide direction. A matcher where `**` swallowed everything, or
    // where a bare filename matched at any depth, reddens here.
    const cases = [
      ['.github/**', 'server/src/index.ts'],
      ['.github/**', 'docs/github-notes.md'],
      ['package-lock.json', 'web/package-lock.json'],
      ['eslint.config.js', 'web/eslint.config.js'],
      ['scripts/kanban-sync.mjs', 'scripts/kanban-sync.test.mjs'],
      ['.npmrc', 'server/.npmrc'],
    ];
    for (const [pattern, path] of cases) {
      expect(matchesGlob(pattern, path), `${pattern} vs ${path}`).toBe(false);
    }
  });

  test('* stays inside a segment; ** spans them', () => {
    expect(matchesGlob('scripts/*.mjs', 'scripts/loop.mjs')).toBe(true);
    expect(matchesGlob('scripts/*.mjs', 'scripts/lib/loop.mjs')).toBe(false);
    expect(matchesGlob('scripts/**/*.mjs', 'scripts/lib/loop/config.mjs')).toBe(true);
    expect(matchesGlob('**/package-lock.json', 'web/package-lock.json')).toBe(true);
  });

  test('a pathological pattern terminates', () => {
    // The shape `security/detect-unsafe-regex` exists to reject. The matcher
    // is iterative with backtracking, so this returns rather than hanging.
    expect(matchesGlob('*a*a*a*a*a*a*b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('guard: rules', () => {
  const file = (path, extra = {}) => ({ path, insertions: 1, deletions: 0, status: 'M', ...extra });

  test('a clean diff passes', () => {
    const result = evaluateGuard(
      { files: [file('server/src/index.ts')], addedLines: ['ok'] },
      GUARD,
    );
    expect(result).toEqual({ passed: true, breaches: [] });
  });

  test('a denied path breaches and names the pattern it hit', () => {
    const result = evaluateGuard({ files: [file('.github/workflows/ci.yml')] }, GUARD);
    expect(result.passed).toBe(false);
    expect(result.breaches[0]).toMatchObject({ rule: 'denyPaths' });
    expect(result.breaches[0].detail).toContain('.github/**');
  });

  test('maxFilesChanged: at the boundary passes, over it breaches', () => {
    const files = (n) => Array.from({ length: n }, (_, i) => file(`src/f${i}.ts`));
    expect(evaluateGuard({ files: files(25) }, GUARD).passed).toBe(true);
    expect(evaluateGuard({ files: files(26) }, GUARD).breaches).toContainEqual(
      expect.objectContaining({ rule: 'maxFilesChanged' }),
    );
  });

  test('maxNetLinesAdded counts NET, so a large refactor that deletes as much passes', () => {
    const at = [file('a.ts', { insertions: 600, deletions: 0 })];
    expect(evaluateGuard({ files: at }, GUARD).passed).toBe(true);
    const over = [file('a.ts', { insertions: 601, deletions: 0 })];
    expect(evaluateGuard({ files: over }, GUARD).breaches).toContainEqual(
      expect.objectContaining({ rule: 'maxNetLinesAdded' }),
    );
    const balanced = [file('a.ts', { insertions: 5000, deletions: 4900 })];
    expect(evaluateGuard({ files: balanced }, GUARD).passed).toBe(true);
  });

  test('a deleted test file breaches; a deleted ordinary file does not', () => {
    expect(
      evaluateGuard({ files: [file('server/src/foo.test.ts', { status: 'D' })] }, GUARD).breaches,
    ).toContainEqual(expect.objectContaining({ rule: 'allowTestDeletions' }));
    expect(
      evaluateGuard({ files: [file('scripts/thing_test.mjs', { status: 'D' })] }, GUARD).breaches,
    ).toContainEqual(expect.objectContaining({ rule: 'allowTestDeletions' }));
    // The other direction: deleting a non-test file is ordinary work.
    expect(
      evaluateGuard({ files: [file('server/src/foo.ts', { status: 'D' })] }, GUARD).passed,
    ).toBe(true);
  });

  test('a removed [security] tag breaches, but MOVING one does not', () => {
    const removed = {
      files: [file('a.test.ts')],
      addedLines: ["test('plain name', () => {})"],
      removedLines: ["test('[security] it refuses', () => {})"],
    };
    expect(evaluateGuard(removed, GUARD).breaches).toContainEqual(
      expect.objectContaining({ rule: 'allowTestDeletions' }),
    );
    // Counted, not pattern-matched: a rename that keeps the tag nets to zero.
    const moved = {
      files: [file('a.test.ts')],
      addedLines: ["test('[security] it still refuses', () => {})"],
      removedLines: ["test('[security] it refuses', () => {})"],
    };
    expect(evaluateGuard(moved, GUARD).passed).toBe(true);
  });

  test('forbidInDiff fires on an ADDED line only', () => {
    expect(
      evaluateGuard({ files: [file('a.sh')], addedLines: ['git commit --no-verify'] }, GUARD)
        .breaches,
    ).toContainEqual(expect.objectContaining({ rule: 'forbidInDiff' }));
    // Removing such a line is a fix, not a breach.
    expect(
      evaluateGuard({ files: [file('a.sh')], removedLines: ['git commit --no-verify'] }, GUARD)
        .passed,
    ).toBe(true);
  });

  test('reports EVERY breach at once, not the first', () => {
    // Reverting `evaluateGuard` to an early return reddens exactly here. The
    // whole list goes in the PR body; one breach per overnight run is the
    // round-trip this loop exists to remove.
    const result = evaluateGuard(
      {
        files: [
          file('.github/workflows/ci.yml'),
          file('package-lock.json'),
          file('a.test.ts', { status: 'D' }),
          ...Array.from({ length: 30 }, (_, i) => file(`src/f${i}.ts`, { insertions: 40 })),
        ],
        addedLines: ['run with --no-verify'],
      },
      GUARD,
    );
    const rules = new Set(result.breaches.map((b) => b.rule));
    expect(rules).toEqual(
      new Set([
        'denyPaths',
        'maxFilesChanged',
        'maxNetLinesAdded',
        'allowTestDeletions',
        'forbidInDiff',
      ]),
    );
    expect(result.breaches.length).toBeGreaterThanOrEqual(5);
  });
});

describe('guard: parsing real git output', () => {
  test('numstat + name-status become the shape the rules read', () => {
    const files = parseDiffStat(
      '12\t3\tserver/src/a.ts\n0\t40\tserver/src/b.test.ts\n-\t-\tweb/logo.png\n',
      'M\tserver/src/a.ts\nD\tserver/src/b.test.ts\nA\tweb/logo.png\n',
    );
    expect(files).toEqual([
      { path: 'server/src/a.ts', insertions: 12, deletions: 3, status: 'M' },
      { path: 'server/src/b.test.ts', insertions: 0, deletions: 40, status: 'D' },
      // Binary: `-` becomes 0, not NaN. A NaN here would poison the net-lines
      // sum and the cap could never trip again.
      { path: 'web/logo.png', insertions: 0, deletions: 0, status: 'A' },
    ]);
    const net = files.reduce((s, f) => s + f.insertions - f.deletions, 0);
    expect(Number.isFinite(net)).toBe(true);
  });

  test('a rename is keyed on its post-image path', () => {
    const files = parseDiffStat('1\t1\tnew.ts\n', 'R100\told.ts\tnew.ts\n');
    expect(files[0]).toMatchObject({ path: 'new.ts', status: 'R' });
  });

  test('diff line extraction ignores the +++/--- headers', () => {
    const { addedLines, removedLines } = parseDiffLines(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-old line', '+new line', ' context'].join('\n'),
    );
    expect(addedLines).toEqual(['new line']);
    expect(removedLines).toEqual(['old line']);
  });
});

// ─── select ────────────────────────────────────────────────────────────────

describe('select: the exclusions live in the argv', () => {
  test('argv carries --exclude-label and --exclude-type from config', () => {
    // THE case for the labels finding. Deleting either push in `readyArgv`
    // reddens here, and nothing else in the suite would notice.
    const argv = readyArgv(DEFAULTS.select, { limit: 50 });
    expect(argv.slice(0, 6)).toEqual(['ready', '--json', '-n', '50', '-s', 'hybrid']);
    expect(argv).toContain('--exclude-label');
    expect(argv[argv.indexOf('--exclude-label') + 1]).toBe('loop-stuck,needs-human,epic');
    expect(argv).toContain('--exclude-type');
    expect(argv[argv.indexOf('--exclude-type') + 1]).toBe('epic,decision');
  });

  test('the conformance check fails when an exclusion is missing', () => {
    // Both directions: it must pass on a good argv and fail on a stripped one,
    // or it is a check that cannot fail.
    expect(readyArgvConformsToConfig(readyArgv(DEFAULTS.select), DEFAULTS.select).conforms).toBe(
      true,
    );
    const stripped = readyArgv(DEFAULTS.select).filter(
      (a, i, all) => a !== '--exclude-label' && all[i - 1] !== '--exclude-label',
    );
    const verdict = readyArgvConformsToConfig(stripped, DEFAULTS.select);
    expect(verdict.conforms).toBe(false);
    expect(verdict.missing).toContain('--exclude-label');
  });

  test('empty exclusion lists add no flags', () => {
    const argv = readyArgv({ ...DEFAULTS.select, excludeLabels: [], excludeTypes: [] });
    expect(argv).not.toContain('--exclude-label');
    expect(argv).not.toContain('--exclude-type');
  });

  test('an unsupported sortPolicy is refused before the run, not by bd mid-run', () => {
    expect(() => readyArgv({ ...DEFAULTS.select, sortPolicy: 'newest' })).toThrow(ConfigError);
    for (const policy of ['priority', 'hybrid', 'oldest']) {
      expect(() => readyArgv({ ...DEFAULTS.select, sortPolicy: policy })).not.toThrow();
    }
  });
});

describe('select: filtering the rows bd actually returns', () => {
  const bead = (id, extra = {}) => ({
    id,
    title: `bead ${id}`,
    description: '',
    priority: 1,
    issue_type: 'task',
    status: 'open',
    ...extra,
  });

  test('priority above maxPriority is skipped, at the boundary is kept', () => {
    const beads = [bead('A', { priority: 3 }), bead('B', { priority: 2 })];
    expect(chooseBead(beads, { select: DEFAULTS.select }).id).toBe('B');
    // The boundary itself is INCLUDED — `> maxPriority`, not `>=`.
    expect(chooseBead([bead('B', { priority: 2 })], { select: DEFAULTS.select }).id).toBe('B');
  });

  test('a p3 follow-up is below the p2 ceiling and so is not picked', () => {
    // Follow-ups are filed at priority 3 with no label gate; the ceiling is
    // what keeps them out of an unattended run, not their label.
    const beads = [bead('followup', { priority: 3 }), bead('real', { priority: 0 })];
    expect(chooseBead(beads, { select: DEFAULTS.select }).id).toBe('real');
  });

  test('excluded types and id prefixes are skipped', () => {
    const beads = [
      bead('E', { issue_type: 'epic' }),
      bead('D', { issue_type: 'decision' }),
      bead('T'),
    ];
    expect(chooseBead(beads, { select: DEFAULTS.select }).id).toBe('T');
    expect(
      chooseBead([bead('skip-1'), bead('keep-1')], {
        select: { ...DEFAULTS.select, excludeIdPrefixes: ['skip-'] },
      }).id,
    ).toBe('keep-1');
  });

  test('a bead parked earlier in this run is not selected again', () => {
    const beads = [bead('A'), bead('B')];
    expect(chooseBead(beads, { select: DEFAULTS.select, parked: new Set(['A']) }).id).toBe('B');
    expect(chooseBead(beads, { select: DEFAULTS.select, parked: ['A', 'B'] })).toBeNull();
  });

  test('a bead whose text names a denied path is skipped', () => {
    const stems = denyPathStems(GUARD.denyPaths);
    const beads = [
      bead('A', { title: 'Fix the .github/workflows matrix' }),
      bead('B', { description: 'touches package-lock.json' }),
      bead('C', { title: 'Ordinary server work' }),
    ];
    expect(chooseBead(beads, { select: DEFAULTS.select, denyStems: stems }).id).toBe('C');
  });

  test('bd ordering is preserved — chooseBead never re-sorts', () => {
    // bd has already applied `-s hybrid`; re-sorting here would silently
    // override the policy the operator configured.
    const beads = [bead('second', { priority: 2 }), bead('first', { priority: 0 })];
    expect(chooseBead(beads, { select: DEFAULTS.select }).id).toBe('second');
  });

  test('an empty or malformed queue yields null rather than throwing', () => {
    expect(chooseBead([], { select: DEFAULTS.select })).toBeNull();
    expect(chooseBead([null, undefined, {}], { select: DEFAULTS.select })).toBeNull();
  });

  test('denyPathStems drops a stem that would match everything', () => {
    // A pattern starting with a wildcard yields an empty stem, and
    // `text.includes('')` is true for every bead — the queue would look
    // drained rather than filtered.
    expect(denyPathStems(['**/*.ts', '*.mjs'])).toEqual([]);
    expect(denyPathStems(['.github/**'])).toEqual(['.github/']);
  });
});

// ─── ledger ────────────────────────────────────────────────────────────────

describe('ledger', () => {
  test('builds a valid record from nothing', () => {
    // This is what makes the driver's `finally` possible: a thrown stage must
    // still produce a row. Making any field required reddens here.
    const record = buildRecord({}, 0);
    expect(validateRecord(record)).toEqual({ valid: true, errors: [] });
    expect(record.ts).toBe('1970-01-01T00:00:00.000Z');
    expect(record.disposition).toBeNull();
  });

  test('a fully populated record matches the documented shape', () => {
    const record = buildRecord(
      {
        bead: 'Cebab-vie.15',
        beadTitle: 'The gate is a race against the SDK',
        branch: 'loop/Cebab-vie.15',
        build: {
          sessionId: 's',
          numTurns: 23,
          costUsd: 1.84,
          exitCode: 0,
          outcome: 'implemented',
          risk: 'medium',
          attempts: 1,
        },
        gate: { steps: [{ name: 'lint', exitCode: 0, ms: 8210 }], playgroundRan: true },
        diffstat: { files: 4, insertions: 118, deletions: 12 },
        guard: { passed: true, breaches: [] },
        pr: { number: 393, url: 'https://example.invalid/393' },
        ci: { conclusion: 'success', waitedMs: 512000 },
        land: { merged: true, sha: 'a91298b' },
        harvest: { beadClosed: true, followUps: ['Cebab-p2x'] },
        disposition: 'merged',
      },
      Date.UTC(2026, 7, 25, 23, 14, 2),
    );
    expect(validateRecord(record).valid).toBe(true);
    expect(record.ts).toBe('2026-08-25T23:14:02.000Z');
    expect(record.land.sha).toBe('a91298b');
    expect(record.gate.liveSmokesRan).toBe(false);
  });

  test('an unknown disposition is rejected', () => {
    const bad = { ...buildRecord({}, 0), disposition: 'sort-of-merged' };
    expect(validateRecord(bad).valid).toBe(false);
    expect(validateRecord(bad).errors).toContain('disposition');
  });

  test('append writes one newline-terminated JSON line per record', () => {
    const lines = [];
    const sink = { appendLine: (line) => lines.push(line) };
    appendRecord(buildRecord({ bead: 'A', disposition: 'merged' }, 0), sink);
    appendRecord(buildRecord({ bead: 'B', disposition: 'parked' }, 0), sink);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.trimEnd().includes('\n')).toBe(false); // one record, one line
    }
    expect(JSON.parse(lines[0]).bead).toBe('A');
  });

  test('verdictVsGate: agree, disagree, and unknown are all distinguishable', () => {
    expect(
      compareVerdictToGate(['npm test', 'npm run lint'], [{ name: 'lint', exitCode: 0 }]),
    ).toBe('agree');
    // The signal that matters: the agent said it ran the tests, the gate found
    // them red.
    expect(compareVerdictToGate(['npm test'], [{ name: 'test', exitCode: 1 }])).toBe('disagree');
    // A claim about a DIFFERENT check is not contradicted by this failure.
    expect(compareVerdictToGate(['npm run lint'], [{ name: 'smoke', exitCode: 1 }])).toBe('agree');
    // Silence is not agreement.
    expect(compareVerdictToGate([], [{ name: 'test', exitCode: 1 }])).toBe('unknown');
  });

  test('test:security is not credited to a plain `npm test` claim', () => {
    expect(compareVerdictToGate(['npm test'], [{ name: 'test:security', exitCode: 1 }])).toBe(
      'agree',
    );
    expect(
      compareVerdictToGate(['npm run test:security'], [{ name: 'test:security', exitCode: 1 }]),
    ).toBe('disagree');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stages, driver and the deny hook (Cebab-qd2.2).
//
// These modules DO perform I/O, so each takes an injected `run`. The tests
// hand it a recorder that returns canned output and captures the argv — which
// is the only way to assert on the three bd flags the spec got wrong, on the
// two settings flags whose absence costs a mangled Kanban board rather than a
// failure, and on the usage-limit path that is most likely to be reached at
// 3am and least likely to be exercised by accident.
// ═══════════════════════════════════════════════════════════════════════════

import { claimArgv, closeArgv, followUpArgv, parkArgv } from './lib/loop/beads.mjs';
import { branchNameFor, commitSubject } from './lib/loop/git.mjs';
import {
  checkRunsArgv,
  classifyCheckRuns,
  failingSibling,
  prMergeArgv,
} from './lib/loop/forge.mjs';
import {
  assertPlaygroundEnv,
  DETERMINISTIC_STEPS,
  parseEnvFile,
  playgroundSmokeEnv,
  playgroundSmokes,
  playgroundTriggered,
} from './lib/loop/gate.mjs';
import {
  buildArgv,
  detectUsageLimit,
  isMaxTurns,
  makeBuild,
  renderPrompt,
  resolveTier,
} from './lib/loop/build.mjs';
import { allowReason, commandHeads, decide } from './lib/loop/loop-guard.mjs';
import { harvest, parseArgs, watchCi } from './loop.mjs';
import { makeRunner, needsWin32Shell } from './lib/loop/run.mjs';
import { makeGit } from './lib/loop/git.mjs';
import { stripComments } from './lib/strip_comments.mjs';
import {
  LockHeldError,
  acquireLock,
  evaluateLock,
  pidIsAlive,
  releaseLock,
} from './lib/loop/lock.mjs';

describe('beads: the three flags the spec got wrong', () => {
  test('park uses --add-label, never --label or --set-labels', () => {
    const argv = parkArgv('Cebab-x', 'evidence');
    expect(argv).toContain('--add-label');
    // `--label` is a FILTER flag on ready/list; `update` rejects it outright.
    expect(argv).not.toContain('--label');
    // `--set-labels` is accepted and would REPLACE every existing label.
    expect(argv).not.toContain('--set-labels');
    expect(argv.slice(0, 4)).toEqual(['update', 'Cebab-x', '--status', 'open']);
  });

  test('follow-ups are created and wired in ONE call', () => {
    const argv = followUpArgv({ title: 'T', type: 'bug', why: 'w', evidence: 'e' }, 'Cebab-src', {
      followUpPriority: 3,
      followUpLabel: 'loop-found',
    });
    // The label flag on `create` is `-l` / `--labels` (plural). The singular
    // `--label` that the spec wrote does not exist on this subcommand.
    expect(argv).toContain('-l');
    expect(argv).not.toContain('--label');
    expect(argv[argv.indexOf('-l') + 1]).toBe('loop-found');
    expect(argv[argv.indexOf('-p') + 1]).toBe('3');
    // The edge rides along, closing the window where a filed finding has no link.
    expect(argv[argv.indexOf('--deps') + 1]).toBe('discovered-from:Cebab-src');
    expect(argv).toContain('--silent');
  });

  test('claim is the atomic form, not two writes', () => {
    // Two writes would leave a window where the bead is assigned but still open.
    expect(claimArgv('X')).toEqual(['update', 'X', '--claim']);
    expect(closeArgv('X', 'because')).toEqual(['close', 'X', '-r', 'because']);
  });
});

describe('git: branch discipline and commit shape', () => {
  test('branches are always loop/-prefixed so they can be bulk-deleted', () => {
    expect(branchNameFor('Cebab-vie.15')).toBe('loop/Cebab-vie.15');
  });

  test('the commit subject matches the repo conventional-commit history', () => {
    expect(
      commitSubject(
        {
          commit_type: 'fix',
          commit_scope: 'security',
          commit_subject: 'a worker cannot write the string',
        },
        'Cebab-vie.14',
      ),
    ).toBe('fix(security): a worker cannot write the string (Cebab-vie.14)');
    // An empty scope must not leave stray parentheses.
    expect(
      commitSubject({ commit_type: 'docs', commit_scope: '', commit_subject: 'x' }, 'B-1'),
    ).toBe('docs: x (B-1)');
  });

  test('the bead id is not doubled when the agent already wrote it', () => {
    // Observed on the first PR the loop ever opened:
    //   fix(web): give 8 hover-styled buttons a focus ring (Cebab-p5y) (Cebab-p5y)
    // The agent writes the id itself because that IS this repo's convention —
    // every recent commit ends `(Cebab-xxx)` — so it can see it in `git log`.
    const v = (subject) => ({ commit_type: 'fix', commit_scope: 'web', commit_subject: subject });
    expect(commitSubject(v('a focus ring (Cebab-p5y)'), 'Cebab-p5y')).toBe(
      'fix(web): a focus ring (Cebab-p5y)',
    );
    // The other direction: when it is absent it must still be appended, or the
    // fix trades one bug for a worse one.
    expect(commitSubject(v('a focus ring'), 'Cebab-p5y')).toBe(
      'fix(web): a focus ring (Cebab-p5y)',
    );
    // A DIFFERENT id in the subject is not this bead's id, so it is appended.
    expect(commitSubject(v('x (Cebab-zzz)'), 'Cebab-p5y')).toBe(
      'fix(web): x (Cebab-zzz) (Cebab-p5y)',
    );
  });
});

describe('forge: WATCH has three outcomes, not two', () => {
  // Field names measured against the live endpoint, not assumed:
  //   {name, status: completed|in_progress|queued, conclusion, html_url}
  const runs = (list) => ({ check_runs: list });
  const R = 'Lint, Typecheck, Test';

  test('status and conclusion drive the classification', () => {
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'completed', conclusion: 'success' }]), R).outcome,
    ).toBe('green');
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'completed', conclusion: 'failure' }]), R).outcome,
    ).toBe('red');
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'completed', conclusion: 'cancelled' }]), R)
        .outcome,
    ).toBe('red');
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'in_progress', conclusion: null }]), R).outcome,
    ).toBe('pending');
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'queued', conclusion: null }]), R).outcome,
    ).toBe('pending');
    // A required check that is SKIPPED is not a failure — a path-filtered job
    // reports "nothing to do here" that way.
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'completed', conclusion: 'skipped' }]), R).outcome,
    ).toBe('green');
    // A conclusion this code has never seen, on a COMPLETED check, is red. An
    // allow-list of failure words would make the first one GitHub adds read as
    // a pass, which is the one direction that must never happen silently.
    expect(
      classifyCheckRuns(runs([{ name: R, status: 'completed', conclusion: 'brand_new' }]), R)
        .outcome,
    ).toBe('red');
  });

  test('a check by another name is absent, not green', () => {
    // The distinction the `absent` outcome exists for: some other job passing
    // must never be read as the required context passing.
    const verdict = classifyCheckRuns(
      runs([{ name: 'Other job', status: 'completed', conclusion: 'success' }]),
      R,
    );
    expect(verdict.found).toBe(false);
    expect(verdict.outcome).not.toBe('green');
  });

  test('failingSibling skips the aggregator and finds the matrix leg', () => {
    // The required context is a job with `needs: [quality]`; its own log says
    // only that a leg failed, never which line. The repair needs the leg.
    const payload = runs([
      { name: R, status: 'completed', conclusion: 'failure', html_url: 'x/runs/1/job/1' },
      {
        name: `${R} (windows-2022)`,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'x/runs/2/job/2',
      },
      { name: 'semgrep', status: 'completed', conclusion: 'success', html_url: 'x/runs/3/job/3' },
    ]);
    expect(failingSibling(payload, R).name).toBe(`${R} (windows-2022)`);
    // The other direction: nothing failing means nothing to hand back.
    expect(
      failingSibling(runs([{ name: 'semgrep', status: 'completed', conclusion: 'success' }]), R),
    ).toBe(null);
  });

  test('argv is scoped to ONE COMMIT, never to the PR', () => {
    // `gh pr checks <n>` lags a force-push and served the PREVIOUS commit's
    // verdict 1.2 seconds after a repair pushed (measured, ledger waitedMs).
    const argv = checkRunsArgv('deadbeef');
    expect(argv[0]).toBe('api');
    expect(argv[1]).toContain('/commits/deadbeef/check-runs');
    expect(argv.join(' ')).not.toContain('pr checks');
    expect(prMergeArgv(7)).toEqual(['pr', 'merge', '7', '--squash', '--delete-branch']);
    expect(prMergeArgv(7, { auto: true })).toContain('--auto');
  });
});

describe('gate: the Playground precondition is a hard gate', () => {
  const gate = { ...DEFAULTS.gate, playgroundRoot: '../Playground' };

  test('the deterministic tier mirrors CI, lockfile check first', () => {
    expect(DETERMINISTIC_STEPS[0].name).toBe('lockfile');
    const names = DETERMINISTIC_STEPS.map((s) => s.name);
    for (const required of [
      'lint',
      'format:check',
      'typecheck',
      'test',
      'test:security',
      'smoke',
      'build',
    ]) {
      expect(names, `CI runs ${required}`).toContain(required);
    }
  });

  test('trigger paths decide the playground tier, and never/always override', () => {
    expect(playgroundTriggered(['server/src/a.ts'], gate)).toBe(true);
    expect(playgroundTriggered(['shared/src/a.ts'], gate)).toBe(true);
    expect(playgroundTriggered(['docs/a.md'], gate)).toBe(false);
    expect(playgroundTriggered(['docs/a.md'], { ...gate, playgroundTier: 'always' })).toBe(true);
    expect(playgroundTriggered(['server/src/a.ts'], { ...gate, playgroundTier: 'never' })).toBe(
      false,
    );
  });

  test('env parsing handles comments, quotes and blank lines', () => {
    expect(parseEnvFile('# c\n\nA=1\nB="two"\nC=\'three\'\nnonsense\n')).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
    });
  });

  test('a missing .env REFUSES rather than skipping', () => {
    // Absent .env means dev:server runs against the real ~/.cebab and
    // ~/agents. Silence is the dangerous answer here, so it must throw.
    const readFile = () => {
      throw new Error('ENOENT');
    };
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile })).toThrow(
      /does not exist/,
    );
  });

  test('paths inside the Playground root are accepted', () => {
    const readFile = () =>
      'CEBAB_DATA_DIR=/Playground/.cebab-qa\nWORKSPACE_ROOT=/Playground/agents\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile })).not.toThrow();
  });

  test('a path OUTSIDE the root aborts, including the prefix look-alike', () => {
    const outside = () => 'CEBAB_DATA_DIR=/home/me/.cebab\nWORKSPACE_ROOT=/Playground/agents\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile: outside })).toThrow(
      /OUTSIDE/,
    );

    // `/Playground-evil` STARTS WITH the root string but is not inside it —
    // the reason containment is `path.relative`, not `startsWith`.
    const lookalike = () =>
      'CEBAB_DATA_DIR=/Playground-evil/.cebab\nWORKSPACE_ROOT=/Playground/agents\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile: lookalike })).toThrow(
      /OUTSIDE/,
    );
  });

  test('a .env missing one of the two keys is refused', () => {
    const partial = () => 'CEBAB_DATA_DIR=/Playground/.cebab-qa\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile: partial })).toThrow(
      /WORKSPACE_ROOT/,
    );
  });
});

describe('build: the usage-limit path', () => {
  test('each limit kind is distinguished, and the reset time is never guessed', () => {
    const session = detectUsageLimit("You've hit your session limit · resets 3:45pm");
    expect(session).toMatchObject({ hit: true, kind: 'session', resetsAt: '3:45pm' });
    expect(detectUsageLimit("You've hit your weekly limit · resets Nov 3")).toMatchObject({
      hit: true,
      kind: 'weekly',
    });
    // Per-model wording, which a two-alternative pattern would miss entirely.
    expect(detectUsageLimit("You've hit your Opus limit · resets 9pm")).toMatchObject({
      hit: true,
      kind: 'model',
    });
    // No reset time in the message -> null, never a guessed wake time.
    expect(detectUsageLimit("You've hit your session limit")).toMatchObject({
      hit: true,
      resetsAt: null,
    });
  });

  test('an ordinary failure is NOT read as a usage limit', () => {
    // The false-positive direction. Recording a bead failure as a usage limit
    // would halt the run; recording a usage limit as a bead failure would park
    // a healthy bead and count it toward the breaker.
    for (const text of ['Error: 3 tests failed', 'rate limited', 'your limit', '']) {
      expect(detectUsageLimit(text).hit, text).toBe(false);
    }
  });
});

describe('build: the argv', () => {
  const base = {
    config: DEFAULTS,
    repoRoot: '/repo',
    schemaJson: '{"type":"object"}',
    systemPromptPath: '/sys.md',
    settingsPath: '/settings.json',
  };

  test('carries BOTH settings flags — the measured hook-suppression mechanism', () => {
    // MEASURED: `--settings` alone MERGES with project settings and the
    // project SessionEnd hook still fires, which would push the Kanban board
    // every iteration. `--setting-sources user` is what suppresses it; the
    // merge is then what layers the loop's own deny hook back on. Dropping
    // either flag leaves a loop that still works and quietly misbehaves.
    const argv = buildArgv(base);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
    expect(argv[argv.indexOf('--settings') + 1]).toBe('/settings.json');
  });

  test('--json-schema is paired with --output-format json', () => {
    const argv = buildArgv(base);
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv).toContain('--json-schema');
    expect(argv).not.toContain('stream-json');
  });

  test('--max-budget-usd appears only when a per-bead ceiling is set', () => {
    // Ships OFF: a default run must apply no cost ceiling at all.
    expect(buildArgv(base)).not.toContain('--max-budget-usd');
    const capped = buildArgv({
      ...base,
      config: { ...DEFAULTS, limits: { ...DEFAULTS.limits, beadCostCeilingUsd: 5 } },
    });
    expect(capped[capped.indexOf('--max-budget-usd') + 1]).toBe('5');
  });

  test('a repair resumes the same session rather than starting a new one', () => {
    const argv = buildArgv({ ...base, resumeSessionId: 'sess-1' });
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-1');
    expect(buildArgv(base)).not.toContain('--resume');
  });

  test('web tools are disallowed and the turn cap is passed', () => {
    const argv = buildArgv(base);
    expect(argv).toContain('--disallowedTools');
    expect(argv).toContain('WebSearch');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('60');
  });

  test('the prompt is argv[1], BEFORE any variadic option', () => {
    // The first production run parked 3/3 beads on the circuit breaker with
    // zero model turns because the prompt was appended LAST and
    // `--disallowedTools <tools...>` is variadic — commander read the prompt
    // as a third tool name and the CLI got no prompt at all:
    //   Error: Input must be provided either through stdin or as a prompt
    //   argument when using --print
    //
    // The case above could not have caught it: it asserts the flag and its
    // values are PRESENT, and the prompt was not in buildArgv's output at all.
    // Presence, not interaction.
    const argv = buildArgv({ ...base, prompt: 'THE PROMPT' });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('THE PROMPT');
  });

  test('no bare positional ever follows a variadic option', () => {
    // The general form of the defect, so a future flag with `<x...>` cannot
    // reintroduce it. Everything after the last variadic option's values must
    // be an option or one of its values — never a stray positional.
    const VARIADIC = ['--disallowedTools', '--allowedTools', '--tools', '--mcp-config', '--betas'];
    for (const argv of [
      buildArgv({ ...base, prompt: 'p' }),
      buildArgv({ ...base, prompt: 'p', resumeSessionId: 's' }),
      buildArgv({
        ...base,
        prompt: 'p',
        config: { ...DEFAULTS, limits: { ...DEFAULTS.limits, beadCostCeilingUsd: 5 } },
      }),
    ]) {
      const lastVariadic = Math.max(...VARIADIC.map((f) => argv.indexOf(f)));
      expect(lastVariadic, 'a variadic option is present').toBeGreaterThan(-1);
      // Walk what follows: values, then optionally more options. A positional
      // can only appear here if someone appended one.
      const tail = argv.slice(lastVariadic + 1);
      const nextOption = tail.findIndex((a) => a.startsWith('--'));
      const consumed = nextOption === -1 ? tail : tail.slice(0, nextOption);
      expect(
        consumed.every((a) => !a.includes(' ')),
        `variadic swallowed: ${consumed}`,
      ).toBe(true);
      expect(consumed).not.toContain('p');
    }
  });
});

describe('build: prompt rendering and tiering', () => {
  const template = 'A {{bead_id}}\n{{#if repair}}REPAIR {{failed_step}}{{/if}}\nB';

  test('the repair block is removed whole when not repairing', () => {
    const out = renderPrompt(template, { bead_id: 'X', repair: false });
    expect(out).not.toContain('REPAIR');
    // and leaves no orphan markers behind
    expect(out).not.toContain('{{');
    expect(out).toContain('A X');
  });

  test('and is kept, interpolated, when repairing', () => {
    const out = renderPrompt(template, { bead_id: 'X', repair: true, failed_step: 'lint' });
    expect(out).toContain('REPAIR lint');
    expect(out).not.toContain('{{');
  });

  test('tiering is inert by default and first-match-wins when enabled', () => {
    expect(
      resolveTier({ priority: 0, issue_type: 'bug' }, 'server/', DEFAULTS.build.tiers),
    ).toBeNull();
    const tiers = [
      { when: { type: ['docs'] }, model: 'sonnet', effort: 'medium' },
      { when: { maxPriority: 1 }, model: 'opus', effort: 'high' },
    ];
    expect(resolveTier({ priority: 0, issue_type: 'docs' }, null, tiers)).toMatchObject({
      model: 'sonnet',
    });
    expect(resolveTier({ priority: 0, issue_type: 'bug' }, null, tiers)).toMatchObject({
      model: 'opus',
    });
    expect(resolveTier({ priority: 4, issue_type: 'bug' }, null, tiers)).toBeNull();
  });
});

describe('the PreToolUse deny hook', () => {
  test('denies every shape the harness owns', () => {
    const denied = [
      'npm install foo',
      'npm ci',
      'yarn add x',
      'git commit -m x',
      'git push',
      'git checkout main',
      'git reset --hard',
      'gh pr create',
      'rm -rf /tmp/x',
      'git commit --no-verify -m x',
      'ls && git push',
      'FOO=1 gh pr list',
      '/opt/homebrew/bin/gh pr list',
      'sudo rm -rf x',
    ];
    for (const command of denied) expect(decide(command), command).toBeTruthy();
  });

  test('and allows ordinary work — the direction that decides whether it is usable', () => {
    // A substring matcher denies `grep -rn gh .` and `git log --grep "git
    // commit"`. Both are read-only, and an agent that cannot search the repo
    // works around the hook rather than respecting it.
    const allowed = [
      'npm test',
      'npm run lint',
      'npm run typecheck',
      'npx vitest run',
      'git status',
      'git diff main',
      'git log --oneline',
      'git log --grep="git push"',
      'grep -rn gh .',
      'grep -rn "git commit" .',
      'rm file.txt',
      'echo "npm install is denied"',
    ];
    for (const command of allowed) expect(decide(command), command).toBeNull();
  });

  test('matching is at command position across shell separators', () => {
    expect(commandHeads('a | b; c && d || e').map((h) => h.head)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(commandHeads('FOO=1 BAR=2 npm test')[0].head).toBe('npm');
    expect(commandHeads('   ')).toEqual([]);
  });
});

describe('run: the process seam', () => {
  test('a non-zero exit is DATA, not an exception', async () => {
    // A red gate step and a red CI check are ordinary control flow here; a
    // seam that threw would turn every one of them into a crashed iteration.
    const run = makeRunner({ cwd: process.cwd() });
    const result = await run(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test('stdout and stderr are both captured', async () => {
    const run = makeRunner({ cwd: process.cwd() });
    const r = await run(process.execPath, ['-e', 'console.log("out");console.error("err")']);
    expect(r.stdout).toContain('out');
    expect(r.stderr).toContain('err');
  });

  test('a timeout is reported as timedOut, not as a plain failure', async () => {
    const run = makeRunner({ cwd: process.cwd() });
    const r = await run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
  });

  test('input is delivered on stdin, and omitted cleanly when absent', async () => {
    // Commit messages and PR bodies go in this way rather than as argv, so a
    // body containing a quote or a newline cannot be re-parsed by a shell.
    const run = makeRunner({ cwd: process.cwd() });
    const script =
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))';
    const withInput = await run(process.execPath, ['-e', script], { input: 'a "quoted" $line\n' });
    expect(withInput.stdout).toBe('a "quoted" $line\n');
    const without = await run(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(without.stdout).toBe('ok');
  });
});

describe('driver: CLI parsing', () => {
  test('flags map to the documented shape', () => {
    const args = parseArgs([
      '--bead',
      'X',
      '--until',
      '8',
      '--until',
      '07:00',
      '--merge',
      '--dry-run',
    ]);
    expect(args).toMatchObject({ bead: 'X', until: ['8', '07:00'], dryRun: true });
    expect(args.flags.merge).toBe(true);
  });

  test('an unknown option is refused rather than ignored', () => {
    expect(() => parseArgs(['--mrege'])).toThrow(ConfigError);
  });

  test('no --until leaves the default to config (one bead)', () => {
    expect(parseArgs([]).until).toEqual([]);
    expect(DEFAULTS.loop.until).toEqual(['1']);
  });
});

describe('run: the Windows shell decision', () => {
  // Windows CI caught this as three red cases in `run`'s own tests, and it was
  // a REAL defect rather than a test artifact: with `shell: true` Node joins
  // file and args into one command string with NO escaping (it warns —
  // DEP0190) and cmd.exe re-parses it. BUILD passes `--json-schema <json>` and
  // a multi-line prompt, so on Windows both would have arrived corrupted
  // instead of failing loudly.
  //
  // `platform` is injected so the decision is pinned from any host; the bug is
  // unreachable on macOS, which is exactly why it survived local verification.

  test('the npm-family shims need a shell on win32', () => {
    for (const shim of ['npm', 'npx', 'yarn', 'pnpm']) {
      expect(needsWin32Shell(shim, 'win32'), shim).toBe(true);
    }
    // Resolved paths and the `.cmd` extension both still resolve to the shim.
    expect(needsWin32Shell('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe(true);
    expect(needsWin32Shell('/usr/local/bin/npm', 'win32')).toBe(true);
  });

  test('real binaries never do — the direction that carries the bug', () => {
    for (const binary of ['node', 'git', 'gh', 'claude', process.execPath]) {
      expect(needsWin32Shell(binary, 'win32'), binary).toBe(false);
    }
  });

  test('and nothing needs one off win32', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(needsWin32Shell('npm', platform), platform).toBe(false);
      expect(needsWin32Shell('node', platform), platform).toBe(false);
    }
  });

  test('an argument containing shell metacharacters survives the seam intact', () => {
    // The property the shell decision protects. Reverting to
    // `shell: process.platform === 'win32'` leaves this green on macOS and red
    // on Windows, which is the whole reason the unit cases above inject the
    // platform rather than relying on this one.
    const run = makeRunner({ cwd: process.cwd() });
    const hostile = 'a "quoted" $VAR; echo pwned && ok | cat';
    return run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', hostile]).then(
      (r) => {
        expect(r.stdout).toBe(hostile);
        expect(r.stdout).not.toContain('pwned\n');
      },
    );
  });
});

describe('the restore path is not dry-run guarded (Cebab-qd2.3)', () => {
  // Found on first real use. `--dry-run` skips branch creation but NOT the
  // BUILD stage — it runs SELECT..GATE by definition — so the agent's edits
  // land on `main` itself. With the restore guarded too, teardown issued ZERO
  // git commands and those edits simply stayed there, which is the one outcome
  // §12 names explicitly: "leaves the repo on main with a clean tree".

  const recorder = () => {
    const calls = [];
    return {
      calls,
      run: async (file, args) => (
        calls.push([file, ...args].join(' ')),
        { code: 0, stdout: '', stderr: '' }
      ),
    };
  };

  test('under --dry-run, teardown still restores the repo', () => {
    const { calls, run } = recorder();
    const git = makeGit({ run, cwd: '/r', dryRun: true });
    return git
      .resetHard()
      .then(() => git.toMain())
      .then(() => {
        expect(calls).toEqual([
          'git reset --hard -q',
          'git checkout -q main',
          'git pull --ff-only -q',
        ]);
      });
  });

  test('but the mutations it exists to suppress stay suppressed', () => {
    // The other direction. A fix that simply removed the dryRun guard would
    // pass the case above and commit, branch and push during a dry run.
    const { calls, run } = recorder();
    const git = makeGit({ run, cwd: '/r', dryRun: true });
    return git
      .newBranch('X')
      .then(() => git.commit('m'))
      .then(() => git.push('X'))
      .then(() => git.deleteBranch('X'))
      .then(() => {
        expect(calls).toEqual([]);
      });
  });

  test('a normal run restores exactly the same way', () => {
    const { calls, run } = recorder();
    const git = makeGit({ run, cwd: '/r', dryRun: false });
    return git
      .resetHard()
      .then(() => git.toMain())
      .then(() => {
        expect(calls).toEqual([
          'git reset --hard -q',
          'git checkout -q main',
          'git pull --ff-only -q',
        ]);
      });
  });
});

describe('preflight failures are ConfigError, so they exit 2 (Cebab-qd2.3)', () => {
  // `.env` is gitignored, so its absence is the FIRST thing an operator hits
  // on a fresh clone. It threw a plain Error, which loop.mjs's catch treats as
  // an unrecoverable internal fault: exit 1 and a stack trace, for a condition
  // whose fix is four lines in a file. Only ConfigError maps to exit 2.
  const gate = { ...DEFAULTS.gate, playgroundRoot: '../Playground' };

  test('a missing .env', () => {
    const readFile = () => {
      throw new Error('ENOENT');
    };
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile })).toThrow(ConfigError);
  });

  test('a missing key', () => {
    const readFile = () => 'CEBAB_DATA_DIR=/Playground/.cebab-qa\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile })).toThrow(ConfigError);
  });

  test('a path outside the Playground root', () => {
    const readFile = () => 'CEBAB_DATA_DIR=/home/me/.cebab\nWORKSPACE_ROOT=/Playground/agents\n';
    expect(() => assertPlaygroundEnv({ repoRoot: '/repo', gate, readFile })).toThrow(ConfigError);
  });
});

describe('the single-run lock (Cebab-qd2.5)', () => {
  // Found on the first successful dry-run: two loop processes went at the same
  // checkout concurrently, SELECT handed both the SAME bead, and two agents
  // edited ONE working tree while the other's gate ran against it. Both gates
  // passed, which was luck. The spec said "serial, one bead at a time" and
  // nothing enforced one PROCESS.

  test('a live holder is refused; a dead one is taken over', () => {
    const held = JSON.stringify({ pid: 4242, startedAt: 'x' });
    expect(evaluateLock(held, { isAlive: () => true, self: 1 }).action).toBe('refuse');
    // The other direction, and it matters more than it looks: kill -9, a
    // closed lid or a crash all leave a lock behind, and a tool that then
    // demands a file be deleted by hand is worse than the race it prevents.
    expect(evaluateLock(held, { isAlive: () => false, self: 1 }).action).toBe('take');
  });

  test('an absent, corrupt, or own-pid lock is takeable', () => {
    expect(evaluateLock(null).action).toBe('take');
    // A truncated lock is a crash artifact, not a running process.
    expect(evaluateLock('{not json', { self: 1 }).action).toBe('take');
    expect(evaluateLock(JSON.stringify({ pid: 7 }), { isAlive: () => true, self: 7 }).action).toBe(
      'take',
    );
  });

  test('pidIsAlive treats EPERM as alive and ESRCH as gone', () => {
    // EPERM means the process exists under another user — alive for our
    // purposes. Reading it as "gone" would let a second run stomp a live one.
    const eperm = () => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    };
    const esrch = () => {
      throw Object.assign(new Error('x'), { code: 'ESRCH' });
    };
    expect(pidIsAlive(1, eperm)).toBe(true);
    expect(pidIsAlive(1, esrch)).toBe(false);
    expect(pidIsAlive(1, () => true)).toBe(true);
    expect(pidIsAlive(0)).toBe(false);
    expect(pidIsAlive(-1)).toBe(false);
  });

  // WHY LIVENESS IS INJECTED HERE. The first version of this case wrote
  // `pid: 1` and called it "a live holder". That is not a property of the
  // input, it is a property of the machine: pid 1 is init on macOS and Linux
  // and answers EPERM, so the case passed locally — and windows-2022 has no
  // such process, so `acquireLock` correctly took over what it read as a stale
  // lock and the case failed on the runner that gates the merge. What belongs
  // here is the FILE-level behaviour (exclusive create, EEXIST, then evaluate);
  // whether a given pid is alive is `pidIsAlive`'s own case above, which
  // exercises both directions with an injected `kill`.

  test('a foreign lock whose holder is alive is refused', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looplock-'));
    // First acquire wins and writes our own pid.
    expect(acquireLock(dir)).toContain('run.lock');
    // Our own pid is takeable (a resume), so simulate a DIFFERENT holder.
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: 'x' }));
    expect(() => acquireLock(dir, { isAlive: () => true })).toThrow(LockHeldError);
    // The lock still belongs to whoever holds it — refusing must not stomp it.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')).pid).toBe(4242);
  });

  test('a foreign lock whose holder is gone is taken over', async () => {
    // The other direction, at the same level. Without it the case above is
    // satisfied by an `acquireLock` that refuses unconditionally, which would
    // wedge every checkout that ever saw a `kill -9`.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looplock-'));
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: 'x' }));
    const said = [];
    expect(
      acquireLock(dir, { isAlive: () => false, self: 99, log: (m) => said.push(m) }),
    ).toContain('run.lock');
    // Taken over, and reported rather than done silently.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')).pid).toBe(99);
    expect(said.join(' ')).toContain('stale');
  });

  test('release only ever removes OUR lock', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looplock-'));
    acquireLock(dir);
    expect(releaseLock(dir)).toBe(true);
    // A run that overran and lost its lock must not delete the lock of
    // whoever legitimately took over. `releaseLock` compares pids and never
    // probes liveness, so any not-ours pid does — but it reads 4242 rather
    // than 1 so nobody copies a platform-dependent fixture out of here into
    // somewhere that DOES probe (see the note above).
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 4242, startedAt: 'x' }));
    expect(releaseLock(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'run.lock'))).toBe(true);
  });
});

// A real git repo in a temp dir, driven through the REAL `makeGit`.
//
// WHY REAL GIT. The defect these cases exist for WAS the diff expression
// (`git diff main...HEAD` before anything is committed). A fake `run` would
// have to fake `git diff` too, and a fake encoding the same wrong idea agrees
// with it — see project_measure_history_before_designing_a_check.
//
// NO `sh -c` ANYWHERE. These run on windows-2022, which has no `sh` on PATH
// for a bare spawn; file edits go through node:fs so the fixture means the
// same thing on every runner.
async function repoFixture() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const made = [];

  const mkRepo = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopgit-'));
    made.push(dir);
    const run = makeRunner({ cwd: dir });
    const git = makeGit({ run, cwd: dir });
    const g = (...args) => run('git', args);

    await g('init', '-q');
    // Not `init -b main`: this is the portable spelling on every git version.
    await g('symbolic-ref', 'HEAD', 'refs/heads/main');
    await g('config', 'user.email', 'loop@test');
    await g('config', 'user.name', 'loop');
    await g('config', 'commit.gpgsign', 'false');

    const write = (rel, body) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    };
    const append = (rel, body) => fs.appendFileSync(path.join(dir, rel), body);
    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

    write('.gitignore', '.loop/\n');
    write('.github/workflows/ci.yml', 'on: push\n');
    write('server/a.ts', 'base\n');
    await g('add', '-A');
    await g('commit', '-q', '-m', 'base');
    return { dir, git, write, append, read };
  };

  const cleanup = async () => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  };
  return { mkRepo, cleanup };
}

describe('the stages that had never run (Cebab-qd2.7)', () => {
  // Every defect below sat in a path the loop had literally never executed:
  // `--dry-run` returns DONE at the GATE boundary by design, so PUBLISH,
  // WATCH, LAND and HARVEST were unreached by four merged PRs and 118 green
  // tests. These cases exist so that stops being true.

  // ── D4/D3: the guard was measuring an empty diff ────────────────────────
  //
  // BUILD edits the working tree and commits nothing, and CLAIM's `newBranch`
  // leaves HEAD equal to main — so `git diff main...HEAD` compared main to
  // itself. The guard passed unconditionally with a `.github/**` edit sitting
  // right there, and `--merge` gates LAND on exactly that verdict.
  //
  // Reddens if `--cached` or the `stageAll()` call is dropped from
  // `changedPaths` / `diffForGuard`.
  test('the guard sees uncommitted and untracked work, before any commit', async () => {
    const { mkRepo, cleanup } = await repoFixture();
    try {
      const { git, append, write } = await mkRepo();
      await git.newBranch('Cebab-t1');
      append('.github/workflows/ci.yml', 'evil\n'); // a denied path, modified
      write('server/brand_new.ts', 'fresh\n'); // CREATED — invisible until staged

      const paths = await git.changedPaths();
      expect(paths).toContain('.github/workflows/ci.yml');
      expect(paths).toContain('server/brand_new.ts');

      const guard = evaluateGuard(await git.diffForGuard(), DEFAULTS.guard);
      expect(guard.passed).toBe(false);
      expect(guard.breaches.map((b) => b.rule)).toContain('denyPaths');
    } finally {
      await cleanup();
    }
  });

  // `diffForGuard` must stage for ITSELF. The case above calls `changedPaths`
  // first, which stages as a side effect — so it stayed green when
  // `diffForGuard`'s own `stageAll()` was reverted, and a revert-check said so
  // ("STAYED GREEN — the test does not defend this"). The driver happens to
  // call GATE before PUBLISH today, which is exactly the kind of ordering
  // coupling that produced D1. Nothing else touches the index here.
  test('diffForGuard stages on its own, with no prior changedPaths call', async () => {
    const { mkRepo, cleanup } = await repoFixture();
    try {
      const { git, write } = await mkRepo();
      await git.newBranch('Cebab-t1b');
      write('server/only_created.ts', 'fresh\n'); // untracked: needs the index
      const diff = await git.diffForGuard();
      expect(diff.files.map((f) => f.path)).toContain('server/only_created.ts');
    } finally {
      await cleanup();
    }
  });

  // The other direction. Without it the case above is satisfied by a
  // `diffForGuard` that reports every file in the repo on every call.
  test('a branch with no work reports no change and no breach', async () => {
    const { mkRepo, cleanup } = await repoFixture();
    try {
      const { git } = await mkRepo();
      await git.newBranch('Cebab-t2');
      expect(await git.changedPaths()).toEqual([]);
      expect(evaluateGuard(await git.diffForGuard(), DEFAULTS.guard).passed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ── D5/D6: teardown left the tree dirty, so the next run refused ────────
  //
  // `git reset --hard` does NOT remove untracked files (measured), so a file
  // the agent CREATED survived onto main and the next run's preflight refused
  // with "working tree is dirty". Reddens if `clean` leaves `restoreToMain`.
  test('restoreToMain removes created files and returns to main', async () => {
    const { mkRepo, cleanup } = await repoFixture();
    try {
      const { git, append, write } = await mkRepo();
      await git.newBranch('Cebab-t3');
      append('server/a.ts', 'edit\n');
      write('server/created_by_agent.ts', 'leftover\n');
      expect(await git.isClean()).toBe(false);

      await git.restoreToMain();

      expect(await git.isClean()).toBe(true);
      expect(await git.currentBranch()).toBe('main');
    } finally {
      await cleanup();
    }
  });

  // `.loop/` holds the run lock and the ledger and is gitignored. If the clean
  // took ignored paths with it the loop would delete its own lock mid-run and
  // a second process could start. `clean -fd` without `-x` spares them.
  test('restoreToMain spares gitignored paths', async () => {
    const { mkRepo, cleanup } = await repoFixture();
    try {
      const { git, write, read } = await mkRepo();
      write('.loop/run.lock', 'held');
      await git.restoreToMain();
      expect(read('.loop/run.lock')).toBe('held');
    } finally {
      await cleanup();
    }
  });

  // ── D8: the Playground tier had never once passed ──────────────────────
  //
  // Found by running the tier for the first time: `ws_smoke FAIL 240ms
  // Unexpected server response: 401`. The server loads `../.env` itself and
  // writes its per-launch token into the Playground data dir; the smokes were
  // spawned with plain `process.env`, and `ws_smoke.ts` falls back to
  // `~/.cebab/auth-token` when `CEBAB_AUTH_TOKEN_FILE` is unset. So it read
  // the operator's REAL data dir and was refused — while also being the one
  // thing an isolated gate must never do.
  test('the Playground smokes inherit the Playground data dir, never ~/.cebab', () => {
    const env = playgroundSmokeEnv(
      { CEBAB_DATA_DIR: '/pg/.cebab-qa', WORKSPACE_ROOT: '/pg/agents', PORT: '4319' },
      { HOME: '/home/op', PATH: '/usr/bin' },
    );
    // `path.resolve` prepends a DRIVE LETTER on Windows and `path.join` does
    // not, so an expectation built with join against an implementation built
    // with resolve is right on POSIX and red on the runner that gates the
    // merge (`D:\\pg\\…` vs `\\pg\\…`). Mirrors the DATA_DIR line below.
    // This exact fix was written by the loop's own repair pass on PR #403.
    expect(env.CEBAB_AUTH_TOKEN_FILE).toBe(path.join(path.resolve('/pg/.cebab-qa'), 'auth-token'));
    expect(env.CEBAB_DATA_DIR).toBe(path.resolve('/pg/.cebab-qa'));
    expect(env.WORKSPACE_ROOT).toBe('/pg/agents');
    expect(env.PATH).toBe('/usr/bin'); // the base env still comes through
    // The whole point: nothing here can resolve to the operator's real dir.
    expect(env.CEBAB_AUTH_TOKEN_FILE).not.toContain('/home/op');
  });

  // Reddens if `ws_smoke` is put back into the tier. It is already
  // deterministic step 10 via `ci_smoke`, which runs it correctly — over a
  // temp workspace it populates with the `Cebab` directory `ws_smoke.ts`
  // requires by name, and with `MOCK=1`, without which `send_message` spawns a
  // REAL claude turn and a green gate step quietly bills the subscription.
  test('the Playground tier never runs ws_smoke', () => {
    const off = playgroundSmokes({ liveSmokes: false });
    expect(off).toEqual([]);

    // The other direction: with live smokes ON the list is non-empty, so the
    // case above cannot be satisfied by a function that always returns [].
    const on = playgroundSmokes({ liveSmokes: true });
    expect(on.length).toBeGreaterThan(0);
    expect(on.map((x) => x.name)).toContain('live_smoke');

    for (const list of [off, on]) {
      expect(list.map((x) => x.name)).not.toContain('ws_smoke');
      expect(list.map((x) => x.script)).not.toContain('src/ws_smoke.ts');
    }
  });

  // ── D2: WATCH called healthy CI "never started" ─────────────────────────
  //
  // The required check `needs:` the ubuntu+windows matrix, and GitHub creates
  // no check run for a gated job until its dependencies finish. Measured on
  // PR #402: workflow at 08:12:13Z, required check at 08:23:36Z — 11m23s
  // against a five-minute timeout. Every real run parked `ci_never_started`,
  // which is never repaired and counts toward the breaker.
  test('classifyCheckRuns reports whether anything is still pending', () => {
    const required = 'Lint, Typecheck, Test';
    // The real shape during the matrix, copied from the live endpoint: the
    // required name is absent ENTIRELY while its legs run.
    const during = classifyCheckRuns(
      {
        check_runs: [
          {
            name: 'Lint, Typecheck, Test (ubuntu-latest)',
            status: 'in_progress',
            conclusion: null,
          },
          { name: 'semgrep', status: 'completed', conclusion: 'success' },
        ],
      },
      required,
    );
    expect(during.found).toBe(false);
    expect(during.anyPending).toBe(true);

    // Everything settled and the required name never showed up: the real
    // "never started", and the only case that should ever park.
    const settled = classifyCheckRuns(
      { check_runs: [{ name: 'semgrep', status: 'completed', conclusion: 'success' }] },
      required,
    );
    expect(settled.found).toBe(false);
    expect(settled.anyPending).toBe(false);

    // No checks at all is also not-pending, so a dead CI still parks.
    expect(classifyCheckRuns({ check_runs: [] }, required).anyPending).toBe(false);
  });

  const pollingForge = (responses) => {
    let i = 0;
    return { pollChecks: async () => responses[Math.min(i++, responses.length - 1)] };
  };
  const watchConfig = {
    ci: {
      requiredContext: 'Lint, Typecheck, Test',
      pollIntervalMs: 1,
      appearTimeoutMs: 0, // already expired: only `anyPending` can hold it back
      completeTimeoutMs: 60000,
    },
  };

  // Reddens if `!status.anyPending` is dropped from the absent condition —
  // with the timeout already expired, the first poll would return 'absent'.
  test('a pending sibling check is not "CI never started"', async () => {
    const forge = pollingForge([
      { outcome: 'pending', found: false, anyPending: true, total: 3 },
      { outcome: 'pending', found: false, anyPending: true, total: 3 },
      { outcome: 'green', found: true, anyPending: false, total: 4 },
    ]);
    const out = await watchCi({
      forge,
      config: watchConfig,
      prNumber: 1,
      parts: {},
      log: () => {},
      halted: () => false,
    });
    expect(out.outcome).toBe('green');
  });

  // The other direction, and it matters as much: a run where CI genuinely
  // never starts must still park rather than poll until completeTimeoutMs.
  test('nothing pending and the required name absent IS "CI never started"', async () => {
    const forge = pollingForge([{ outcome: 'pending', found: false, anyPending: false, total: 2 }]);
    const out = await watchCi({
      forge,
      config: watchConfig,
      prNumber: 1,
      parts: {},
      log: () => {},
      halted: () => false,
    });
    expect(out.outcome).toBe('absent');
  });

  // ── D11: a turn-cap exhaustion was recorded as a generic crash ──────────
  //
  // Found by running the loop for real: the agent used all 40 turns without a
  // verdict. The CLI exited NON-ZERO but still emitted a complete envelope —
  //
  //   {"terminal_reason":"max_turns",
  //    "errors":["Reached maximum number of turns (40)"], ...}
  //
  // — and `build.mjs` returned on `result.code !== 0` BEFORE parsing it. So
  // the ledger recorded `failure: 'exit'` with a truncated JSON fragment and
  // `sessionId: null, numTurns: null, costUsd: null`. Three consequences: the
  // operator cannot tell "needs more turns" from "the CLI broke" (opposite
  // remedies), nobody can resume the session, and `costCeilingUsd` silently
  // under-counts by exactly the runs worth knowing about.
  test('isMaxTurns reads either signal, and neither is load-bearing alone', () => {
    const real = {
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (40)'],
    };
    expect(isMaxTurns(real)).toBe(true);
    // Each alone — `terminal_reason` is undocumented and its vocabulary is not
    // frozen; the errors string has its own wording risk.
    expect(isMaxTurns({ terminal_reason: 'max_turns' })).toBe(true);
    expect(isMaxTurns({ errors: ['Reached maximum number of turns (60)'] })).toBe(true);
    // The other direction, so it cannot pass by always returning true.
    expect(isMaxTurns({ session_id: 'x', num_turns: 3, structured_output: {} })).toBe(false);
    expect(isMaxTurns({ terminal_reason: 'end_turn', errors: [] })).toBe(false);
    expect(isMaxTurns(null)).toBe(false);
    expect(isMaxTurns('not an object')).toBe(false);
  });

  test('a capped build keeps its session, turns and cost', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const url = await import('node:url');
    const libDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'lib', 'loop');
    const loopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopbuild-'));

    // Exactly what the CLI returned, exit code and all.
    const envelope = JSON.stringify({
      type: 'result',
      session_id: '56889fbe-75a6-4510-9e17-10fa0248276f',
      num_turns: 40,
      total_cost_usd: 0.4137,
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (40)'],
    });
    const run = async () => ({ code: 1, stdout: envelope, stderr: '', ms: 10, timedOut: false });

    const build = makeBuild({ run, cwd: '/repo', config: DEFAULTS, libDir, loopDir });
    const out = await build.run({ bead: { id: 'X-1', title: 't' }, attempt: 1, maxRepairs: 2 });

    expect(out.ok).toBe(false);
    expect(out.failure).toBe('max_turns'); // not the generic 'exit'
    // The three that were being thrown away.
    expect(out.sessionId).toBe('56889fbe-75a6-4510-9e17-10fa0248276f');
    expect(out.numTurns).toBe(40);
    expect(out.costUsd).toBe(0.4137);
    // And the detail is a sentence, not 600 chars of JSON.
    expect(out.detail).toContain('40 turns');
    expect(out.detail).toContain('claude --resume');
    fs.rmSync(loopDir, { recursive: true, force: true });
  });

  test('the machine parks a capped build under its own reason', () => {
    // The remedy is the opposite of every other build failure — raise
    // maxTurns or split the bead, rather than debug a crash — so the two must
    // be distinguishable in the ledger.
    const capped = next(STAGE.BUILD, { ok: false, failure: 'max_turns' }, {});
    expect(capped.disposition).toBe(DISPOSITION.PARKED);
    expect(capped.reason).toBe(REASON.MAX_TURNS);

    // The other direction: everything else still parks as build_failed.
    const crashed = next(STAGE.BUILD, { ok: false, failure: 'exit' }, {});
    expect(crashed.reason).toBe(REASON.BUILD_FAILED);
  });

  // ── D17: the agent could not run a single gate command ─────────────────
  //
  // Claude Code auto-approves Bash it can classify as safe but requires
  // approval for npm/npx/node, and `-p` has no approver — so the hook's
  // silence meant REFUSED. Measured with the loop's own flags:
  //
  //   echo HELLO_FROM_BASH  -> ran,     denials []
  //   npm run typecheck     -> REFUSED, "This command requires approval"
  //   npm run typecheck     -> ran,     denials []   (hook returns `allow`)
  //
  // The consequence that is easy to miss: `verdict.tests.commands_run` is
  // always empty, so `compareVerdictToGate` is STRUCTURALLY always 'unknown'
  // and the spec's "the agent's report is not evidence" can never record
  // agreement or disagreement, because there is never a claim.
  test('the gate commands the agent needs are explicitly allowed', () => {
    for (const cmd of [
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npx vitest run scripts/loop.test.mjs',
      'node scripts/audit-gate.mjs',
    ]) {
      expect(allowReason(cmd), cmd).toBeTruthy();
    }
  });

  test('deny wins over allow, in both orders', () => {
    // An allow rule must never be able to widen the deny list. `npm install`
    // matches no ALLOW rule anyway; the compound cases are the real risk,
    // because their FIRST segment is a legitimate verification command.
    for (const cmd of [
      'npm install',
      'npm run lint && git push origin main',
      'npm test; gh pr merge 1',
      'node x.mjs && rm -rf /',
    ]) {
      expect(decide(cmd), cmd).toBeTruthy(); // denied
      expect(allowReason(cmd), cmd).toBeFalsy(); // and not allowed
    }
  });

  test('ordinary read-only work is still deferred, not allowed or denied', () => {
    // The hook must not become an allow-list for everything: anything it does
    // not recognise keeps the normal flow, which already permits `grep`.
    for (const cmd of ['grep -rn gh .', 'ls -la', 'cat package.json']) {
      expect(decide(cmd), cmd).toBeFalsy();
      expect(allowReason(cmd), cmd).toBeFalsy();
    }
  });

  // ── D1: HARVEST crashed on the first follow-up ──────────────────────────
  //
  // `parts` was built with `harvest: {}` two hundred lines from the `.push`,
  // so filing a follow-up threw `Cannot read properties of undefined`.
  // `follow_ups` is a required key of the verdict schema, so this fired on
  // essentially every run that got this far. The bare `{}` below is the
  // point: it reddens if the `??=` is removed, independently of whatever
  // initializer the driver happens to use today.
  test('harvest files follow-ups even when parts.harvest arrives bare', async () => {
    const filed = [];
    const parts = {
      harvest: {},
      verdict: { follow_ups: [{ title: 'a thing noticed', type: 'task' }] },
    };
    await harvest({
      beads: {
        close: async () => true,
        park: async () => true,
        fileFollowUp: async (f) => {
          filed.push(f.title);
          return 'Cebab-new1';
        },
      },
      bead: { id: 'Cebab-src' },
      parts,
      disposition: 'guard_withheld',
      reason: null,
      config: DEFAULTS,
      log: () => {},
    });
    expect(filed).toEqual(['a thing noticed']);
    expect(parts.harvest.followUps).toEqual(['Cebab-new1']);
  });
});

describe('the circuit breaker is per-run (Cebab-qd2.6)', () => {
  // A fresh, fully successful dry-run halted on its FIRST iteration with
  // "3 consecutive parks — " and an empty bead list. `consecutiveParks` was
  // seeded from `.loop/state.json`, which still held 3 from an earlier failed
  // run, and nothing but a merge or a no-change ever cleared it — so a
  // checkout that once had three parks could never run again without someone
  // hand-editing a JSON file.
  //
  // WHY THIS IS A SOURCE SCAN. The seeding happens inside `main()`, which
  // takes no injectable seam and performs real I/O, so there is nothing to
  // call. What is being pinned is a DECISION, and the reverted form is one
  // token different from the correct one. Both directions are exercised below
  // so the scan cannot pass vacuously.

  /** Does this source seed the breaker from disk rather than from zero? */
  const seedsBreakerFromDisk = (source) => {
    const code = stripComments(source);
    const at = code.indexOf('consecutiveParks:');
    if (at === -1) return { found: false, seeded: false };
    const value = code.slice(at + 'consecutiveParks:'.length, at + 120);
    return { found: true, seeded: /readJson|STATE_FILE|stateFile/.test(value.split(',')[0]) };
  };

  test('loop.mjs starts each run at zero', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, 'loop.mjs'), 'utf8');

    const verdict = seedsBreakerFromDisk(source);
    // Not vacuous: the field must actually be present to be checked.
    expect(verdict.found, 'consecutiveParks assignment located in loop.mjs').toBe(true);
    expect(verdict.seeded, 'breaker must not be seeded from state.json').toBe(false);
  });

  test('and the scan detects the reverted form', () => {
    // The other direction. Without this the scan could be broken — a regex
    // that never matches would report "not seeded" for any input at all.
    const reverted =
      'const ctx = {\n  consecutiveParks: readJson(STATE_FILE, {}).consecutiveParks ?? 0,\n};';
    expect(seedsBreakerFromDisk(reverted)).toEqual({ found: true, seeded: true });
    const fixed = 'const ctx = {\n  consecutiveParks: 0,\n};';
    expect(seedsBreakerFromDisk(fixed)).toEqual({ found: true, seeded: false });
    // And a source without the field at all is reported as not-found, rather
    // than silently passing as "not seeded".
    expect(seedsBreakerFromDisk('const ctx = {};').found).toBe(false);
  });

  // ── D6: iterations stacked branches on each other ──────────────────────
  //
  // `git.toMain()` was called only from `teardown`, which runs ONCE in the
  // outer finally, while `git.newBranch` runs per iteration from whatever is
  // checked out. So bead 2 branched off `loop/<bead1>` and its PR carried bead
  // 1's commits — and `loop:night` runs `--until 8`, so the intended overnight
  // use produced eight cumulative, contaminated PRs.
  //
  // A source scan for the same reason as the breaker above: the call lives in
  // `runIteration`'s `finally`, which takes no injectable seam. Both
  // directions are exercised so it cannot pass vacuously.

  /** Does `runIteration` put the checkout back before the next bead? */
  const restoresEachIteration = (source) => {
    const code = stripComments(source);
    const start = code.indexOf('async function runIteration');
    if (start === -1) return { found: false, restores: false };
    const end = code.indexOf('async function watchCi', start);
    const body = code.slice(start, end === -1 ? code.length : end);
    return { found: true, restores: body.includes('restoreToMain(') };
  };

  test('runIteration returns the checkout to main before the next bead', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, 'loop.mjs'), 'utf8');

    const verdict = restoresEachIteration(source);
    expect(verdict.found, 'runIteration located in loop.mjs').toBe(true);
    expect(verdict.restores, 'each iteration must restore, not just teardown').toBe(true);
  });

  test('and that scan detects the reverted form', () => {
    const reverted =
      'async function runIteration() {\n  try {} finally { appendRecord(r); }\n}\n' +
      'async function watchCi() { await git.restoreToMain(); }';
    // The restore exists in the FILE but outside runIteration — which is
    // exactly the bug, so a naive whole-file search would have missed it.
    expect(restoresEachIteration(reverted)).toEqual({ found: true, restores: false });

    const fixed =
      'async function runIteration() {\n  try {} finally { await git.restoreToMain(); }\n}\n' +
      'async function watchCi() {}';
    expect(restoresEachIteration(fixed)).toEqual({ found: true, restores: true });

    expect(restoresEachIteration('const x = 1;').found).toBe(false);
  });

  test('cross-run memory lives in the loop-stuck label, not the counter', () => {
    // The reason dropping persistence is safe: a parked bead is excluded from
    // future runs by label, so the evidence is not lost — it was being counted
    // twice.
    expect(DEFAULTS.select.excludeLabels).toContain('loop-stuck');
  });
});
