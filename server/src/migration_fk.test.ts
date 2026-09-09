import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { config } from './config.js';
import { closeDb, getDb } from './db.js';

/**
 * `Cebab-6fax.44` — migrations must not run under foreign-key enforcement.
 *
 * SQLite cannot `ALTER TABLE` most things, so the documented way to change a
 * table is: create `<t>_new`, copy, `DROP TABLE <t>`, rename. That procedure
 * requires `foreign_keys = OFF`, and `applyMigrations` wraps every file in a
 * transaction — where the pragma is a NO-OP. A migration author who writes
 * `PRAGMA foreign_keys = OFF` at the top of their file therefore gets no
 * error, no effect, and a `DROP TABLE` that cascade-deletes every child row,
 * inside a transaction that COMMITs clean.
 *
 * `038_mcp_trust_declaration_identity.sql` already performs that dance. It was
 * safe only because nothing references `mcp_trust`; `projects`, `sessions` and
 * `multi_agent_sessions` all have CASCADE children.
 *
 * The first two cases measure the MECHANISM in a scratch database rather than
 * asserting it from the header — it is the surprising half, and if a future
 * SQLite makes the in-transaction pragma work, the second case is what says
 * so. The last two pin our side: the ordering that keeps the dance safe, and
 * the runtime posture it must not have changed.
 */

const PARENT_CHILD = `
  CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE child (
    id        INTEGER PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
  );
  INSERT INTO parent (id, name) VALUES (1, 'p');
  INSERT INTO child (id, parent_id) VALUES (1, 1);
`;

/** The 12-step rebuild, as a migration file would write it. */
const REBUILD_PARENT = `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT, extra TEXT);
  INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
  DROP TABLE parent;
  ALTER TABLE parent_new RENAME TO parent;
`;

let scratchDir: string;

function scratchDb(): Database.Database {
  const db = new Database(path.join(scratchDir, `${Math.random().toString(36).slice(2)}.sqlite`));
  db.exec(PARENT_CHILD);
  return db;
}

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-migration-fk-'));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('the mechanism, measured', () => {
  test('with enforcement ON, the rebuild silently empties the child table', () => {
    // The failure this ordering exists to prevent, reproduced end to end: the
    // in-file pragma does nothing, the DROP cascades, and the transaction
    // commits without an error anywhere.
    const db = scratchDb();
    db.pragma('foreign_keys = ON');

    db.transaction(() => {
      db.exec(REBUILD_PARENT);
    })();

    // The pragma inside the transaction did not take: still on.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 0 });
    db.close();
  });

  test('with enforcement OFF, the same rebuild leaves the children alone', () => {
    // The other direction, and the whole reason for the ordering. If a future
    // SQLite honoured the in-transaction pragma, the case above would redden
    // and this one would still pass — which is the signal we would want.
    const db = scratchDb();
    db.pragma('foreign_keys = OFF');

    db.transaction(() => {
      db.exec(REBUILD_PARENT);
    })();

    expect(db.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('and Cebab applies its migrations that way', () => {
  const DB_TS = fileURLToPath(new URL('./db.ts', import.meta.url));

  test('the enforcement pragma comes after applyMigrations, not before it', () => {
    // A source-order check because the property is WHEN a pragma runs, and the
    // only behavioural observable would be a migration we have not written
    // yet. Reverting the move puts `foreign_keys = ON` back above the runner
    // and reddens this.
    const source = fs.readFileSync(DB_TS, 'utf8');
    const enforce = source.indexOf("db.pragma('foreign_keys = ON')");
    const apply = source.indexOf('applyMigrations(db)');
    expect(enforce, 'the enforcement pragma is gone — this gate is stale').toBeGreaterThan(-1);
    expect(apply, 'the migration runner call is gone — this gate is stale').toBeGreaterThan(-1);
    expect(enforce).toBeGreaterThan(apply);
  });

  test('a migration that left a dangling reference would refuse to open', () => {
    // Running with enforcement off trades one silent failure for another
    // unless something checks afterwards, so `foreign_key_check` sits between
    // the two. Asserted through the shipped schema: it must come back empty.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-fk-boot-'));
    const originalDataDir = config.dataDir;
    try {
      config.dataDir = path.join(tmpRoot, '.cebab');
      fs.mkdirSync(config.dataDir, { recursive: true });
      closeDb();
      const db = getDb();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // And the runtime posture is unchanged: every query after `getDb()`
      // returns still runs with enforcement on.
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      closeDb();
      config.dataDir = originalDataDir;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
