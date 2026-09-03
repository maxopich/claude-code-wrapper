/**
 * [security] The cumulative schema pin.
 *
 * 41 migrations, 18 of which have a `*.schema.test.ts` pinning what they are
 * FOR. 001-022 and 024 have none, and writing shallow "the table exists" cases
 * for them would add 23 files that pin almost nothing — the per-migration tests
 * are behavioural (041 asserts the composite key that lets two workers park a
 * retry each) and cannot be bulk-generated.
 *
 * So this covers the other axis: the SHAPE of a fresh database after every
 * migration, all at once. What it catches is the change nobody meant — a new
 * migration altering a column on an old table, an edited `.sql` reshaping a
 * fresh install, a NOT NULL or DEFAULT quietly dropped. It says nothing about
 * intent, and that is the honest division of labour rather than a shortcut.
 *
 * WHEN THIS FAILS AND YOU ADDED A MIGRATION, that is the test working. READ THE
 * DIFF FIRST: it is the complete list of what your migration did to the schema,
 * which is exactly the review nobody otherwise performs. Then regenerate in the
 * SAME commit:
 *
 *     UPDATE_SCHEMA_SNAPSHOT=1 npx vitest run server/src/migrations/schema_snapshot.test.ts
 *
 * Regenerating to make a red go away without reading the diff is the one way to
 * make this file worthless.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../db.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { dumpSchema, type TableShape } from './schema_snapshot.js';

const SNAPSHOT = path.join(import.meta.dirname, 'schema_snapshot.json');

/**
 * Floors, because the failure this file is most likely to suffer is not a wrong
 * snapshot — it is a dump that returns nothing and compares equal to a snapshot
 * that also returns nothing. Set below the real figures (18 / 186 / 30) and far
 * above zero.
 */
const MIN_TABLES = 15;
const MIN_COLUMNS = 150;
const MIN_INDEXES = 20;

describe('[security] cumulative schema snapshot', () => {
  withTempDataDir('schema-snapshot');

  test('a fresh database matches the committed shape', () => {
    const actual = dumpSchema(getDb());

    if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') {
      fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }

    expect(fs.existsSync(SNAPSHOT), `${SNAPSHOT} is missing`).toBe(true);
    const expected: TableShape[] = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));

    // Compare table-by-table so a failure names the table rather than printing
    // a 30 KB diff of the whole schema.
    expect(actual.map((t) => t.name)).toEqual(expected.map((t) => t.name));
    const byName = new Map(expected.map((t) => [t.name, t]));
    for (const table of actual) {
      expect(table, `table "${table.name}" changed shape`).toEqual(byName.get(table.name));
    }
  });

  test('the dump actually read a schema — floors, not a tautology', () => {
    const actual = dumpSchema(getDb());
    expect(actual.length).toBeGreaterThanOrEqual(MIN_TABLES);
    expect(actual.reduce((n, t) => n + t.columns.length, 0)).toBeGreaterThanOrEqual(MIN_COLUMNS);
    expect(actual.reduce((n, t) => n + t.indexes.length, 0)).toBeGreaterThanOrEqual(MIN_INDEXES);
  });

  test('the snapshot is byte-stable — sorted, and not a record of migration order', () => {
    // `sqlite_master` returns creation order. If any sort were dropped, two
    // trees with identical schemas would diff by the sequence their migrations
    // ran in, and the file would churn on every reorder.
    const actual = dumpSchema(getDb());
    for (const t of actual) {
      expect(
        t.columns.map((c) => c.name),
        `${t.name} columns unsorted`,
      ).toEqual([...t.columns.map((c) => c.name)].sort());
      expect(
        t.indexes.map((i) => i.name),
        `${t.name} indexes unsorted`,
      ).toEqual([...t.indexes.map((i) => i.name)].sort());
    }
    expect(actual.map((t) => t.name)).toEqual([...actual.map((t) => t.name)].sort());
  });

  test('no internal sqlite_* objects leak into the pin', () => {
    // They are SQLite's, they appear and vanish with implementation details
    // (`sqlite_sequence` exists only once an AUTOINCREMENT table has a row),
    // and pinning them would make the snapshot flap. `npm run smoke` counts 19
    // tables where this counts 18 for exactly that reason.
    const actual = dumpSchema(getDb());
    expect(actual.filter((t) => t.name.startsWith('sqlite_'))).toEqual([]);
    for (const t of actual) {
      expect(t.indexes.filter((i) => i.name.startsWith('sqlite_'))).toEqual([]);
    }
  });
});
