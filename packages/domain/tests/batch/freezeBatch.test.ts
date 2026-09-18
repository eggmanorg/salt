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
  return {
    id,
    label,
    kind,
    environment: null,
    duration,
    until: null,
    stepId: null,
    optional: false,
  };
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
    recipeKind: 'recipe',
    cureCategory: null,
    startedBy: null,
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
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
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

  // ─── What the run WAS (issue #1404) ─────────────────────────────────────────
  // The kind and the category join the freeze for the same reason the title is in
  // it, and for one more: "show me all my dry-cured whole muscle" and "the last
  // three bresaola" have to stay answerable over runs whose recipes have since been
  // tidied. A read-through would lose both the first time the library is edited.
  it('freezes the kind and the category onto the run', () => {
    const result = freezeBatch({
      id: 'batch-cure-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Coppa',
      recipeKind: 'cure',
      cureCategory: 'dry_cured_whole_muscle',
      startedBy: null,
      labels: LABELS,
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reason));

    expect(result.batch.recipeKind).toBe('cure');
    expect(result.batch.cureCategory).toBe('dry_cured_whole_muscle');
  });

  it('writes both EXPLICITLY, so a new run never inherits a schema read default', () => {
    // The distinction `checkedIngredientIds` already draws: a `.default()` on
    // `BatchSchema` is what a document written BEFORE the field existed reads back
    // as, and must never be what a document written today is born with. Asserted by
    // reading the keys off the frozen object rather than the parsed one — a parse
    // would supply the very defaults this is checking are not being relied on.
    const batch = freezeTwelveRolls();
    expect(Object.keys(batch)).toContain('recipeKind');
    expect(Object.keys(batch)).toContain('cureCategory');
    // And a plain bread run says so rather than saying nothing.
    expect(batch.recipeKind).toBe('recipe');
    expect(batch.cureCategory).toBeNull();
  });

  // ─── Who tapped Start (issue #1406) ─────────────────────────────────────────
  it('freezes who started the run, explicitly, including when nobody did', () => {
    // The uid the weekly nudge is addressed to. Written explicitly for the reason the
    // kind above is, so the key is on the frozen object rather than supplied by the
    // schema's read default — and `null` is a real answer, not a missing one.
    const hung = freezeBatch({
      id: 'batch-coppa-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Coppa',
      recipeKind: 'cure',
      cureCategory: 'dry_cured_whole_muscle',
      startedBy: 'uid-daniel',
      labels: LABELS,
      now: NOW,
    });
    if (!hung.ok) throw new Error(JSON.stringify(hung.reason));
    expect(hung.batch.startedBy).toBe('uid-daniel');

    const anonymous = freezeTwelveRolls();
    expect(Object.keys(anonymous)).toContain('startedBy');
    expect(anonymous.startedBy).toBeNull();
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

  it('starts every stage not started, and nothing decided against', () => {
    // The four conditions (issue #1275) all begin at their zero: nothing observed,
    // nothing skipped.
    const batch = freezeTwelveRolls();
    expect(batch.stages.every((s) => s.actualStartAt === null)).toBe(true);
    expect(batch.stages.every((s) => s.actualEndAt === null)).toBe(true);
    expect(batch.stages.every((s) => s.skipped === null)).toBe(true);
  });

  it('parses a batch written before `skipped` and `optional` existed', () => {
    // THE BACK-COMPAT PIN (issue #1275). `batches/{batchId}` holds live documents,
    // every one of them written without either key. Both are read defaults, so a
    // stored run opens unchanged with no migration — and the whole batch is read as
    // ONE document, so a stage that failed to parse would take the run's page down.
    const batch = freezeTwelveRolls();
    const beforeTheFields = {
      ...batch,
      stages: batch.stages.map(({ skipped: _s, optional: _o, ...stage }) => stage),
    };

    const parsed = BatchSchema.safeParse(beforeTheFields);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.stages.every((s) => s.skipped === null)).toBe(true);
    expect(parsed.data.stages.every((s) => s.optional === false)).toBe(true);
  });

  it('parses a batch written before `abandonedAt` existed, running or abandoned', () => {
    // THE BACK-COMPAT PIN (issue #1280). Every live `batches/{batchId}` document was
    // written without this key, including the runs already abandoned — and those are
    // exactly the ones that can never be back-filled, because nothing recorded when.
    // A read default is what makes both open with no migration.
    const { abandonedAt: _a, ...beforeTheField } = freezeTwelveRolls();

    const running = BatchSchema.safeParse(beforeTheField);
    expect(running.success).toBe(true);
    if (running.success) expect(running.data.abandonedAt).toBeNull();

    const stopped = BatchSchema.safeParse({ ...beforeTheField, state: 'abandoned' });
    expect(stopped.success).toBe(true);
    if (stopped.success) expect(stopped.data.abandonedAt).toBeNull();
  });

  it('scales to the formula’s own reference yield when no yield is asked for', () => {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
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
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
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
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
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
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'unschedulable', reason: { kind: 'invalidAnchor', at: 'breakfast' } },
    });
  });
});

// ─── The frozen place, and the kitchen figure (issue #1286) ────────────────────
describe('freezeBatch — where each stage happened', () => {
  const PROOFER = {
    equipmentId: 'eq-proofer',
    label: 'Dough proofer',
    temperature: { kind: 'fixed' as const, celsius: 24 },
    relativeHumidityPercent: null,
  };
  const CURING = {
    equipmentId: 'eq-curing',
    label: 'Curing chamber',
    temperature: { kind: 'fixed' as const, celsius: 12 },
    relativeHumidityPercent: 75,
  };

  it('writes the places POSITIONALLY, against the process it was given', () => {
    // The alignment `FreezeBatchInput.places` claims. `resolveSchedule` returns one
    // entry per stage in order, so entry i is stage i — and this is the test that
    // goes red if that ever stops being true.
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      places: [null, CURING, null, PROOFER],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.batch.stages.map((s) => [s.id, s.place]));
    expect(byId.get('mix')).toBeNull();
    expect(byId.get('bulk')).toEqual(CURING);
    expect(byId.get('shape')).toBeNull();
    expect(byId.get('prove')).toEqual(PROOFER);
    // Shorter than the process: the rest chose nowhere in particular.
    expect(byId.get('preheat')).toBeNull();
    expect(byId.get('bake')).toBeNull();
  });

  it('keeps the label after the equipment item is renamed or deleted', () => {
    // The whole reason the snapshot carries a label as well as an id. Nothing here
    // can reach `equipmentManifest/current`, so renaming the proofer to something
    // else — or deleting it — cannot reach back into a run already frozen.
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      places: [null, PROOFER],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frozen = BatchSchema.parse(result.batch);
    expect(frozen.stages[1]?.place?.label).toBe('Dough proofer');
    expect(frozen.stages[1]?.place?.equipmentId).toBe('eq-proofer');
  });

  it("lands every place null when none was chosen — today's behaviour, exactly", () => {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.stages.every((s) => s.place === null)).toBe(true);
    expect(result.batch.ambientCelsius).toBeNull();
  });

  it('freezes the kitchen temperature, and computes nothing from it', () => {
    const warm = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      ambientCelsius: 26,
      now: NOW,
    });
    const cold = freezeBatch({
      id: 'batch-2',
      formula: overnightWhiteTin(),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      ambientCelsius: 14,
      now: NOW,
    });
    expect(warm.ok && cold.ok).toBe(true);
    if (!warm.ok || !cold.ok) return;
    expect(warm.batch.ambientCelsius).toBe(26);
    expect(cold.batch.ambientCelsius).toBe(14);
    // THE BAN, PINNED. Twelve degrees of difference must not move a single planned
    // minute: a temperature is a fact on the record, never an operand
    // (docs/formulas-schedules-batches.md, "what not to build").
    expect(warm.batch.stages.map((s) => [s.plannedStartAt, s.plannedEndAt])).toEqual(
      cold.batch.stages.map((s) => [s.plannedStartAt, s.plannedEndAt]),
    );
  });
});

describe('freezeBatch — what the run is aiming at (issue #1407)', () => {
  const COPPA_TARGET = { weightLossPercent: 35, phAtMost: null };

  function freezeWithTarget(target: Formula['target']) {
    const result = freezeBatch({
      id: 'batch-1',
      formula: { ...overnightWhiteTin(), target },
      atYield: TWELVE_ROLLS,
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reason));
    return result.batch;
  }

  it('copies the formula’s target onto the run', () => {
    expect(freezeWithTarget(COPPA_TARGET).target).toEqual(COPPA_TARGET);
  });

  it('freezes it — editing the formula afterwards does not reach a running batch', () => {
    // The whole reason the field is on the batch rather than read through. The
    // formula object the run was frozen from is mutated out from under it here in
    // the only way a pure test can express "somebody edited the formula next
    // month": a new formula with a different target, which the already-frozen
    // batch has no path back to.
    const frozen = freezeWithTarget(COPPA_TARGET);
    const edited: Formula = {
      ...overnightWhiteTin(),
      target: { weightLossPercent: 20, phAtMost: 5.3 },
    };
    expect(edited.target).not.toEqual(frozen.target);
    expect(frozen.target).toEqual(COPPA_TARGET);
  });

  it('writes null for a formula that names no target, and parses as one', () => {
    const batch = freezeWithTarget(null);
    expect(batch.target).toBeNull();
    // Not merely typed null — null on the document that gets written.
    expect(BatchSchema.parse(batch).target).toBeNull();
  });
});

// ─── Which curing salt actually went on (issue #1402, phase 3) ────────────────
describe('freezeBatch — the cure-salt substitution', () => {
  function freezeWithSubstitution(
    substitution?: Parameters<typeof freezeBatch>[0]['cureSaltSubstitution'],
  ) {
    const result = freezeBatch({
      id: 'batch-1',
      formula: overnightWhiteTin(),
      atYield: TWELVE_ROLLS,
      ...(substitution === undefined ? {} : { cureSaltSubstitution: substitution }),
      anchor: { kind: 'startAt', at: NOW },
      recipeTitle: 'Overnight white tin',
      recipeKind: 'recipe',
      cureCategory: null,
      startedBy: null,
      labels: LABELS,
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reason));
    return result.batch;
  }

  it('freezes which product replaced which, and parses as written', () => {
    const swap = { from: 'cure1', to: 'nitritedCuringSalt' } as const;
    const batch = freezeWithSubstitution(swap);
    expect(batch.cureSaltSubstitution).toEqual(swap);
    // Not merely typed: the shape that reaches Firestore parses back as it went in.
    expect(BatchSchema.parse(batch).cureSaltSubstitution).toEqual(swap);
  });

  it('leaves the field ABSENT for a run that used what the recipe named', () => {
    // Absent rather than an empty object or a null, exactly as `vessel` is: an
    // empty object would read as a swap nobody made.
    const batch = freezeWithSubstitution();
    expect(batch.cureSaltSubstitution).toBeUndefined();
    expect(Object.keys(batch)).not.toContain('cureSaltSubstitution');
    expect(Object.keys(BatchSchema.parse(batch))).not.toContain('cureSaltSubstitution');
  });

  it('computes nothing from it — the quantities come from the formula alone', () => {
    // THE FREEZE MUST NOT RE-DERIVE A SWAP. The caller substitutes before calling,
    // so the percentages arriving inside `formula` are the ones that were on screen;
    // this field is a note beside them. A freeze that read it would be a second
    // place the arithmetic lived — so a nonsense swap changes not one gram.
    const withSwap = freezeWithSubstitution({ from: 'cure2', to: 'salvianda' });
    const without = freezeWithSubstitution();
    expect(withSwap.quantities).toEqual(without.quantities);
    expect(withSwap.totals).toEqual(without.totals);
  });
});
