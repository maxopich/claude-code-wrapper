/**
 * [security] Register C21 + C11 — the two config changes whose whole value is
 * their scope, and which a later "simplification" would quietly undo.
 *
 * C21: `.gitleaks.toml` allow-listed the path pattern `.*\.test\.ts$`, which
 * exempted 161 of the repo's 256 test files from the secret scanner — in the
 * pre-commit hook AND in CI. It looked like it was working the whole time,
 * because `.test.tsx` and `.test.mjs` were never matched, so React component
 * tests kept getting scanned. Removing it cost five allowances by literal.
 *
 * C11: `server/tsconfig.json` emitted with no exclude, so 87 of 186 emitted
 * `.js` files in `dist/` were compiled tests — which is why `vitest.config.ts`
 * has to blacklist the dist directory. The obvious fix, adding an `exclude` to that
 * file, ALSO drops all 161 test files from `npm run typecheck`, since both
 * commands read it. Hence a separate build config, and hence the second half
 * of these assertions: the exclude must exist in one file and NOT in the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/**
 * Values of a TOML array, `#` comments dropped first — so a key named in the
 * prose above cannot be read as the key itself. Literal patterns rather than
 * `new RegExp(key)`: eslint's `security/detect-non-literal-regexp` rejects the
 * constructed form, and there are exactly two keys worth reading.
 */
const ARRAY_PATTERNS = {
  paths: /^paths\s*=\s*\[([\s\S]*?)^\]/m,
  regexes: /^regexes\s*=\s*\[([\s\S]*?)^\]/m,
};

function tomlArray(toml, key) {
  const body = toml
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const m = ARRAY_PATTERNS[key].exec(body);
  if (!m) return null;
  return [...m[1].matchAll(/'''([\s\S]*?)'''/g)].map((x) => x[1]);
}

describe('[security] gitleaks allow-list names files, never file classes', () => {
  const toml = read('.gitleaks.toml');

  it('the config parses and the allow-list is non-empty', () => {
    // Anti-vacuity: a renamed key would make every assertion below hold
    // against null, which is exactly how this kind of gate goes quiet.
    expect(toml).toContain('[allowlist]');
    expect(tomlArray(toml, 'paths')).not.toBeNull();
    expect(tomlArray(toml, 'regexes')).not.toBeNull();
  });

  it('no path pattern exempts a whole class of test files', () => {
    for (const p of tomlArray(toml, 'paths') ?? []) {
      expect(
        /test|spec/i.test(p),
        `allow-list path ${p} exempts test files by pattern. That is what hid ` +
          `161 of 256 test files from the scanner; allow the specific literal instead.`,
      ).toBe(false);
    }
  });

  it('the exemptions are specific literals, not wildcards', () => {
    const regexes = tomlArray(toml, 'regexes') ?? [];
    expect(regexes.length).toBeGreaterThan(0);
    for (const r of regexes) {
      // `.*` / `.+` in a secret allowance is a file-class exemption wearing a
      // different hat — it stops being an assertion about one fake string.
      expect(r.includes('.*') || r.includes('.+'), `allow-list regex ${r} is a wildcard`).toBe(
        false,
      );
      expect(r.length).toBeGreaterThan(12);
    }
  });
});

describe('[security] tests leave the build without leaving the typecheck', () => {
  const buildCfg = read('server/tsconfig.build.json');
  const baseCfg = read('server/tsconfig.json');
  const pkg = JSON.parse(read('server/package.json'));
  const root = JSON.parse(read('package.json'));

  it('the build config excludes compiled tests', () => {
    expect(buildCfg).toMatch(/"exclude"/);
    expect(buildCfg).toMatch(/\*\*\/\*\.test\.ts/);
  });

  it('the typecheck config does NOT exclude them', () => {
    // The half that matters. `npm run typecheck` is `tsc --noEmit -p server`,
    // so an exclude here silently stops checking every test file in the repo.
    expect(baseCfg).not.toMatch(/"exclude"/);
  });

  it('build uses the build config and typecheck uses the plain one', () => {
    expect(pkg.scripts.build).toContain('tsconfig.build.json');
    expect(root.scripts.typecheck).toContain('-p server');
    expect(root.scripts.typecheck).not.toContain('tsconfig.build.json');
  });
});

describe('formatting is enforced by something a plain install cannot skip', () => {
  const root = JSON.parse(read('package.json'));
  const ci = read('.github/workflows/ci.yml');

  it('the repo has a format check and CI runs it', () => {
    // The hook is not enough: `.npmrc` sets ignore-scripts=true, which
    // suppresses the `prepare` script that installs husky (register C14).
    expect(root.scripts['format:check']).toBeTruthy();
    expect(ci).toContain('npm run format:check');
  });

  it('the staged-file glob covers .mjs', () => {
    // Register C13. `scripts/` is all .mjs, and eslint.config.js has a
    // dedicated block for it that the hook never exercised.
    const globs = Object.keys(root['lint-staged']);
    const jsGlob = globs.find((g) => g.includes('ts,tsx'));
    expect(jsGlob).toBeDefined();
    expect(jsGlob).toContain('mjs');
  });
});
