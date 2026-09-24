/**
 * The authority-cache writer carries MCP scope labels across snapshots
 * (Cebab-ajvv).
 *
 * The probe is the only spawn that captures scope labels; a real turn's
 * `session_started` carries none and REPLACES the snapshot. Without the
 * carry-over, sending one message after a probe would erase every label the
 * probe set. These pin the four behaviours that keeps.
 */
import { describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { cacheSessionStarted, type CachedSessionStarted } from './authority_cache.js';

/** A `session_started` shaped only as far as `cacheSessionStarted` reads it. */
function started(projectId: number, servers: { name: string; status: string }[]): ServerMsg {
  return {
    type: 'session_started',
    projectId,
    sessionId: 's1',
    mcpServers: servers,
  } as unknown as ServerMsg;
}

describe('cacheSessionStarted carries MCP scope labels', () => {
  test("a real turn after a probe keeps the probe's labels", () => {
    const cache = new Map<number, CachedSessionStarted>();
    // The selection probe captures the label.
    cacheSessionStarted(
      cache,
      started(1, [{ name: 'claude.ai Mail', status: 'pending' }]),
      new Map([['claude.ai Mail', 'claudeai']]),
    );
    expect(cache.get(1)!.mcpScopes!.get('claude.ai Mail')).toBe('claudeai');

    // A real turn re-writes the snapshot with NO fresh scopes. Reddens if the
    // carry-over is removed: the label would vanish.
    cacheSessionStarted(cache, started(1, [{ name: 'claude.ai Mail', status: 'connected' }]));
    expect(cache.get(1)!.mcpScopes!.get('claude.ai Mail')).toBe('claudeai');
  });

  test('a server missing from the newer init loses its label', () => {
    const cache = new Map<number, CachedSessionStarted>();
    cacheSessionStarted(
      cache,
      started(1, [{ name: 'gone', status: 'pending' }]),
      new Map([['gone', 'claudeai']]),
    );
    expect(cache.get(1)!.mcpScopes!.get('gone')).toBe('claudeai');

    // The next init does not mention 'gone', and nothing else carries a label.
    cacheSessionStarted(cache, started(1, [{ name: 'other', status: 'connected' }]));
    expect(cache.get(1)!.mcpScopes).toBeUndefined();
  });

  test('a fresh capture replaces a carried label', () => {
    const cache = new Map<number, CachedSessionStarted>();
    cacheSessionStarted(
      cache,
      started(1, [{ name: 'srv', status: 'pending' }]),
      new Map([['srv', 'user']]),
    );
    expect(cache.get(1)!.mcpScopes!.get('srv')).toBe('user');

    cacheSessionStarted(
      cache,
      started(1, [{ name: 'srv', status: 'connected' }]),
      new Map([['srv', 'project']]),
    );
    expect(cache.get(1)!.mcpScopes!.get('srv')).toBe('project');
  });

  test('a server named constructor is never labelled from the prototype', () => {
    const cache = new Map<number, CachedSessionStarted>();
    // A prior snapshot exists (so the carry-over source is populated) but has no
    // label for 'constructor'.
    cacheSessionStarted(
      cache,
      started(1, [{ name: 'real', status: 'connected' }]),
      new Map([['real', 'user']]),
    );
    // The new init names a server literally called `constructor`, with no fresh
    // label. A Map lookup returns undefined; a plain-object carry-over would
    // return Object.prototype.constructor and label it.
    cacheSessionStarted(cache, started(1, [{ name: 'constructor', status: 'connected' }]));
    expect(cache.get(1)!.mcpScopes).toBeUndefined();
  });
});
