import { describe, it, expect } from 'vitest';
import { deriveFormula, freezeBatch, targetYield } from '../../src/index.js';
import { BatchSchema } from '../../src/schemas/index.js';
import type { Formula, ProcessStage, StageDuration } from '../../src/schemas/index.js';

// The freeze, in real bread rather than fixtures: #778's worked example — the
// overnight white tin as it exists in Salt today — started as twelve 120 g rolls,
// out of the oven at 07:30.
//
//   strong white flour  500 g  100%  ← basis
//   water               350 g   70%
//   salt                 10 g    2%
//   instant yeast         7 g  1.4%
//   olive oil            15 g    3%
//
// The gram figures are the ones `overnightWhiteTin.test.ts` pins to the gram; what
// is under test here is that they are FROZEN onto the run, with the words that make
// them readable, beside a schedule that lands on the minute.

const FLOUR = 'ing-strong-white-flour';
const WATER = 'ing-water';
const SALT = 'ing-salt';
const YEAST = 'ing-instant-yeast';
const OIL = 'ing-olive-oil';

const LABELS: Record<string, string> = {
  [FLOUR]: '500g strong white bread flour',
  [WATER]: '350ml lukewarm water',
  [SALT]: '10g fine sea salt',
  [YEAST]: '7g instant yeast',
  [OIL]: '15ml olive oil',
};

const fixed = (minutes: number): StageDuration => ({ kind: 'fixed', minutes });

function stage(
  id: string,
  label: string,
  kind: 'active' | 'wait',
  duration: StageDuration | null,
): ProcessStage {
  return { id, label, kind, environment: null, duration, until: null, stepId: null };
}

// mix 20 · bulk 180 · shape 15 · prove 60 · preheat 20 · bake 45 = 340 minutes.
const PROCESS: ProcessStage[] = [
  stage('mix', 'Mix and knead', 'active', fixed(20)),
  stage('bulk', 'Bulk ferment', 'wait', fixed(180)),
  stage('shape', 'Shape into the tin', 'active', fixed(15)),
  stage('prove', 'Final prove', 'wait', fixed(60)),
  stage('preheat', 'Preheat the oven', 'wait', fixed(20)),
  stage('bake', 'Bake', 'active', fixed(45)),
];

// `null` for the sausage case: a formula with no reference process at all.
function overnightWhiteTin(process: ProcessStage[] | null = PROCESS): Formula {
  const derived = deriveFormula({
    recipeId: 'overnight-white-tin',
    components: [
      { ingredientId: FLOUR, grams: 500, inBasis: true },
      { ingredientId: WATER, grams: 350, inBasis: false },
      { ingredientId: SALT, grams: 10, inBasis: false },
      { ingredientId: YEAST, grams: 7, inBasis: false },
      { ingredientId: OIL, grams: 15, inBasis: false },
    ],
  });
  if (!derived.ok) throw new Error(`fixture failed to derive: ${derived.reason.kind}`);
  return { ...derived.formula, ...(process === null ? {} : { process }) };
}

const TWELVE_ROLLS = targetYield({ count: 12, unitDoughGrams: 120 });

const NOW = '2026-08-14T21:00:00.000Z';

function freezeTwelveRolls(
  overrides: { anchor?: Parameters<typeof freezeBatch>[0]['anchor'] } = {},
) {
  const result = freezeBatch({
    id: 'batch-1',
    formula: overnightWhiteTin(),
    atYield: TWELVE_ROLLS,
    anchor: overrides.anchor ?? { kind: 'endAt', at: '2026-08-15T07:30:00.000Z' },
    recipeTitle: 'Overnight white tin',
    labels: LABELS,
    now: NOW,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.reason));
  return result.batch;
}

describe('freezeBatch — the quantities', () => {
  it('freezes the solved grams for twelve rolls, not the recipe’s own numbers', () => {
    const gramsById = Object.fromEntries(
      freezeTwelveRolls().quantities.map((q) => [q.ingredientId, q.grams]),
    );
    // 1 440 g of dough on the bench — and since #1274 that is also what's mixed,
    // there being no handling allowance any more; ÷1.764 = 816 g of flour. The
    // recipe still says 500 g and always will.
    expect(gramsById).toEqual({
      [FLOUR]: 816,
      [WATER]: 571,
      [SALT]: 16,
      [YEAST]: 11,
      [OIL]: 24,
    });
  });

  it('freezes the WORDS beside the numbers', () => {
    // The point of the label: rename the recipe's ingredient, or delete the dish
    // outright, and this run still reads as bread rather than as ids and figures.
    const flour = freezeTwelveRolls().quantities.find((q) => q.ingredientId === FLOUR);
    expect(flour).toEqual({
      ingredientId: FLOUR,
      label: '500g strong white bread flour',
      percent: 100,
      grams: 816,
    });
  });

  it('leaves the label empty rather than inventing one for an ingredient that has gone', () => {
    // The oil was removed from the recipe after the formula was mapped.
    const { [OIL]: _goneFromTheRecipe, ...withoutOil } = LABELS;
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      atYield: TWELVE_ROLLS,
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      labels: withoutOil,
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reason));
    const oil = result.batch.quantities.find((q) => q.ingredientId === OIL);
    expect(oil?.label).toBe('');
    expect(oil?.grams).toBe(24);
  });

  it('freezes the totals and what the dough divides into', () => {
    expect(freezeTwelveRolls().totals).toEqual({
      basisGrams: 816,
      totalGrams: 1440,
      usableGrams: 1440,
      // No label and no baked figure since #1274 — see `BatchUnitsSchema`.
      units: { count: 12, unitDoughGrams: 120 },
    });
  });

  it('freezes the recipe’s title so a renamed or deleted dish cannot erase the log', () => {
    const batch = freezeTwelveRolls();
    expect(batch.recipeTitle).toBe('Overnight white tin');
    expect(batch.recipeId).toBe('overnight-white-tin');
  });
});

describe('freezeBatch — the schedule', () => {
  it('lands the bake on 07:30 exactly, and back-solves the night from it', () => {
    const stages = freezeTwelveRolls().stages;
    expect(stages.map((s) => [s.id, s.plannedStartAt, s.plannedEndAt])).toEqual([
      ['mix', '2026-08-15T01:50:00.000Z', '2026-08-15T02:10:00.000Z'],
      ['bulk', '2026-08-15T02:10:00.000Z', '2026-08-15T05:10:00.000Z'],
      ['shape', '2026-08-15T05:10:00.000Z', '2026-08-15T05:25:00.000Z'],
      ['prove', '2026-08-15T05:25:00.000Z', '2026-08-15T06:25:00.000Z'],
      ['preheat', '2026-08-15T06:25:00.000Z', '2026-08-15T06:45:00.000Z'],
      ['bake', '2026-08-15T06:45:00.000Z', '2026-08-15T07:30:00.000Z'],
    ]);
  });

  it('schedules forward from a start when that is what was asked for', () => {
    const stages = freezeTwelveRolls({ anchor: { kind: 'startAt', at: NOW } }).stages;
    expect(stages[0]?.plannedStartAt).toBe(NOW);
    expect(stages[stages.length - 1]?.plannedEndAt).toBe('2026-08-15T02:40:00.000Z');
  });

  it('records no actual times: a freeze is a plan, not a claim about what happened', () => {
    const stages = freezeTwelveRolls().stages;
    expect(stages.every((s) => s.actualStartAt === null && s.actualEndAt === null)).toBe(true);
  });

  it('keeps every stage’s own words and duration alongside the clock', () => {
    const bulk = freezeTwelveRolls().stages.find((s) => s.id === 'bulk');
    expect(bulk?.label).toBe('Bulk ferment');
    expect(bulk?.kind).toBe('wait');
    expect(bulk?.duration).toEqual({ kind: 'fixed', minutes: 180 });
  });
});

describe('freezeBatch — the document', () => {
  it('starts running, with the id it was handed and no rationale', () => {
    const batch = freezeTwelveRolls();
    expect(batch.id).toBe('batch-1');
    expect(batch.state).toBe('running');
    // Phase 1 resolves the schedule by arithmetic, which has no opinion to record.
    expect(batch.rationale).toBeNull();
    expect(batch.schemaVersion).toBe(1);
    expect(batch.createdAt).toBe(NOW);
    expect(batch.updatedAt).toBe(NOW);
  });

  it('produces a document that parses as a batch', () => {
    // The freeze is the only writer and the adapter parses everything it reads
    // back, so the two must agree. A field the producer forgets is a corruption
    // Failure on the very next snapshot.
    expect(BatchSchema.safeParse(freezeTwelveRolls()).success).toBe(true);
  });

  it('scales to the formula’s own reference yield when no yield is asked for', () => {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      labels: LABELS,
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reason));
    const flour = result.batch.quantities.find((q) => q.ingredientId === FLOUR);
    expect(flour?.grams).toBe(500);
  });
});

describe('freezeBatch — what it refuses', () => {
  it('refuses a formula with no process: a run with no stages has nothing to run', () => {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(null),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Fresh sausage',
      labels: LABELS,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: { kind: 'noProcess' } });
  });

  it('refuses a formula that will not solve, carrying the solve’s own reason', () => {
    const unbalanced: Formula = {
      ...overnightWhiteTin(),
      // Two basis members at 100% each: there is no single 100% to be a percentage
      // of, so no gram figure can be produced.
      components: [
        { ingredientId: FLOUR, percent: 100, inBasis: true },
        { ingredientId: WATER, percent: 100, inBasis: true },
      ],
    };
    const result = freezeBatch({
      id: 'batch-1',
      formula: unbalanced,
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      labels: LABELS,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('unsolvableFormula');
    if (result.reason.kind !== 'unsolvableFormula') return;
    expect(result.reason.reason.kind).toBe('basisNotNormalised');
  });

  it('refuses an anchor that is not a time, rather than writing Invalid Date onto a run', () => {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'endAt', at: 'breakfast' },
      recipeTitle: 'Overnight white tin',
      labels: LABELS,
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'unschedulable', reason: { kind: 'invalidAnchor', at: 'breakfast' } },
    });
  });
});
