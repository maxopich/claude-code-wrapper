/**
 * Cebab-ws0.15: "not connected" is defined once, for both readers.
 *
 * The banner (`web/`) and the note (`server/`) answer the same question about
 * the same session, and the rule used to live in `web/src/mcpStatus.ts` where
 * only one of them could reach it. Moving it to `shared/` is what makes them
 * agree by construction rather than by review — the same argument `sendProjects`
 * and `respondWithProjectAuthority` were unified under.
 *
 * The failure this guards is not someone editing the shared copy. It is someone
 * needing the rule in `web/`, not finding an import to hand, and writing
 * `servers.filter(s => s.status !== 'connected')` inline — which is correct on
 * the day it is written and is a second definition from then on. A grep is a
 * weak instrument, but the thing it is watching for is textual.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('the not-connected rule has one definition', () => {
  const files = [
    ...sourcesUnder(path.join(REPO, 'web', 'src')),
    ...sourcesUnder(path.join(REPO, 'shared', 'src')),
    ...sourcesUnder(path.join(REPO, 'server', 'src')),
  ];

  test('the scan actually reads the tree it claims to', () => {
    // Anti-vacuity, the same guard `projects_emit_site.test.ts` carries: a scan
    // that walks nothing reports zero violations and passes, which is
    // indistinguishable from a clean tree until the day it matters.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('shared', 'src', 'mcp_status.ts')))).toBe(true);
  });

  test('exactly one, and it is in shared/', () => {
    // Assembled at runtime so this file does not match its own scan — the same
    // trick `project_secret_shaped_test_data` uses for token-shaped fixtures.
    // Excluding test files instead would work and would be worse: it would put
    // every future test outside the scan's reach.
    const DEF = new RegExp(`export ${'function'} ${'notConnected'}\\b`);
    const definers = files.filter((f) => DEF.test(fs.readFileSync(f, 'utf8')));
    expect(definers.map((f) => path.relative(REPO, f))).toEqual([
      path.join('shared', 'src', 'mcp_status.ts'),
    ]);
  });

  test('nobody re-implements it inline', () => {
    const rule = new RegExp(`status\\s*!==\\s*['"]${'connected'}['"]`);
    const offenders = files
      .filter((f) => !f.endsWith(path.join('shared', 'src', 'mcp_status.ts')))
      // Tests are excluded HERE but not from the definition scan above, and the
      // asymmetry is deliberate. A test may legitimately assert on a status
      // comparison — `probe.test.ts` does, checking that a probe surfaced an
      // unhealthy server — and that is reading the rule, not re-defining it.
      // Shipping a second DEFINITION from a test file would still be caught.
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => rule.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});
