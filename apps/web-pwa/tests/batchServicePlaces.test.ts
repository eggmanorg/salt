import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Recipe } from '@salt/domain';
import type { BatchDoc, EquipmentItemDoc, Formula } from '@salt/domain/schemas';

// Resolving a picked place into the snapshot a run freezes (issue #1286) — the
// seam between the bake sheet's picker and `freezeBatch`.
//
// The sheet's own test proves it HANDS ids over; this proves what `startBatch`
// turns them into, and it is where the two claims that are not enforced by any
// type live:
//
//   • a SHARED place freezes the chamber's own `standing` and never the figure the
//     stage asked for — the curing chamber's setting belongs to the chamber;
//   • an id the manifest cannot resolve is DROPPED and the stage is kept.
//
// Sibling of `batchServiceVessel.test.ts`, same mocking.

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

// Two stages, so the positional alignment has somewhere to go wrong.
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
      environment: {
        temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
        equipmentId: null,
      },
      duration: { kind: 'fixed', minutes: 180 },
      until: null,
      stepId: null,
    },
    {
      id: 'stg-cure',
      label: 'Cure',
      kind: 'wait',
      environment: {
        temperature: { kind: 'fixed', celsius: 20 },
        relativeHumidityPercent: 60,
        equipmentId: null,
      },
      duration: { kind: 'fixed', minutes: 60 },
      until: null,
      stepId: null,
    },
  ],
} as unknown as Formula;

const ANCHOR = { kind: 'startAt', at: '2026-08-14T20:00:00.000Z' } as const;

const PROOFER = {
  id: 'eq-proofer',
  schemaVersion: 1,
  name: 'Dough proofer',
  accessories: [],
  rules: [],
  environment: {
    control: 'dedicated',
    minCelsius: 20,
    maxCelsius: 40,
    humidity: null,
    standing: null,
  },
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as EquipmentItemDoc;

const CURING = {
  id: 'eq-curing',
  schemaVersion: 1,
  name: 'Curing chamber',
  accessories: [],
  rules: [],
  environment: {
    control: 'shared',
    minCelsius: 8,
    maxCelsius: 16,
    humidity: { precision: 'controlled', minPercent: 60, maxPercent: 85 },
    standing: { celsius: 12, relativeHumidityPercent: 75 },
  },
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as EquipmentItemDoc;

const KNIFE_BLOCK = {
  id: 'eq-knives',
  schemaVersion: 1,
  name: 'Knife block',
  accessories: [],
  rules: [],
  environment: null,
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as EquipmentItemDoc;

function written(): BatchDoc {
  return mockSaveBatch.mock.calls[0]![0] as BatchDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveBatch.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('startBatch — the place a stage happened in', () => {
  it('freezes a DEDICATED place at what the stage asked for', async () => {
    await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      anchor: ANCHOR,
      stagePlaceIds: ['eq-proofer', null],
      equipment: [PROOFER, CURING],
    });
    expect(written().stages[0]?.place).toEqual({
      equipmentId: 'eq-proofer',
      label: 'Dough proofer',
      temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
      relativeHumidityPercent: null,
    });
    expect(written().stages[1]?.place).toBeNull();
  });

  it('freezes a SHARED place at its own standing setting, never the stage’s ask', async () => {
    // The claim `EquipmentControlSchema` states and no `.refine` enforces: the
    // curing chamber holds three other things, so its setting belongs to the
    // chamber. The stage asked for 20 °C at 60% RH; what is recorded is 12 °C at
    // 75%, because that is what the chamber was actually at.
    await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      anchor: ANCHOR,
      stagePlaceIds: [null, 'eq-curing'],
      equipment: [PROOFER, CURING],
    });
    expect(written().stages[1]?.place).toEqual({
      equipmentId: 'eq-curing',
      label: 'Curing chamber',
      temperature: { kind: 'fixed', celsius: 12 },
      relativeHumidityPercent: 75,
    });
  });

  it('records nothing for a shared place with no standing setting, rather than inventing one', async () => {
    const unset = {
      ...CURING,
      environment: { ...CURING.environment, standing: null },
    } as unknown as EquipmentItemDoc;
    await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      anchor: ANCHOR,
      stagePlaceIds: [null, 'eq-curing'],
      equipment: [unset],
    });
    const place = written().stages[1]?.place;
    expect(place?.label).toBe('Curing chamber');
    expect(place?.temperature).toBeNull();
    expect(place?.relativeHumidityPercent).toBeNull();
  });

  it('drops an id the manifest does not hold, and keeps the stage', async () => {
    await startBatch({
      recipe: RECIPE,
      formula: FORMULA,
      anchor: ANCHOR,
      stagePlaceIds: ['eq-deleted-yesterday', 'eq-knives'],
      equipment: [PROOFER, KNIFE_BLOCK],
    });
    const stages = written().stages;
    expect(stages).toHaveLength(2);
    // A deleted item, and an item that is not a place at all: both land null.
    expect(stages[0]?.place).toBeNull();
    expect(stages[1]?.place).toBeNull();
  });

  it('carries the kitchen temperature onto the run', async () => {
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR, ambientCelsius: 26 });
    expect(written().ambientCelsius).toBe(26);
  });

  it('starts exactly the run it used to when neither question is answered', async () => {
    await startBatch({ recipe: RECIPE, formula: FORMULA, anchor: ANCHOR });
    const batch = written();
    expect(batch.ambientCelsius).toBeNull();
    expect(batch.stages.every((stage) => stage.place === null)).toBe(true);
  });
});
