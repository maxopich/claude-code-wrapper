import type Database from 'better-sqlite3';

/**
 * A normalised, order-stable description of the schema a fresh database ends up
 * with after every migration has run.
 *
 * WHY A CUMULATIVE SNAPSHOT AND NOT MORE PER-MIGRATION TESTS. The per-migration
 * `*.schema.test.ts` files pin what a migration is FOR — 041 asserts the
 * composite primary key that lets two workers park a retry each, and reddens if
 * it regresses to session-only. Those are behavioural and cannot be
 * bulk-written; 001-022 and 024 have none, and generating shallow "the table
 * exists" cases for them would add files that pin almost nothing.
 *
 * This is the other axis: it says nothing about intent and everything about
 * SHAPE, for all 41 at once. What it catches is the change nobody meant — a new
 * migration altering a column on an old table, an edited `.sql` that reshapes
 * a fresh install, a DEFAULT or NOT NULL quietly dropped.
 *
 * It does NOT replace `migration_integrity.ts`, which hashes normalised SQL per
 * file to catch an edit to an already-applied migration. That runs at boot on a
 * real install and answers "did this database get the migration the file now
 * describes?". This runs in CI on a fresh database and answers "is the schema
 * still the shape we agreed on?". Neither implies the other: a comment-only
 * edit moves neither, and an edit that reshapes a table moves both — for
 * different reasons and on different machines.
 */
export type ColumnShape = {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt: string | null;
  pk: number;
};

export type TableShape = {
  name: string;
  columns: ColumnShape[];
  indexes: { name: string; unique: 0 | 1; columns: string[] }[];
};

/**
 * Byte-order comparison, deliberately NOT `localeCompare`.
 *
 * Collation is supplied by the ENVIRONMENT — ICU data, locale, Node build — so
 * a `localeCompare` sort can order two identical schemas differently on a
 * developer's machine and on a CI runner, and the snapshot would diff for a
 * reason that has nothing to do with the schema. Same family as the CRLF and
 * timezone traps this repo has already paid for.
 */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Rows SQLite creates for itself; not ours to pin. */
const INTERNAL = (name: string): boolean => name.startsWith('sqlite_');

/**
 * Sorted everywhere, because `sqlite_master` order follows creation order and
 * that would make the snapshot a record of migration SEQUENCE rather than of
 * shape — two trees with identical schemas would diff.
 */
export function dumpSchema(db: Database.Database): TableShape[] {
  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .all()
    .map((r) => r.name)
    .filter((n) => !INTERNAL(n));

  return tables.map((name) => {
    const columns = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
      >(`PRAGMA table_info(${JSON.stringify(name)})`)
      .all()
      .map((c) => ({
        name: c.name,
        type: c.type,
        notnull: (c.notnull ? 1 : 0) as 0 | 1,
        dflt: c.dflt_value,
        pk: c.pk,
      }))
      .sort(byName);

    const indexes = db
      .prepare<[], { name: string; unique: number }>(`PRAGMA index_list(${JSON.stringify(name)})`)
      .all()
      .filter((i) => !INTERNAL(i.name))
      .map((i) => ({
        name: i.name,
        unique: (i.unique ? 1 : 0) as 0 | 1,
        columns: db
          .prepare<[], { name: string | null }>(`PRAGMA index_info(${JSON.stringify(i.name)})`)
          .all()
          .map((c) => c.name ?? '<expr>'),
      }))
      .sort(byName);

    return { name, columns, indexes };
  });
}
