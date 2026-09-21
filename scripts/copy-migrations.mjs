/**
 * Copy the server's `.sql` migrations next to the compiled build output.
 *
 *   node ../scripts/copy-migrations.mjs            # from server/, the build path
 *   node scripts/copy-migrations.mjs <src> <dest>  # explicit dirs (tests)
 *
 * WHY THIS EXISTS. `tsc` compiles `.ts` and copies nothing else, so a
 * `tsc`-built `server/dist/` had zero of the 41 `.sql` files the migration
 * runner reads. `db.ts`'s `resolveMigrationsDir()` tries `dist/migrations`
 * first and only reached its `../src/migrations` fallback — which is why the
 * TypeScript path (tsx) booted while the compiled path did not. This runs after
 * `tsc` in the server `build` script so the `dist/migrations` the runner's own
 * comment promises actually contains the files it applies.
 *
 * Pure Node, no shell, so it behaves identically on macOS, Linux and Windows —
 * same constraint as the other `scripts/*.mjs` launchers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copy every `*.sql` from `srcDir` into `destDir`, creating `destDir` if
 * needed. Returns the sorted list of filenames copied. Exported so the test
 * drives the real copier rather than a re-implementation that could drift.
 */
export function copyMigrations(srcDir, destDir) {
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  }
  return files;
}

// Only act as a CLI when invoked directly, not when imported by the test.
const invokedDirectly = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const srcDir = process.argv[2] ?? path.join(repoRoot, 'server', 'src', 'migrations');
  const destDir = process.argv[3] ?? path.join(repoRoot, 'server', 'dist', 'migrations');
  const copied = copyMigrations(srcDir, destDir);
  console.log(`[copy-migrations] copied ${copied.length} .sql file(s) → ${destDir}`);
}
