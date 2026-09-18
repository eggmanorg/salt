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

const { mockSaveBatch, mockAuth } = vi.hoisted(() => ({
  mockSaveBatch: vi.fn(),
  mockAuth: { user: { uid: 'uid-daniel' } } as { user: { uid: string } | null },
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
// `startBatch` reads the signed-in uid for `startedBy` (issue #1406), so the service
// now imports the auth store — which pulls in `firebase.ts` unless it is mocked.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));

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
  mockAuth.user = { uid: 'uid-daniel' };
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

// ─── Who tapped Start (issue #1406) ──────────────────────────────────────────
//
// The other live fact the pure freeze cannot read for itself: the signed-in uid,
// which is what the weekly "what is drying" nudge is addressed to. Same join, same
// place, same reason as the kind above.
describe('startBatch — who started the run', () => {
  it('freezes the signed-in uid onto the run', async () => {
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });

    const batch = written();
    expect(batch.startedBy).toBe('uid-daniel');
    // Written, not defaulted, for the reason the kind above is.
    expect(Object.keys(batch)).toContain('startedBy');
  });

  it('writes null rather than an empty string when nobody is signed in', async () => {
    mockAuth.user = null;

    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });

    // `null`, not `''` — unlike `shoppingDays.setBy`. "Nobody recorded a starter" is
    // a real answer the nudge has to read, and a blank would be a second spelling
    // of it that the selection rule would then have to know about.
    expect(written().startedBy).toBeNull();
  });

  it('gates nothing — the document is otherwise identical either way', async () => {
    // The convention half of the rule-12 statement at `BatchSchema.startedBy`: this
    // uid is recorded and addressed to, never read to decide anything. Nothing else
    // on the frozen document moves when it changes, and no rule mentions it.
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });
    const signedIn = written();

    vi.clearAllMocks();
    mockSaveBatch.mockResolvedValue({ kind: 'ok', value: undefined });
    mockAuth.user = { uid: 'uid-someone-else' };
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });
    const otherPerson = written();

    expect({ ...otherPerson, id: '', startedBy: null, createdAt: '', updatedAt: '' }).toEqual({
      ...signedIn,
      id: '',
      startedBy: null,
      createdAt: '',
      updatedAt: '',
    });
  });
});
