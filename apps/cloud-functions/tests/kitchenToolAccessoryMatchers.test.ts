import { describe, expect, it } from 'vitest';

import {
  KITCHEN_TOOL_MATCHER_FIXUPS,
  planKitchenToolMatcherFixups,
} from '../scripts/lib/kitchenToolAccessoryMatchers.js';

// Regression coverage for the pure planning half of
// fix-kitchen-tool-accessory-matchers.ts (issue #1460/#1465). The script
// itself reaches Firestore at import time, so this exercises the only part a
// test can reach — see the module's own header for why the split exists.

describe('planKitchenToolMatcherFixups', () => {
  it('adds the matcher to a document that lacks it', () => {
    const existing = new Map([['whisk', []]]);
    const [step] = planKitchenToolMatcherFixups([{ id: 'whisk', matcher: 'egg whisk' }], existing);

    expect(step).toMatchObject({
      found: true,
      before: [],
      after: ['egg whisk'],
      alreadyPresent: false,
      needsWrite: true,
    });
  });

  it('is a no-op when the matcher is already present — idempotent re-run', () => {
    const existing = new Map([['whisk', ['egg whisk']]]);
    const [step] = planKitchenToolMatcherFixups([{ id: 'whisk', matcher: 'egg whisk' }], existing);

    expect(step).toMatchObject({
      found: true,
      before: ['egg whisk'],
      after: ['egg whisk'],
      alreadyPresent: true,
      needsWrite: false,
    });
  });

  it('unions onto whatever else the document already holds, rather than replacing the array', () => {
    const existing = new Map([['bowl', ['pudding basin']]]);
    const steps = planKitchenToolMatcherFixups([{ id: 'bowl', matcher: 'mixing bowl' }], existing);

    expect(steps[0]!.after).toEqual(['pudding basin', 'mixing bowl']);
  });

  it('reports a missing document as not-found, and proposes no write for it', () => {
    const existing = new Map<string, readonly string[]>();
    const [step] = planKitchenToolMatcherFixups([{ id: 'ladle', matcher: 'soup ladle' }], existing);

    expect(step).toMatchObject({
      found: false,
      before: null,
      after: null,
      alreadyPresent: false,
      needsWrite: false,
    });
  });

  it('plans the two real #1465 targets independently of each other', () => {
    const existing = new Map([
      ['whisk', ['egg whisk']], // staging's already-fixed state
      ['bowl', []], // staging's (and prod's) untouched state
    ]);
    const steps = planKitchenToolMatcherFixups(KITCHEN_TOOL_MATCHER_FIXUPS, existing);

    expect(steps.map((s) => [s.id, s.needsWrite])).toEqual([
      ['whisk', false],
      ['bowl', true],
    ]);
  });
});
