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
    });
  });

  it('leaves absent optional fields absent rather than writing undefined', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [{ ingredientId: 'ing-flour', grams: 500, inBasis: true }],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    expect(Object.keys(derived.formula.components[0] ?? {}).sort()).toEqual([
      'inBasis',
      'ingredientId',
      'percent',
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
