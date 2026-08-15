import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '.husky/**',
      // Claude Code's local state. Worktrees in particular shadow every
      // .ts in the repo and cause tseslint to bail with "multiple
      // candidate tsconfigRootDirs". Never user-authored code.
      '.claude/**',
      // Semgrep rule fixtures. `.semgrep/cebab-bus.ts` exists to contain
      // deliberate violations (undefined identifiers, a non-literal spawn)
      // so `semgrep --test` can prove each rule still fires. Nothing imports
      // or compiles it, and linting it would report exactly the problems it
      // is built out of.
      '.semgrep/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Generic Node smells: eval, child_process with non-literal, weak
  // randomness, unsafe regex, etc. Plan: T2.5(B).
  security.configs.recommended,
  // DOM-side XSS guard for the web/ workspace; cheap to leave on globally.
  noUnsanitized.configs.recommended,
  {
    // Tune the security plugin's noisier rules. `detect-object-injection`
    // is famously FP-prone — it flags any `arr[i]` / `obj[key]` pattern
    // regardless of whether the index/key is operator-controlled. The
    // rules left enabled (eval, non-literal-regexp, child-process,
    // pseudoRandomBytes, unsafe-regex, etc.) are the ones that carry
    // their weight at our codebase scale.
    rules: {
      'security/detect-object-injection': 'off',
      // `detect-non-literal-fs-filename` flags any `fs.X(variable)` call.
      // Cebab's bus and workspace modules thread paths through validators
      // (isValidBusRecipient, computeSessionPaths) before fs touches, and
      // that is covered by the paths.test.ts / runtime.test.ts regression
      // suites. Out-of-the-box this rule is a constant low-value alert
      // source. (This comment used to also cite a Semgrep rule as backup;
      // that rule had been dead since the bus rewrite and was removed in the
      // same change as this edit — an exemption resting on retired coverage.)
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // Cebab-1uk: dependency-array lint for the ~175 hook call sites in web/.
    // PR #322 fixed five of these BY HAND (an effect keyed on an object
    // identity, a useCallback depending on arrays that churn, an effect
    // depending on a whole props object); nothing stopped the sixth.
    //
    // SCOPED to web/ because that is where React lives — measured: zero hook
    // call sites in server/src or shared/src.
    //
    // RULES ARE NAMED, NOT PRESET. `reactHooks.configs.recommended` enables
    // SIXTEEN rules, fourteen of which are React Compiler rules
    // (purity, immutability, set-state-in-effect, static-components, …) — v7
    // bundles the compiler linter, which is why installing it pulls in
    // @babel/core and hermes-parser. Naming the two rules we want means a
    // future major cannot silently widen what `--max-warnings 0` enforces on
    // an `npm update`. Same posture as `security.configs.recommended` above,
    // which is loaded and then tuned down rule by rule.
    //
    // POSTURE: both at 'error', repo-wide within web/, no directory allowlist.
    // The alternative (an allowlist that grows per PR) was rejected once the
    // count came in: 13 exhaustive-deps findings across 6 of 13 directories,
    // and the dirty set included web/src itself — an allowlist would have
    // covered almost nothing while looking like coverage. Where an omission is
    // deliberate it carries an `eslint-disable-next-line` AT THE SITE with the
    // reason, which is greppable from the code; an allowlist in this file is
    // not. `--max-warnings 0` is untouched and stays that way.
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Repo-level Node launchers (scripts/*.mjs) are plain ESM with no
    // tsconfig, so `no-undef` has no TS lib to pull Node globals from.
    // Declare the handful they use — avoids adding a `globals` dep.
    // `vitest.setup.mjs` is the same shape — a root-level plain-ESM launcher
    // with no tsconfig — so it needs the same globals. It is NOT matched by
    // the `**/*.config.mjs` ignore above, and should not be: it is real code
    // that runs before every test.
    files: ['scripts/**/*.mjs', 'vitest.setup.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
