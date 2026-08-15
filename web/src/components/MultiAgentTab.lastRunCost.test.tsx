// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentTemplate, TemplateLastRun } from '@cebab/shared/protocol';
import { TemplateLastRunRail } from './MultiAgentTab';

// F7: the "Last run" rail now reports what the run cost, because hops alone
// are a poor capacity signal — a 2k-token routing turn and a 180k-token
// analysis turn count the same.
//
// The distinction that matters, and the reason `totalCostUsd` is optional on
// the wire rather than defaulting to 0: a run that finished before cost
// accounting existed has UNKNOWN spend, not zero spend. Rendering "$0.0000"
// there would be a confident lie about a real bill.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const template: MultiAgentTemplate = {
  id: 't1',
  name: 'Review',
  mode: 'orchestrator',
  lifecycle: 'persistent',
  participants: [1, 2],
};

function lastRun(over: Partial<TemplateLastRun> = {}): TemplateLastRun {
  return {
    sessionId: 's1',
    startedAt: Date.now() - 3_600_000,
    endedAt: Date.now(),
    status: 'completed',
    hopsUsed: 7,
    hopBudget: 12,
    ...over,
  };
}

function renderRail(run: TemplateLastRun | null | undefined) {
  act(() => {
    root.render(<TemplateLastRunRail template={template} lastRun={run} />);
  });
}

describe('TemplateLastRunRail — run cost', () => {
  test('renders the recorded total to four decimals', () => {
    renderRail(lastRun({ totalCostUsd: 1.23456789 }));
    expect(container.querySelector('.tpl-preview-rail-cost')?.textContent).toContain('$1.2346');
    // Still shows hops — cost is an addition, not a replacement.
    expect(container.textContent).toContain('7/12 hops');
  });

  test('an absent total renders "cost n/a", never "$0.0000"', () => {
    renderRail(lastRun());
    const cost = container.querySelector('.tpl-preview-rail-cost');
    expect(cost?.textContent).toContain('cost n/a');
    expect(container.textContent).not.toContain('$0.0000');
    // The tooltip has to carry the distinction too — "unknown, not zero" is
    // the whole point and it is invisible from the two words alone.
    expect(cost?.getAttribute('title')).toMatch(/unknown \(not zero\)/);
  });

  test('a genuinely recorded small cost still renders as a number', () => {
    // Guards against "falsy means unknown" creeping back in: a sub-cent run
    // that WAS recorded must not be reported as unknown.
    renderRail(lastRun({ totalCostUsd: 0.00004 }));
    expect(container.querySelector('.tpl-preview-rail-cost')?.textContent).toContain('$0.0000');
    expect(container.textContent).not.toContain('cost n/a');
  });
});
