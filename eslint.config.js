import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

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
      // (isValidBusRecipient, computeSessionPaths) before fs touches; the
      // structural invariant is covered by the F1 regression tests and
      // the Semgrep rule `cebab-writeInboxMessage-unhandled`. Out-of-the-
      // box this rule is a constant low-value alert source.
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
    // Repo-level Node launchers (scripts/*.mjs) are plain ESM with no
    // tsconfig, so `no-undef` has no TS lib to pull Node globals from.
    // Declare the handful they use — avoids adding a `globals` dep.
    files: ['scripts/**/*.mjs'],
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
