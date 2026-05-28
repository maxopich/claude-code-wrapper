import { describe, expect, test } from 'vitest';
import {
  buildSdkSlashCommands,
  filterSlashCommands,
  SLASH_COMMANDS,
  type SlashCommand,
} from './slashCommands';

// Cluster E Phase 1 — slashCommands registry contract:
//   - SLASH_COMMANDS exposes the v0 Cebab quick-row vocabulary
//   - buildSdkSlashCommands dedupes against the Cebab list + sorts stably
//   - filterSlashCommands does case-insensitive substring match on
//     command + description

describe('SLASH_COMMANDS registry', () => {
  test('includes the Cebab quick-row commands', () => {
    const commands = SLASH_COMMANDS.map((c) => c.command);
    expect(commands).toContain('/context');
    expect(commands).toContain('/compact');
    expect(commands).toContain('/skills');
    expect(commands).toContain('/mcp');
    expect(commands).toContain('/cost');
  });

  test('every entry has source="cebab" (registry holds Cebab-local only)', () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.source, `${c.command}`).toBe('cebab');
    }
  });

  test('every entry has a non-empty description', () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.description.length, `${c.command}`).toBeGreaterThan(0);
    }
  });
});

describe('buildSdkSlashCommands', () => {
  test('returns empty array for undefined / empty input', () => {
    expect(buildSdkSlashCommands(undefined)).toEqual([]);
    expect(buildSdkSlashCommands([])).toEqual([]);
  });

  test('normalises commands to leading-slash form', () => {
    const out = buildSdkSlashCommands(['ide']);
    expect(out[0]?.command).toBe('/ide');
  });

  test('drops entries that collide with Cebab-local commands', () => {
    // /compact is Cebab-local; the SDK also exposing it should be dropped.
    const out = buildSdkSlashCommands(['compact', 'ide', '/mcp']);
    const commands = out.map((c) => c.command);
    expect(commands).not.toContain('/compact');
    expect(commands).not.toContain('/mcp');
    expect(commands).toContain('/ide');
  });

  test('returns SDK-sourced commands in alphabetical order', () => {
    const out = buildSdkSlashCommands(['/zebra', '/alpha', '/bravo']);
    expect(out.map((c) => c.command)).toEqual(['/alpha', '/bravo', '/zebra']);
  });

  test('sets source="sdk" and empty description', () => {
    const out = buildSdkSlashCommands(['/foo']);
    expect(out[0]).toMatchObject({ command: '/foo', source: 'sdk', description: '' });
  });
});

describe('filterSlashCommands', () => {
  const sample: SlashCommand[] = [
    { command: '/compact', label: '/compact', description: 'Compact the conversation', source: 'cebab' },
    { command: '/cost', label: '/cost', description: 'Show session cost', source: 'cebab' },
    { command: '/skills', label: '/skills', description: 'List available skills', source: 'cebab' },
  ];

  test('empty query returns all entries (in original order, new array)', () => {
    const out = filterSlashCommands(sample, '');
    expect(out).toEqual(sample);
    expect(out).not.toBe(sample);
  });

  test('whitespace-only query returns all entries', () => {
    expect(filterSlashCommands(sample, '   ')).toEqual(sample);
  });

  test('substring matches command', () => {
    const out = filterSlashCommands(sample, 'comp');
    expect(out.map((c) => c.command)).toEqual(['/compact']);
  });

  test('substring matches description', () => {
    const out = filterSlashCommands(sample, 'session');
    expect(out.map((c) => c.command)).toEqual(['/cost']);
  });

  test('case insensitive', () => {
    expect(filterSlashCommands(sample, 'SKILLS').map((c) => c.command)).toEqual(['/skills']);
    expect(filterSlashCommands(sample, 'COST').map((c) => c.command)).toEqual(['/cost']);
  });

  test('no match returns empty array', () => {
    expect(filterSlashCommands(sample, 'zzz')).toEqual([]);
  });
});
