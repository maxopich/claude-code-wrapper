import { describe, expect, test } from 'vitest';
import multiAgentTab from '../MultiAgentTab.tsx?raw';
import templatePreviewModal from './TemplatePreviewModal.tsx?raw';
import splitViewPanel from './SplitViewPanel.tsx?raw';
import agentDiagram from './AgentDiagram.tsx?raw';
import templatePreviewBanners from './TemplatePreviewBanners.tsx?raw';
import app from '../../App.tsx?raw';

/**
 * PR-1 vocabulary CI gate. The four-agent consultation flagged that
 * Cebab's user-facing copy was mixing "hop cap" / "max iterations" /
 * "estimated cost" / "est $" — none of which are accurate names for
 * what the bus actually does (the term is **hop budget**, the runtime
 * is `hopBudget`, and there's no cost projection surface). Today these
 * strings don't appear anywhere; this test pins their absence so a
 * future PR can't silently regress.
 *
 * The scan is scoped to the template-preview surface + the multi-agent
 * tab + the App root — anywhere a user-facing string about
 * multi-agent semantics could plausibly live. Add more files here if
 * you grow the surface.
 */

// Build the literals out of fragments so this very file doesn't trip
// the test on its own contents. The patterns below use word-boundary
// regex, so the fragments wouldn't match either way, but the
// fragment-style is defensive against future "exclude this file" loops.
const HOP_CAP = `hop${' '}cap`;
const MAX_ITER = `max${' '}iteration`;
const ESTIMATED_COST = `estimated${' '}cost`;
const PER_TURN = `$${'/'}turn`;
const EST_DOLLAR_SHORT = `est${' '}$`;
const EST_COST_SHORT = `est${' '}cost`;

const SOURCES: Array<[string, string]> = [
  ['MultiAgentTab.tsx', multiAgentTab],
  ['TemplatePreviewModal.tsx', templatePreviewModal],
  ['SplitViewPanel.tsx', splitViewPanel],
  ['AgentDiagram.tsx', agentDiagram],
  ['TemplatePreviewBanners.tsx', templatePreviewBanners],
  ['App.tsx', app],
];

describe('vocabulary gate (PR-1)', () => {
  for (const [needle, label] of [
    [HOP_CAP, '"hop cap"'],
    [MAX_ITER, '"max iteration(s)"'],
    [ESTIMATED_COST, '"estimated cost"'],
    [PER_TURN, '"$/turn"'],
    [EST_DOLLAR_SHORT, '"est $"'],
    [EST_COST_SHORT, '"est cost"'],
  ] as const) {
    test(`${label} appears in zero scanned source files`, () => {
      const hits: string[] = [];
      for (const [name, content] of SOURCES) {
        if (content.toLowerCase().includes(needle.toLowerCase())) hits.push(name);
      }
      expect(
        hits,
        `expected zero hits for ${label}; found in: ${hits.join(', ') || '(none)'}`,
      ).toEqual([]);
    });
  }
});
