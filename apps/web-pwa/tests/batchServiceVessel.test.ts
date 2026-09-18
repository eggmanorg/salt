import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Recipe } from '@salt/domain';
import type { BatchDoc, Formula } from '@salt/domain/schemas';

// The vessel seam (issue #1274) — `startBatch` → `freezeBatch` → the document.
//
// The bake sheet's own test proves the sheet HANDS a vessel over; this proves the
// service carries it through to what is actually written, and — the half that
// matters — that the two answers naming no vessel leave the key OFF the document
// rather than writing an empty string. An empty vessel would read on the batch
// page as a run baked in something nobody described.
//
// `startBatch` had no direct test before this; every other path into it is
// covered through the sheet, which mocks the service out.

const { mockSaveBatch } = vi.hoisted(() => ({
  mockSaveBatch: vi.fn(),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeBatches: vi.fn(() => vi.fn()),
  subscribeBatch: vi.fn(() => vi.fn()),
  saveBatch: mockSaveBatch,
  callProposeSchedule: vi.fn(),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ reportError: vi.fn() })),
}));

import { startBatch } from '../src/lib/batchService.js';

const RECIPE = {
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'recipe',
  cureCategory: null,
  title: 'Overnight white tin',
  description: null,
  ingredients: [
    {
      id: 'grp-1',
      name: null,
      items: [
        {
          id: 'ing-flour',
          rawText: '500 g strong white flour',
          parsed: null,
          canonId: null,
          matchState: 'matched' as const,
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  steps: [{ id: 'step-1', text: 'Mix.', timer: null, note: null }],
  metadata: { servings: null, tags: [] },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as Recipe;

const FORMULA = {
  recipeId: 'recipe-1',
  schemaVersion: 1,
  components: [{ ingredientId: 'ing-flour', percent: 100, inBasis: true }],
  referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
  process: [
    {
      id: 'stg-bulk',
      label: 'Bulk',
      kind: 'wait',
      environment: null,
      duration: { kind: 'fixed', minutes: 180 },
      until: null,
      stepId: null,
    },
  ],
} as unknown as Formula;

const ANCHOR = { kind: 'startAt', at: '2026-08-14T20:00:00.000Z' } as const;

function written(): BatchDoc {
  return mockSaveBatch.mock.calls[0]![0] as BatchDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveBatch.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('startBatch — the vessel', () => {
  it('freezes the descriptor onto the document, untouched', async () => {
    const result = await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      vessel: '900 g loaf tin',
      anchor: ANCHOR,
    });
    expect(result.kind).toBe('ok');
    // Verbatim: nothing parses it, nothing normalises it, nothing computes from it.
    expect(written().vessel).toBe('900 g loaf tin');
  });

  it('leaves the key off entirely when the run named no vessel', async () => {
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });
    // ABSENT, not empty and not null — `BatchSchema.vessel` is optional, and a
    // blank string would read on the batch page as an unnamed vessel.
    expect('vessel' in written()).toBe(false);
  });

  it('does not put the vessel anywhere near the frozen figures', async () => {
    await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      vessel: '900 g loaf tin',
      anchor: ANCHOR,
    });
    const batch = written();
    // It sits beside `recipeTitle`, not inside `totals` — the grams already say
    // how much, and a vessel inside them would be a second figure free to drift.
    expect(Object.keys(batch.totals)).toEqual(['basisGrams', 'totalGrams', 'usableGrams', 'units']);
    expect(batch.totals.units).toEqual({ count: 1, unitDoughGrams: 900 });
  });
});

// ─── What the run WAS (issue #1404) ──────────────────────────────────────────
//
// `startBatch` is the ONLY place a batch is created, and the freeze is pure — it
// holds no recipe and cannot read one. So the join lives here, exactly as the
// title's does, and these are the tests that stop it being dropped.
describe('startBatch — the kind and the category', () => {
  it('freezes both off the recipe it was handed', async () => {
    await startBatch({
      recipe: {
        ...RECIPE,
        kind: 'cure',
        title: 'Coppa',
        cureCategory: 'dry_cured_whole_muscle',
      } as unknown as typeof RECIPE,
      formula: FORMULA,
      anchor: ANCHOR,
    });

    const batch = written();
    expect(batch.recipeKind).toBe('cure');
    expect(batch.cureCategory).toBe('dry_cured_whole_muscle');
    // Beside the title, and for the same reason: the run answers for itself
    // afterwards, whatever happens to the dish.
    expect(batch.recipeTitle).toBe('Coppa');
  });

  it('records a bread run as what it is, rather than leaving the fields out', async () => {
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });

    const batch = written();
    expect(batch.recipeKind).toBe('recipe');
    expect(batch.cureCategory).toBeNull();
    // Written, not defaulted: the schema's read default is for documents stored
    // before the fields existed, never for one being created now.
    expect(Object.keys(batch)).toContain('recipeKind');
    expect(Object.keys(batch)).toContain('cureCategory');
  });
});
