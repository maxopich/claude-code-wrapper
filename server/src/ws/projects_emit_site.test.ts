import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Cebab-ws0.6 — one emit point for the `projects` message.
 *
 * The message now carries a file scan alongside the rows, and that scan is
 * DERIVED FROM `trusted`. So a site that re-emits the project list by hand
 * after a trust toggle does not ship a stale summary — it ships one that
 * contradicts the pill sitting next to it. There were eight such sites before
 * this bead, added over time by whoever needed a refresh; nothing stopped a
 * ninth.
 *
 * A type cannot catch this: `scans: []` compiles. What catches it is the
 * absence of the literal anywhere but the one helper.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, '..');

/** Every non-test `.ts` under `server/src`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * `{ type: 'projects'` — the message literal, in either quote style.
 *
 * Global, and therefore never used with `.test()`: a `/g` regex carries
 * `lastIndex` across calls, so a `.test()` loop over many files silently skips
 * matches after the first. `search` and `match` are stateless here.
 */
const LITERAL = /\{\s*type:\s*['"]projects['"]/g;

/** Presence, without touching `lastIndex`. */
function declares(src: string): boolean {
  return src.search(LITERAL) !== -1;
}

describe('the projects message has exactly one emit site', () => {
  const files = sourceFiles(SERVER_SRC);

  test('the scan reaches a real number of files', () => {
    // Anti-vacuity. A walker that returns nothing passes every assertion below
    // by finding no violations, which is the shape this repo has been bitten
    // by before.
    expect(files.length).toBeGreaterThan(80);
  });

  test('the literal appears only inside `sendProjects`', () => {
    const declaring = files.filter((f) => declares(fs.readFileSync(f, 'utf8')));
    expect(declaring.map((f) => path.relative(SERVER_SRC, f))).toEqual([
      path.join('ws', 'server.ts'),
    ]);

    const src = fs.readFileSync(path.join(SERVER_SRC, 'ws', 'server.ts'), 'utf8');
    // Exactly one occurrence, and it is the one inside the helper.
    const occurrences = src.match(LITERAL) ?? [];
    expect(occurrences.length).toBe(1);

    const helperAt = src.indexOf('function sendProjects(');
    expect(helperAt).toBeGreaterThan(-1);
    const literalAt = src.search(LITERAL);
    expect(literalAt).toBeGreaterThan(helperAt);
    // Within the helper's body, not merely somewhere after it.
    expect(literalAt - helperAt).toBeLessThan(400);
  });

  test('the control: the locator finds a literal when one is present', () => {
    // Without this, a typo in LITERAL would make the test above pass by
    // matching nothing anywhere — the same green as full compliance.
    expect(declares("send(conn.ws, { type: 'projects', projects: [] })")).toBe(true);
    expect(declares('send(conn.ws, { type: "projects", projects: [] })')).toBe(true);
    expect(declares("send(conn.ws, { type: 'sessions', sessions: [] })")).toBe(false);
  });

  test('every caller goes through the helper', () => {
    const src = fs.readFileSync(path.join(SERVER_SRC, 'ws', 'server.ts'), 'utf8');
    // Eight at the time of writing. The number is not the point — the point is
    // that it is greater than one, so the helper is load-bearing rather than a
    // single-use wrapper that a future edit would reasonably inline.
    const calls = src.match(/\bsendProjects\(conn(?:, |,\n)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });
});
