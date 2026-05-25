import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { setSetting } from './settings.js';
import { deleteTemplate, listTemplates, saveTemplate } from './templates.js';
import type { CustomLayout, MultiAgentTemplate } from '@cebab/shared/protocol';

/**
 * PR-6 — repo round-trip + defensive read coverage. Uses the same tmp-dir
 * isolation pattern as `multi_agent.test.ts` so DB writes don't leak.
 */

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-templates-repo-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('saveTemplate / listTemplates (PR-6 round-trip)', () => {
  test('orchestrator template without layout round-trips unchanged (backwards-compat)', () => {
    const after = saveTemplate({
      name: 'Plain orchestrator',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1, 2, 3],
      roles: { '1': 'first agent' },
    });
    expect(after).toHaveLength(1);
    const t = after[0]!;
    expect(t.mode).toBe('orchestrator');
    expect(t.layout).toBeUndefined();
    expect(t.roles).toEqual({ '1': 'first agent' });
    // Re-read via listTemplates returns the same row.
    expect(listTemplates()).toEqual(after);
  });

  test('custom template with layout round-trips', () => {
    const layout: CustomLayout = {
      kind: 'custom',
      positions: { '1': { x: 100, y: 50 }, '2': { x: 200, y: 150 } },
      edges: [],
      canvas: { w: 320, h: 240 },
    };
    const after = saveTemplate({
      name: 'Custom layout',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1, 2],
      layout,
    });
    expect(after[0]!.mode).toBe('custom');
    expect(after[0]!.layout).toEqual(layout);
    // Reading from a fresh listTemplates() call returns the same shape.
    const reread = listTemplates();
    expect(reread[0]!.layout).toEqual(layout);
  });

  test('upsert by name preserves id and overwrites layout', () => {
    const first = saveTemplate({
      name: 'Upsert me',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1],
      layout: { kind: 'custom', positions: { '1': { x: 0, y: 0 } } },
    });
    const id = first[0]!.id;
    const second = saveTemplate({
      name: 'Upsert me',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1, 2],
      layout: {
        kind: 'custom',
        positions: { '1': { x: 10, y: 10 }, '2': { x: 20, y: 20 } },
      },
    });
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(id);
    expect(second[0]!.participants).toEqual([1, 2]);
    expect(second[0]!.layout?.positions['2']).toEqual({ x: 20, y: 20 });
  });

  test('mixed list: chain + orchestrator + custom coexist', () => {
    saveTemplate({
      name: 'A chain',
      mode: 'chain',
      lifecycle: 'persistent',
      participants: [1, 2],
    });
    saveTemplate({
      name: 'A custom',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1],
      layout: { kind: 'custom', positions: {} },
    });
    saveTemplate({
      name: 'An orch',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1, 2, 3],
    });
    const list = listTemplates();
    expect(list.map((t) => t.mode).sort()).toEqual(['chain', 'custom', 'orchestrator']);
  });

  test('deleteTemplate removes a custom template by id', () => {
    const after = saveTemplate({
      name: 'Doomed custom',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1],
    });
    const remaining = deleteTemplate(after[0]!.id);
    expect(remaining).toEqual([]);
  });
});

describe('listTemplates defensive mode filter (PR-6)', () => {
  test('rows with unknown modes are dropped on read', () => {
    // Stash a fake row the legitimate setters can't produce (older client
    // wrote a value the new union doesn't recognize, or the JSON was
    // hand-edited). Cast through unknown so the test reflects the runtime
    // shape rather than asserting an invalid TS type.
    const planted = [
      {
        id: 'a',
        name: 'good',
        mode: 'orchestrator',
        lifecycle: 'persistent',
        participants: [1],
      },
      {
        id: 'b',
        name: 'bad',
        mode: 'totally-bogus',
        lifecycle: 'persistent',
        participants: [1],
      },
    ] as unknown as MultiAgentTemplate[];
    setSetting('multi_agent_templates', planted);
    const list = listTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('good');
  });

  test('non-array stored value yields empty list', () => {
    setSetting('multi_agent_templates', 'not an array' as unknown as MultiAgentTemplate[]);
    expect(listTemplates()).toEqual([]);
  });
});

// PR-7: per-template hopBudget round-trip + clamp.
describe('saveTemplate — PR-7 hopBudget', () => {
  test('persists a positive integer hopBudget through save + list', () => {
    saveTemplate({
      name: 'big-budget',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1],
      hopBudget: 50,
    });
    const list = listTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]!.hopBudget).toBe(50);
  });

  test('absent hopBudget stores as undefined (no clamping)', () => {
    saveTemplate({
      name: 'default-budget',
      mode: 'chain',
      lifecycle: 'persistent',
      participants: [1, 2],
    });
    expect(listTemplates()[0]!.hopBudget).toBeUndefined();
  });

  test('fractional input is floored', () => {
    saveTemplate({
      name: 'fractional',
      mode: 'chain',
      lifecycle: 'persistent',
      participants: [1, 2],
      // 17.9 → 17 (floor, not round) so the budget is never raised
      // above what the operator typed.
      hopBudget: 17.9,
    });
    expect(listTemplates()[0]!.hopBudget).toBe(17);
  });

  test('sub-1 / non-finite / non-number input is dropped to undefined', () => {
    const cases: Array<number | unknown> = [0, -3, 0.5, NaN, Infinity];
    cases.forEach((v, i) => {
      saveTemplate({
        name: `bad-${i}`,
        mode: 'chain',
        lifecycle: 'persistent',
        participants: [1, 2],
        hopBudget: v as number,
      });
    });
    const list = listTemplates();
    for (const t of list) {
      expect(t.hopBudget).toBeUndefined();
    }
  });

  test('upsert by name preserves the new hopBudget (overwrites prior)', () => {
    saveTemplate({
      name: 'tweak',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1],
      hopBudget: 10,
    });
    saveTemplate({
      name: 'tweak',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1],
      hopBudget: 30,
    });
    const list = listTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]!.hopBudget).toBe(30);
  });

  test('upsert without hopBudget clears a prior override (no preservation)', () => {
    // Editing a template via the roles editor sends `hopBudget: t.hopBudget`
    // explicitly to preserve. A different caller that omits the field is
    // taken at its word — undefined means "no per-template override".
    saveTemplate({
      name: 'wipe',
      mode: 'chain',
      lifecycle: 'persistent',
      participants: [1, 2],
      hopBudget: 7,
    });
    saveTemplate({
      name: 'wipe',
      mode: 'chain',
      lifecycle: 'persistent',
      participants: [1, 2],
      // hopBudget omitted
    });
    expect(listTemplates()[0]!.hopBudget).toBeUndefined();
  });
});
