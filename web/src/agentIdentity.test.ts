import { describe, expect, test } from 'vitest';
import { agentIdentity } from './agentIdentity';

describe('agentIdentity', () => {
  test('routing sentinels + orchestrator render as neutral chrome', () => {
    for (const slug of ['_sink', 'user', 'cebab', 'orchestrator']) {
      const id = agentIdentity(slug);
      expect(id.neutral).toBe(true);
      expect(id.hueVar).toBeNull();
      expect(id.glyph).toBe('◇');
      expect(id.label).toBe(slug);
    }
  });

  test('isOrchestratorChrome forces chrome even for a peer-looking slug', () => {
    const id = agentIdentity('some-worker', { isOrchestratorChrome: true });
    expect(id.neutral).toBe(true);
    expect(id.hueVar).toBeNull();
  });

  test('a peer slug gets a STRICT4 hue var and a glyph from the set', () => {
    const id = agentIdentity('coder');
    expect(id.neutral).toBe(false);
    expect(id.hueVar).toMatch(/^var\(--agent-[0-3]\)$/);
    expect('●▲■◆▼★⬟⬢').toContain(id.glyph);
    expect(id.label).toBe('coder');
  });

  test('identity is deterministic across calls (stable per session)', () => {
    expect(agentIdentity('reviewer')).toEqual(agentIdentity('reviewer'));
    expect(agentIdentity('alpha')).toEqual(agentIdentity('alpha'));
  });

  test('distinct slugs are distributed across more than one hue', () => {
    const slugs = ['coder', 'reviewer', 'planner', 'tester', 'docs', 'infra', 'qa', 'design'];
    const hues = new Set(slugs.map((s) => agentIdentity(s).hueVar));
    expect(hues.size).toBeGreaterThan(1);
    // Every peer hue is one of the locked STRICT4 slots.
    for (const h of hues) expect(h).toMatch(/^var\(--agent-[0-3]\)$/);
  });
});
