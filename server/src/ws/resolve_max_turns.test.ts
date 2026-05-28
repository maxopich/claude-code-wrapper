import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { setSetting } from '../repo/settings.js';
import { resolveMaxTurns } from './server.js';

// Cluster F Phase A1a — resolveMaxTurns precedence chain:
//   override (>= 1, finite) > DB setting 'max_turns' (>= 1, finite)
//     > MAX_TURNS env (>= 1, finite, parsed once at boot into config.maxTurns)
//     > built-in default (config.maxTurns)
//
// The env reading lives on `config.maxTurns` (initialized at module
// load), so per-test env mutation doesn't affect the resolver. Tests
// here cover the DB + override layers + the built-in fallback.

let tmpRoot: string;
let originalDataDir: string;
let originalMaxTurns: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-resolve-max-turns-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // runs migrations
  originalMaxTurns = config.maxTurns;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  config.maxTurns = originalMaxTurns;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveMaxTurns — precedence chain', () => {
  test('no DB setting + no override → built-in (config.maxTurns)', () => {
    // Fresh DB, no override passed.
    expect(resolveMaxTurns()).toBe(config.maxTurns);
  });

  test('DB setting > built-in when no override', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns()).toBe(200);
  });

  test('override > DB setting > built-in', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns(75)).toBe(75);
  });

  test('override is floored to integer', () => {
    expect(resolveMaxTurns(75.7)).toBe(75);
  });

  test('override = 0 falls back through (not valid)', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns(0)).toBe(200);
  });

  test('override = NaN falls back', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns(NaN)).toBe(200);
  });

  test('override = Infinity falls back', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns(Infinity)).toBe(200);
  });

  test('negative override falls back', () => {
    setSetting('max_turns', 200);
    expect(resolveMaxTurns(-10)).toBe(200);
  });

  test('undefined override does not error', () => {
    expect(resolveMaxTurns(undefined)).toBe(config.maxTurns);
  });

  test('DB setting at exact lower bound (1) is honored', () => {
    setSetting('max_turns', 1);
    expect(resolveMaxTurns()).toBe(1);
  });

  test('DB setting NaN/garbage ignored, falls back to built-in', () => {
    setSetting('max_turns', 'banana');
    expect(resolveMaxTurns()).toBe(config.maxTurns);
  });

  test('DB setting negative ignored', () => {
    setSetting('max_turns', -5);
    expect(resolveMaxTurns()).toBe(config.maxTurns);
  });

  test('override floors a fractional like 1.9 → 1', () => {
    expect(resolveMaxTurns(1.9)).toBe(1);
  });

  test('config.maxTurns mutation flows through when nothing else set', () => {
    // Simulate operator changing the env-derived built-in (not realistic,
    // but defends the resolver against accidental hardcoding of 50).
    config.maxTurns = 99;
    expect(resolveMaxTurns()).toBe(99);
  });
});
