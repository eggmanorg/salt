import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Recipe } from '@salt/domain';
import type { BatchDoc, Formula } from '@salt/domain/schemas';

// The substitution seam (issue #1402, phase 3) — `startBatch` → `freezeBatch` → the
// document, and the one thing this layer decides for itself: THE LABEL.
//
// The sheet's own test proves the sheet hands the swap over. What matters here is
// that the frozen quantity names the product that ACTUALLY WENT ON. The recipe's
// word for that line is "2.5 g Prague powder #1" — a product this run did not open —
// so leaving it alone would make every screen that shows the run's quantities read
// as 26 g of a cure #1 nobody used, a month later, with no way to tell.
//
// The sibling of `batchServiceVessel.test.ts`, and the same shape: the absent case
// is half the point.

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
// `startBatch` reads the signed-in uid for `startedBy` (issue #1406), so the service
// now imports the auth store — which pulls in `firebase.ts` unless it is mocked.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: { uid: 'uid-1' } } }));

import { startBatch } from '../src/lib/batchService.js';

function ingredient(id: string, rawText: string) {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const RECIPE = {
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'cure',
  cureCategory: null,
  title: 'Coppa',
  description: null,
  ingredients: [
    {
      id: 'grp-1',
      name: null,
      items: [
        ingredient('ing-meat', '2.4 kg pork shoulder'),
        ingredient('ing-salt', '25 g fine sea salt'),
        ingredient('ing-cure', '2.5 g Prague powder #1'),
      ],
    },
  ],
  steps: [{ id: 'step-1', text: 'Rub and bag.', timer: null, note: null }],
  metadata: { servings: null, tags: [] },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as Recipe;

// The formula AS THE SHEET HANDS IT OVER: already substituted, because the
// substitution happens before the call. 2.6042% of nitrited curing salt, 0.1458% of
// plain salt left over.
const SUBSTITUTED = {
  recipeId: 'recipe-1',
  schemaVersion: 1,
  components: [
    { ingredientId: 'ing-meat', percent: 100, inBasis: true },
    { ingredientId: 'ing-salt', percent: 0.1458, inBasis: false, saltProduct: 'plain' },
    {
      ingredientId: 'ing-cure',
      percent: 2.6042,
      inBasis: false,
      saltProduct: 'nitritedCuringSalt',
      minPercent: 2,
      maxPercent: 3.15,
    },
  ],
  referenceYield: { kind: 'basis', grams: 1000 },
  process: [
    {
      id: 'stg-cure',
      label: 'Cure',
      kind: 'wait',
      environment: null,
      duration: { kind: 'fixed', minutes: 10080 },
      until: null,
      stepId: null,
    },
  ],
} as unknown as Formula;

const ANCHOR = { kind: 'startAt', at: '2026-08-14T20:00:00.000Z' } as const;

function written(): BatchDoc {
  return mockSaveBatch.mock.calls[0]![0] as BatchDoc;
}

function quantity(id: string) {
  const found = written().quantities.find((q) => q.ingredientId === id);
  if (found === undefined) throw new Error(`no quantity ${id}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveBatch.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('startBatch — the cure-salt substitution', () => {
  it('freezes which product replaced which', async () => {
    const result = await startBatch({
      recipe: RECIPE,
      formula: SUBSTITUTED,
      cureSaltSubstitution: { from: 'cure1', to: 'nitritedCuringSalt' },
      anchor: ANCHOR,
    });
    expect(result.kind).toBe('ok');
    expect(written().cureSaltSubstitution).toEqual({
      from: 'cure1',
      to: 'nitritedCuringSalt',
    });
  });

  it('labels the swapped line with what went on, not the recipe’s word for it', async () => {
    await startBatch({
      recipe: RECIPE,
      formula: SUBSTITUTED,
      cureSaltSubstitution: { from: 'cure1', to: 'nitritedCuringSalt' },
      anchor: ANCHOR,
    });
    // 26 g of the substitute, under the substitute's name. "2.5 g Prague powder #1"
    // beside 26 g would be a run reporting a product nobody opened.
    expect(quantity('ing-cure')).toMatchObject({
      label: 'Nitrited curing salt',
      grams: 26,
    });
    // EVERY OTHER LINE KEEPS THE RECIPE'S OWN WORDS. Only the line that was
    // substituted is renamed.
    expect(quantity('ing-meat').label).toBe('2.4 kg pork shoulder');
    expect(quantity('ing-salt')).toMatchObject({ label: '25 g fine sea salt', grams: 1.5 });
  });

  it('leaves the key off, and every label alone, for a run that swapped nothing', async () => {
    await startBatch({ recipe: RECIPE, formula: SUBSTITUTED, anchor: ANCHOR });
    // ABSENT, not empty and not null — `BatchSchema.cureSaltSubstitution` is
    // optional, and an empty object would read as a swap nobody made.
    expect('cureSaltSubstitution' in written()).toBe(false);
    expect(quantity('ing-cure').label).toBe('2.5 g Prague powder #1');
  });

  it('renames nothing when no component carries the substituted product', async () => {
    // The formula and the swap disagreeing — which the sheet cannot produce, since
    // it derives both from the same choice. Guarded rather than trusted: a label
    // lookup that found nothing must leave the recipe's own words alone rather than
    // renaming a line at random.
    const unsubstituted = {
      ...SUBSTITUTED,
      components: [
        { ingredientId: 'ing-meat', percent: 100, inBasis: true },
        { ingredientId: 'ing-cure', percent: 0.25, inBasis: false, saltProduct: 'cure1' },
      ],
    } as unknown as Formula;
    const result = await startBatch({
      recipe: RECIPE,
      formula: unsubstituted,
      cureSaltSubstitution: { from: 'cure1', to: 'nitritedCuringSalt' },
      anchor: ANCHOR,
    });
    expect(result.kind).toBe('ok');
    expect(quantity('ing-cure').label).toBe('2.5 g Prague powder #1');
    // The snapshot is still written — it is a note about the run, and the label
    // lookup failing says nothing about whether the swap happened.
    expect(written().cureSaltSubstitution).toEqual({ from: 'cure1', to: 'nitritedCuringSalt' });
  });

  it('still names the substitute when the line has left the recipe', async () => {
    // An ingredient edited out between the sheet opening and Start. The swapped line
    // is the one case where the label does NOT go blank: what went on the meat is
    // known from the product rather than from the recipe, so it is still said. Every
    // other vanished line falls back to `freezeBatch`'s empty label — "we no longer
    // know what this was", which is honest where an id is gibberish.
    const withoutCure = {
      ...RECIPE,
      ingredients: [
        {
          id: 'grp-1',
          name: null,
          items: [ingredient('ing-meat', '2.4 kg pork shoulder')],
        },
      ],
    } as unknown as Recipe;
    const result = await startBatch({
      recipe: withoutCure,
      formula: SUBSTITUTED,
      cureSaltSubstitution: { from: 'cure1', to: 'nitritedCuringSalt' },
      anchor: ANCHOR,
    });
    expect(result.kind).toBe('ok');
    expect(quantity('ing-cure').label).toBe('Nitrited curing salt');
    expect(quantity('ing-salt').label).toBe('');
  });
});
