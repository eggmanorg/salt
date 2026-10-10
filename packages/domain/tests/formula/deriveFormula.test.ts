import { describe, it, expect } from 'vitest';
import { deriveFormula } from '../../src/index.js';

describe('deriveFormula', () => {
  it('refuses a formula with nothing in it', () => {
    const derived = deriveFormula({ recipeId: 'r1', components: [] });
    expect(derived).toEqual({ ok: false, reason: { kind: 'emptyFormula' } });
  });

  it('refuses a gram figure that cannot start a derivation, and names the ingredient', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-flour', grams: 500, inBasis: true },
        { ingredientId: 'ing-water', grams: 0, inBasis: false },
      ],
    });
    expect(derived).toEqual({
      ok: false,
      reason: { kind: 'invalidAmount', ingredientId: 'ing-water', grams: 0 },
    });
  });

  it('refuses when nothing was chosen as the basis', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [{ ingredientId: 'ing-water', grams: 350, inBasis: false }],
    });
    expect(derived).toEqual({ ok: false, reason: { kind: 'noBasis' } });
  });

  it('carries density provenance and bounds through onto the component', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-flour', grams: 500, inBasis: true },
        { ingredientId: 'ing-oil', grams: 46, inBasis: false, density: 'oil', maxPercent: 12 },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    expect(derived.formula.components[1]).toEqual({
      ingredientId: 'ing-oil',
      percent: 9.2,
      inBasis: false,
      density: 'oil',
      maxPercent: 12,
      // At the start, because nothing said otherwise (issue #1405).
      stageId: null,
      // Of the whole basis, for the same reason (issue #1657).
      statedOf: null,
    });
  });

  it('leaves absent optional fields absent rather than writing undefined', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [{ ingredientId: 'ing-flour', grams: 500, inBasis: true }],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    // `stageId` is present and null, which is not a counterexample to this claim but
    // the other half of it: an OPTIONAL field left out stays out, while a field with
    // a read default is constructed explicitly so the stored document says the one
    // thing it means (issue #1405, and the same rule `target` follows).
    expect(Object.keys(derived.formula.components[0] ?? {}).sort()).toEqual([
      'inBasis',
      'ingredientId',
      'percent',
      'stageId',
      'statedOf',
    ]);
  });

  it('takes a caller-supplied reference yield over the derived basis weight', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-flour', grams: 500, inBasis: true },
        { ingredientId: 'ing-water', grams: 350, inBasis: false },
      ],
      referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    expect(derived.formula.referenceYield.kind).toBe('target');
  });
});

// WHAT A LINE'S STRENGTH IS STATED AGAINST (issue #1657). `statedOfOn` is the one
// place it is decided, and each of its three conditions is a claim the schema's
// comment makes — so each has a case that goes red when the condition is dropped.
describe('deriveFormula — statedOf', () => {
  const brine = (
    salt: { saltProduct?: 'plain' | 'cure1'; statedOf?: string | null; inBasis?: boolean },
    extra: { inBasis?: boolean } = {},
  ) =>
    deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-cucumber', grams: 1000, inBasis: true },
        { ingredientId: 'ing-water', grams: 1000, inBasis: extra.inBasis ?? true },
        { ingredientId: 'ing-salt', grams: 30, inBasis: salt.inBasis ?? false, ...salt },
      ],
    });

  const statedOfSalt = (derived: ReturnType<typeof deriveFormula>): string | null | undefined =>
    derived.ok
      ? derived.formula.components.find((c) => c.ingredientId === 'ing-salt')?.statedOf
      : undefined;

  it('keeps a plain salt stated against another basis member', () => {
    expect(statedOfSalt(brine({ saltProduct: 'plain', statedOf: 'ing-water' }))).toBe('ing-water');
  });

  it('leaves the stored percentage as percent of the basis — the view moves no number', () => {
    const stated = brine({ saltProduct: 'plain', statedOf: 'ing-water' });
    const whole = brine({ saltProduct: 'plain', statedOf: null });
    if (!stated.ok || !whole.ok) throw new Error('derive failed');
    expect(stated.formula.components.map((c) => c.percent)).toEqual(
      whole.formula.components.map((c) => c.percent),
    );
    expect(stated.formula.components.find((c) => c.ingredientId === 'ing-salt')?.percent).toBe(1.5);
  });

  it('writes null for a curing salt, whatever it asked for — a cure is always of the meat', () => {
    expect(statedOfSalt(brine({ saltProduct: 'cure1', statedOf: 'ing-water' }))).toBeNull();
  });

  it('writes null for a line that names no product at all', () => {
    expect(statedOfSalt(brine({ statedOf: 'ing-water' }))).toBeNull();
  });

  it('writes null when the named line is not in the basis', () => {
    expect(
      statedOfSalt(brine({ saltProduct: 'plain', statedOf: 'ing-water' }, { inBasis: false })),
    ).toBeNull();
  });

  it('writes null for a name that is not on the formula at all', () => {
    expect(statedOfSalt(brine({ saltProduct: 'plain', statedOf: 'ing-gone' }))).toBeNull();
  });

  it('writes null for a line stated against itself', () => {
    expect(
      statedOfSalt(brine({ saltProduct: 'plain', statedOf: 'ing-salt', inBasis: true })),
    ).toBeNull();
  });

  it('writes null on a one-member basis, where "of the member" and "of the basis" are one figure', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-cabbage', grams: 1000, inBasis: true },
        {
          ingredientId: 'ing-salt',
          grams: 20,
          inBasis: false,
          saltProduct: 'plain',
          statedOf: 'ing-cabbage',
        },
      ],
    });
    expect(statedOfSalt(derived)).toBeNull();
  });

  it('does not let a stated plain salt move the curing salt beside it, nor its window', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-pork', grams: 1000, inBasis: true },
        { ingredientId: 'ing-water', grams: 1000, inBasis: true },
        {
          ingredientId: 'ing-salt',
          grams: 40,
          inBasis: false,
          saltProduct: 'plain',
          statedOf: 'ing-water',
        },
        {
          ingredientId: 'ing-cure',
          grams: 5,
          inBasis: false,
          saltProduct: 'cure1',
          statedOf: 'ing-water',
        },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    const cure = derived.formula.components.find((c) => c.ingredientId === 'ing-cure');
    expect(cure?.statedOf).toBeNull();
    expect(cure?.maxPercent).toBeDefined();
  });
});
