import { describe, expect, it } from 'vitest';

import { diffKitEntries, planKitRerun } from '../scripts/lib/kitRerunPlan.js';
import type { KitEntrySnapshot, RecipeKitSnapshot } from '../scripts/lib/kitRerunPlan.js';

// Regression coverage for the pure half of rerun-recipe-kits.ts (issue #1465,
// Phase 4). The script itself reaches Firestore at import time, so this exercises
// the only part a test can reach — see the module's own header for why the split
// exists (docs/one-shot-scripts.md §2).

const PAN: KitEntrySnapshot = { label: 'frying pan', equipment: null };
const LINKED_PAN: KitEntrySnapshot = {
  label: 'frying pan',
  equipment: { itemId: 'eq-pans', accessoryId: 'acc-tefal' },
};

function recipe(overrides: Partial<RecipeKitSnapshot> = {}): RecipeKitSnapshot {
  return {
    id: 'r1',
    title: 'Omelette',
    kit: [PAN],
    kitInferredAt: null,
    kind: 'recipe',
    stepCount: 3,
    ...overrides,
  };
}

describe('planKitRerun', () => {
  it('targets a recipe with a non-empty kit', () => {
    expect(planKitRerun([recipe()], null)[0]).toMatchObject({ id: 'r1', skip: null });
  });

  it('leaves a recipe with no kit alone — the flow was already asked and said nothing', () => {
    expect(planKitRerun([recipe({ kit: [] })], null)[0]).toMatchObject({ skip: 'empty-kit' });
  });

  // PR #1483 review, should-fix 4: these two mirror the trigger's own guards in
  // `maybeInferKit` (`onRecipeWritten.ts`) — a recipe in either state has a stale
  // kit the trigger will decline to touch, forever, so targeting it would only
  // clear its stamp and burn the whole stamp-wait timeout for nothing.
  it('skips a recipe the trigger would decline as not cookable', () => {
    const steps = planKitRerun([recipe({ kind: 'special' })], null);
    expect(steps[0]).toMatchObject({ skip: 'not-cookable' });
  });

  it('skips a recipe the trigger would decline for having no steps', () => {
    const steps = planKitRerun([recipe({ stepCount: 0 })], null);
    expect(steps[0]).toMatchObject({ skip: 'no-steps' });
  });

  it('reports every recipe, skipped ones included, so the counts add up', () => {
    const steps = planKitRerun([recipe(), recipe({ id: 'r2', kit: [] })], null);
    expect(steps.map((s) => [s.id, s.skip])).toEqual([
      ['r1', null],
      ['r2', 'empty-kit'],
    ]);
  });

  it('skips a recipe already stamped at or after --since — an interrupted run resumes', () => {
    const steps = planKitRerun([recipe({ kitInferredAt: 2_000 })], 2_000);
    expect(steps[0]).toMatchObject({ skip: 'already-rerun' });
  });

  it('re-targets a recipe stamped BEFORE --since', () => {
    const steps = planKitRerun([recipe({ kitInferredAt: 1_999 })], 2_000);
    expect(steps[0]).toMatchObject({ skip: null });
  });

  it('re-targets a recipe whose inference failed — no stamp, so a resume retries it', () => {
    const steps = planKitRerun([recipe({ kitInferredAt: null })], 2_000);
    expect(steps[0]).toMatchObject({ skip: null });
  });

  it('ignores stamps entirely on a first pass (--since absent)', () => {
    const steps = planKitRerun([recipe({ kitInferredAt: Date.now() })], null);
    expect(steps[0]).toMatchObject({ skip: null });
  });
});

describe('diffKitEntries', () => {
  it('reports a line that gained a link — the point of the whole re-run', () => {
    const diff = diffKitEntries([PAN], [LINKED_PAN]);
    expect(diff.changed).toBe(true);
    expect(diff.relinked).toEqual([
      { label: 'frying pan', before: null, after: { itemId: 'eq-pans', accessoryId: 'acc-tefal' } },
    ]);
    expect(diff.unchanged).toBe(0);
  });

  it('reports nothing when the same labels come back with the same links', () => {
    const diff = diffKitEntries([LINKED_PAN], [LINKED_PAN]);
    expect(diff).toMatchObject({ changed: false, unchanged: 1 });
  });

  it('is insensitive to case and inner whitespace alone', () => {
    const diff = diffKitEntries([{ label: 'Frying  Pan', equipment: null }], [PAN]);
    expect(diff).toMatchObject({ changed: false, unchanged: 1 });
  });

  it('reads a reworded line as one removed plus one added, not as a rename', () => {
    const diff = diffKitEntries([PAN], [{ label: 'large frying pan', equipment: null }]);
    expect(diff.removed.map((e) => e.label)).toEqual(['frying pan']);
    expect(diff.added.map((e) => e.label)).toEqual(['large frying pan']);
    expect(diff.relinked).toEqual([]);
  });

  it('distinguishes a re-link from a re-point to a different entry of the same record', () => {
    const toFamily: KitEntrySnapshot = {
      label: 'frying pan',
      equipment: { itemId: 'eq-pans', accessoryId: null },
    };
    expect(diffKitEntries([LINKED_PAN], [toFamily]).relinked).toHaveLength(1);
  });

  it('counts a duplicated label as one addition rather than a re-link of its twin', () => {
    const diff = diffKitEntries([PAN], [PAN, LINKED_PAN]);
    expect(diff.unchanged).toBe(1);
    expect(diff.added).toEqual([LINKED_PAN]);
    expect(diff.relinked).toEqual([]);
  });

  it('counts a de-duplicated label as one removal', () => {
    const diff = diffKitEntries([PAN, PAN], [PAN]);
    expect(diff.unchanged).toBe(1);
    expect(diff.removed).toHaveLength(1);
  });

  it('handles an empty kit coming back populated', () => {
    const diff = diffKitEntries([], [LINKED_PAN]);
    expect(diff).toMatchObject({ changed: true, unchanged: 0 });
    expect(diff.added).toEqual([LINKED_PAN]);
  });
});
