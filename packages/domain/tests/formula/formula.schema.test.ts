import { describe, it, expect } from 'vitest';
import { FormulaSchema } from '../../src/schemas/index.js';
import {
  DensityClassSchema,
  DoughAmountSchema,
  FormulaComponentSchema,
  ReferenceYieldSchema,
} from '../../src/schemas/formula.js';

const MINIMAL_FORMULA = {
  recipeId: 'overnight-white-tin',
  components: [{ ingredientId: 'ing-flour', percent: 100, inBasis: true }],
  referenceYield: { kind: 'basis', grams: 500 },
};

describe('FormulaSchema', () => {
  it('stamps the schema version', () => {
    const parsed = FormulaSchema.parse(MINIMAL_FORMULA);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('accepts a formula with no components — an empty draft is not a parse error', () => {
    // Refusing to SOLVE an empty formula is the solve's job; the document is
    // allowed to exist mid-edit.
    expect(FormulaSchema.safeParse({ ...MINIMAL_FORMULA, components: [] }).success).toBe(true);
  });

  it('accepts a basis that has been edited off 100%', () => {
    // Deliberate: an unnormalised basis is ordinary flow from a human editing
    // percentages, and the solve refuses it with a reason a screen can render.
    // A schema-level refine would instead make the document unreadable.
    const off = {
      ...MINIMAL_FORMULA,
      components: [{ ingredientId: 'ing-flour', percent: 70, inBasis: true }],
    };
    expect(FormulaSchema.safeParse(off).success).toBe(true);
  });
});

describe('FormulaComponentSchema', () => {
  it('rejects a negative percentage', () => {
    expect(
      FormulaComponentSchema.safeParse({ ingredientId: 'i', percent: -1, inBasis: false }).success,
    ).toBe(false);
  });

  it('takes the bound seam as optional, and no bound is set anywhere in this phase', () => {
    const bare = FormulaComponentSchema.parse({ ingredientId: 'i', percent: 2, inBasis: false });
    expect(bare.minPercent).toBeUndefined();
    expect(bare.maxPercent).toBeUndefined();
    expect(
      FormulaComponentSchema.safeParse({
        ingredientId: 'i',
        percent: 2,
        inBasis: false,
        minPercent: 0.2,
        maxPercent: 3,
      }).success,
    ).toBe(true);
  });

  it('rejects a zero upper bound — a bound of nothing is a mistake, not a rail', () => {
    expect(
      FormulaComponentSchema.safeParse({
        ingredientId: 'i',
        percent: 2,
        inBasis: false,
        maxPercent: 0,
      }).success,
    ).toBe(false);
  });
});

describe('DoughAmountSchema', () => {
  it('takes a whole, positive count of a positive dough weight', () => {
    const amount = { count: 12, unitDoughGrams: 120 };
    expect(DoughAmountSchema.safeParse(amount).success).toBe(true);
    expect(DoughAmountSchema.safeParse({ ...amount, count: 0 }).success).toBe(false);
    expect(DoughAmountSchema.safeParse({ ...amount, count: 2.5 }).success).toBe(false);
    expect(DoughAmountSchema.safeParse({ ...amount, unitDoughGrams: 0 }).success).toBe(false);
  });

  it('strips a stale label and bakeLossPercent rather than refusing them', () => {
    // The wire keys are deliberately stale (schemas/formula.ts): a stored document
    // written before #1274 still carries `label`/`bakeLossPercent`, and Zod object
    // schemas strip unknown keys, so it must still parse.
    const withStaleKeys = {
      count: 2,
      unitDoughGrams: 900,
      label: '900 g tin loaf',
      bakeLossPercent: 14,
    };
    const parsed = DoughAmountSchema.safeParse(withStaleKeys);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ count: 2, unitDoughGrams: 900 });
  });
});

describe('ReferenceYieldSchema', () => {
  it('is one type for both directions', () => {
    expect(ReferenceYieldSchema.safeParse({ kind: 'basis', grams: 2400 }).success).toBe(true);
    expect(
      ReferenceYieldSchema.safeParse({
        kind: 'target',
        shape: { count: 12, unitDoughGrams: 120 },
      }).success,
    ).toBe(true);
  });

  it('rejects a yield of nothing and a kind that does not exist', () => {
    expect(ReferenceYieldSchema.safeParse({ kind: 'basis', grams: 0 }).success).toBe(false);
    expect(ReferenceYieldSchema.safeParse({ kind: 'servings', count: 4 }).success).toBe(false);
  });
});

describe('DensityClassSchema', () => {
  it('is a closed set of named classes', () => {
    expect(DensityClassSchema.options).toEqual(['waterLike', 'oil', 'syrup']);
    expect(DensityClassSchema.safeParse('0.92').success).toBe(false);
  });
});
