import { describe, it, expect } from 'vitest';
import { solveFormula } from '../../src/index.js';
import { FormulaSchema } from '../../src/schemas/index.js';

// A `formulas/{recipeId}` document WRITTEN BEFORE #1274, read by the code after it
// (rule-12 claims 1 and 2).
//
// #1274 deleted three fields — `referenceYield.shape.label`,
// `referenceYield.shape.bakeLossPercent` and the top-level `handlingLossPercent`.
// It deleted them rather than renaming anything, and this is where that decision
// is checked rather than asserted: Zod object schemas STRIP unknown keys, so a
// deletion is read-compatible where a rename would silently drop a live figure
// into `undefined`.
//
// `schemaVersion` stays at 1 and there is no migration, so this file is the whole
// of the back-compat story for the collection.

// Verbatim in the pre-#1274 shape, and deliberately NOT built from the current
// type: a fixture typed against today's schema could not carry the stale keys
// that are the entire point of the test.
const LEGACY_FORMULA = {
  recipeId: 'overnight-white-tin',
  components: [
    { ingredientId: 'ing-flour', percent: 100, inBasis: true },
    { ingredientId: 'ing-water', percent: 70, inBasis: false },
    { ingredientId: 'ing-salt', percent: 2, inBasis: false },
  ],
  referenceYield: {
    kind: 'target',
    shape: {
      label: '900 g tin loaf',
      count: 2,
      unitDoughGrams: 900,
      bakeLossPercent: 12,
    },
  },
  handlingLossPercent: 0,
  schemaVersion: 1,
};

describe('a formula document written before #1274', () => {
  it('still parses, with the surviving figures untouched', () => {
    const parsed = FormulaSchema.safeParse(LEGACY_FORMULA);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 2, unitDoughGrams: 900 },
    });
    expect(parsed.data.components).toHaveLength(3);
    expect(parsed.data.schemaVersion).toBe(1);
  });

  it('carries none of the three deleted fields through the parse', () => {
    const parsed = FormulaSchema.parse(LEGACY_FORMULA);
    // Not merely absent from the TYPE — absent from the parsed VALUE, which is
    // what gets written back on the next save. A stripped key cannot be
    // resurrected by a round trip.
    expect(Object.keys(parsed)).not.toContain('handlingLossPercent');
    const shape = parsed.referenceYield.kind === 'target' ? parsed.referenceYield.shape : null;
    expect(shape === null ? [] : Object.keys(shape)).toEqual(['count', 'unitDoughGrams']);
  });

  it('solves to the same grams it did before the handling allowance was deleted — AT A ZERO ALLOWANCE ONLY', () => {
    // THE BOUNDARY, and it is the whole of the claim: this holds for
    // `handlingLossPercent: 0`, which is every formula that has ever existed
    // (nothing wrote the field — the sole production caller of `deriveFormula`
    // never passed it, and `FormulaSchema` defaulted it to 0). A document
    // declaring 3% WOULD have solved differently before this change and is not
    // covered here; #778's worked-example fixture was exactly such a document and
    // its gram assertions legitimately moved.
    //
    // The figures below were computed under the OLD arithmetic
    // (`×(1 + 0/100)` = ×1) and are pasted, not re-derived, so this cannot pass by
    // reproducing whatever the new code happens to do.
    const solved = solveFormula(FormulaSchema.parse(LEGACY_FORMULA));
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;

    // 2 × 900 g = 1 800 g of dough at a 172% grand total → 1 046.51… g of flour,
    // 70% of that as water and 2% as salt, each through `roundGrams`.
    expect(solved.solution.usableGrams).toBe(1800);
    expect(solved.solution.totalGrams).toBe(1800);
    expect(solved.solution.basisExactGrams).toBeCloseTo(1800 / 1.72, 9);
    expect(solved.solution.components.map((c) => c.grams)).toEqual([1047, 733, 21]);
  });
});
