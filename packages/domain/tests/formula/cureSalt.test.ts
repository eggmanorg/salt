import { describe, it, expect } from 'vitest';
import {
  CURE_SALT_PRODUCTS,
  deriveFormula,
  guessSaltProduct,
  ingoingNitritePpm,
  saltProductBounds,
  solveFormula,
} from '../../src/formula/index.js';
import { SaltProductSchema, type SaltProduct } from '../../src/schemas/formula.js';

// The cure-salt rail (issue #1402, phase 04 of epic #778).
//
// WHAT THESE PIN, and it is deliberately not "Salt prevents an unsafe cure":
//
//   1. THERE IS NO SINGLE CURE-SALT PERCENTAGE. Every window is read off a PRODUCT,
//      cure #1 at 0.25% and nitrited curing salt at 3% are both accepted, and
//      swapping the named product between them flips which one is refused. One
//      window wide enough for both would permit a twelvefold overdose.
//   2. THE TOP OF EACH WINDOW SATISFIES THE REQUIREMENT THAT SET IT. Ingoing
//      sodium nitrite at the top of each window stays under the 200 ppm ceiling,
//      computed from each product's own composition rather than asserted in prose
//      — and the standard doses the literature gives sit strictly inside, not at
//      an edge. THE FLOOR IS NOT justified the same way: no external
//      minimum-protective-ppm figure is asserted here, only that it is positive
//      and strictly below the top and every dose this file calls ordinary
//      (#1402 review, should-fix 3 — stated rather than left implied).
//   3. ONE PLACE DECIDES A BOUND. `deriveFormula` recomputes it from the product on
//      every pass, so re-deriving a saved formula keeps it, a caller cannot widen it
//      one end at a time, and there is no second check anywhere: the refusal is
//      `solveFormula`'s, which has refused since #782.
//   4. THE RAIL'S REAL LIMITS. No product named means no bound; celery-powder cures
//      are absent by design; nothing here checks the rest of the salt. Each is
//      asserted as an absence rather than left implied.
//
// Every claim above goes red if the rail is removed: delete the stamping in
// `boundsOn` and (3) fails; widen a window and (2) fails; collapse the two families
// to one window and (1) fails.

/** The coppa, as percentages of the trimmed shoulder. */
function cureFormula(cure: { percent: number; product?: SaltProduct }) {
  return deriveFormula({
    recipeId: 'recipe-1',
    components: [
      { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
      { ingredientId: 'ing-salt', grams: 25, inBasis: false },
      {
        ingredientId: 'ing-cure',
        grams: cure.percent * 10,
        inBasis: false,
        ...(cure.product === undefined ? {} : { saltProduct: cure.product }),
      },
    ],
  });
}

function solvedWith(cure: { percent: number; product?: SaltProduct }) {
  const derived = cureFormula(cure);
  if (!derived.ok) throw new Error(`derive failed: ${derived.reason.kind}`);
  return { formula: derived.formula, solved: solveFormula(derived.formula) };
}

describe('the table', () => {
  it('covers every product the schema knows, with no entry the schema does not', () => {
    // UT-E1: read off the schema rather than retyped, so a fifth product cannot be
    // added to one and not the other.
    expect(Object.keys(CURE_SALT_PRODUCTS).sort()).toEqual([...SaltProductSchema.options].sort());
  });

  it('holds two families whose doses differ by more than tenfold', () => {
    // THE WHOLE REASON THE TABLE IS KEYED BY PRODUCT. A single window covering both
    // would permit a twelvefold overdose of one of them, which is worse than no
    // check at all.
    const concentrated = saltProductBounds('cure1').maxPercent!;
    const dilute = saltProductBounds('nitritedCuringSalt').minPercent!;
    expect(dilute / concentrated).toBeGreaterThan(5);
  });

  it('gives every product a window with both ends', () => {
    for (const product of SaltProductSchema.options) {
      const { minPercent, maxPercent } = saltProductBounds(product);
      // Both ends, because UNDER-dosing is a hazard too — too little nitrite is a
      // cure that does not protect.
      expect(minPercent).toBeGreaterThan(0);
      expect(maxPercent).toBeGreaterThan(minPercent!);
    }
  });

  // ─── Claim 2: the TOPS satisfy the requirement that set them ─────────────────
  //
  // Only the ceiling is checked mechanically here. The windows' tops are set by
  // INGOING NITRITE rather than by taste, and this is that relationship made
  // mechanical rather than left in a comment: widen any window's top and this
  // fails, against the 200 ppm ceiling and the standard doses the literature
  // gives, neither of which is a boundary chosen here. The floors are a separate,
  // narrower claim — see `CureSaltProductInfo.bounds`'s header and the
  // `minPercent` case below.
  describe('ingoing nitrite', () => {
    // The ceiling on ingoing sodium nitrite, in ppm of the meat.
    const CEILING_PPM = 200;

    it.each([...SaltProductSchema.options])(
      'keeps %s under the ceiling at the top of its window',
      (product) => {
        const top = saltProductBounds(product).maxPercent!;
        expect(ingoingNitritePpm(product, top)).toBeLessThan(CEILING_PPM);
      },
    );

    it('leaves real headroom rather than sitting on the ceiling', () => {
      // A window whose top landed on 199.9 ppm would pass the assertion above and
      // still be a figure chosen to pass it. Every product is at least 5% clear.
      for (const product of SaltProductSchema.options) {
        const top = saltProductBounds(product).maxPercent!;
        expect(ingoingNitritePpm(product, top)).toBeLessThan(CEILING_PPM * 0.95);
      }
    });

    it('computes ppm from composition, and says what the figure is', () => {
      // 0.3% of a 6.25% product is 187.5 ppm; 3% of a 0.6% one is 180 ppm. Both
      // near 190 and both under the ceiling, which is the sentence the table's
      // comment makes and this is what checks it.
      expect(ingoingNitritePpm('cure1', 0.3)).toBeCloseTo(187.5, 6);
      expect(ingoingNitritePpm('nitritedCuringSalt', 3)).toBeCloseTo(180, 6);
    });

    // THE REQUIREMENT'S OWN EXEMPLARS, not the edges chosen above: the doses these
    // products are actually sold and used at. Each must sit STRICTLY inside its
    // window — a standard dose at an edge would mean ordinary practice living one
    // rounding away from a refusal.
    const STANDARD: readonly (readonly [SaltProduct, number])[] = [
      ['cure1', 0.25],
      ['cure2', 0.25],
      ['nitritedCuringSalt', 2.5],
      ['nitritedCuringSalt', 3],
      ['salvianda', 2.5],
      ['salvianda', 3],
    ];

    it.each(STANDARD)(
      'puts the standard dose of %s (%s%%) STRICTLY inside its window',
      (product, dose) => {
        // `toBeLessThan`, not `toBeLessThanOrEqual` (#1402 review, should-fix 2):
        // an edge is not "inside", and the assertion that was here before let a
        // window whose top equalled its own standard dose pass while claiming
        // strictness.
        const { minPercent, maxPercent } = saltProductBounds(product);
        expect(dose).toBeGreaterThan(minPercent!);
        expect(dose).toBeLessThan(maxPercent!);
      },
    );

    it('does not pin the floor to an external minimum-protective-ppm figure', () => {
      // Should-fix 3 from the #1402 review: unlike the top, nothing above computes
      // the floor from an outside ppm target. This test states that limit rather
      // than implying a check that is not there — `cure1.minPercent` could sit
      // anywhere in (0.05, 0.25) and nothing in this file would fail.
      for (const product of SaltProductSchema.options) {
        const { minPercent, maxPercent } = saltProductBounds(product);
        expect(minPercent).toBeGreaterThan(0);
        expect(minPercent!).toBeLessThan(maxPercent!);
      }
    });

    it('is unaffected by scaling above the gram-rounding floor, and not below it', () => {
      // "SCALING IS NEVER THE DANGER" holds for the STORED percentage (see 'is
      // unaffected by scaling' below, in 'what the rail does not do'), but not for
      // the PRINTED weight: `roundGrams` gives sub-10 g figures only one decimal
      // place, so a basis small enough that the cure's gram figure lands in that
      // band can print a weight whose OWN ppm exceeds the ceiling even though the
      // stored percentage never moved (#1402 review, notes). Pinned here rather
      // than left an unqualified absolute.
      const { formula } = solvedWith({ percent: 0.25, product: 'cure1' });

      // Comfortably above the boundary — the scaling test below never samples
      // this low.
      const safe = solveFormula(formula, { kind: 'basis', grams: 500 });
      if (!safe.ok) throw new Error('expected a solve');
      const safeCure = safe.solution.components.find((c) => c.ingredientId === 'ing-cure')!;
      expect(ingoingNitritePpm('cure1', (safeCure.grams / 500) * 100)).toBeLessThan(200);

      // Below it: a 60 g basis prints 0.25% of cure #1 as 0.2 g, which is 0.333%
      // of the basis actually weighed out — 208 ppm, over the ceiling the window
      // was built to respect, from a formula the rail already accepted.
      const small = solveFormula(formula, { kind: 'basis', grams: 60 });
      if (!small.ok) throw new Error('expected a solve');
      const smallCure = small.solution.components.find((c) => c.ingredientId === 'ing-cure')!;
      expect(smallCure.grams).toBe(0.2);
      expect(ingoingNitritePpm('cure1', (smallCure.grams / 60) * 100)).toBeGreaterThan(200);
    });
  });
});

// ─── Claim 1: per-product, end to end through derive → solve ──────────────────
describe('the refusal is per product', () => {
  it('accepts cure #1 at 0.25% and nitrited curing salt at 3%', () => {
    // BOTH, which is the point: twelve times the difference and both right.
    expect(solvedWith({ percent: 0.25, product: 'cure1' }).solved.ok).toBe(true);
    expect(solvedWith({ percent: 3, product: 'nitritedCuringSalt' }).solved.ok).toBe(true);
  });

  it('flips which one is refused when the named product changes', () => {
    // The same percentage, two products, opposite answers — and nothing but the
    // product changed. A single cure-salt window could not produce this.
    expect(solvedWith({ percent: 3, product: 'cure1' }).solved.ok).toBe(false);
    expect(solvedWith({ percent: 0.25, product: 'nitritedCuringSalt' }).solved.ok).toBe(false);
  });

  it('refuses rather than extrapolating, and says which window was missed', () => {
    const { solved } = solvedWith({ percent: 1.2, product: 'cure1' });
    expect(solved.ok).toBe(false);
    if (solved.ok) throw new Error('expected a refusal');
    expect(solved.reason.kind).toBe('boundViolation');
    if (solved.reason.kind !== 'boundViolation') throw new Error('expected a boundViolation');
    // BOTH ENDS ride along, so a caller can print the window rather than the edge.
    expect(solved.reason.violations).toEqual([
      { ingredientId: 'ing-cure', percent: 1.2, bound: 'max', minPercent: 0.15, maxPercent: 0.3 },
    ]);
  });

  it('refuses an under-dose as well as an over-dose', () => {
    // Too little nitrite is a cure that does not protect, so the floor refuses too.
    const { solved } = solvedWith({ percent: 0.05, product: 'cure1' });
    expect(solved.ok).toBe(false);
    if (solved.ok) throw new Error('expected a refusal');
    if (solved.reason.kind !== 'boundViolation') throw new Error('expected a boundViolation');
    expect(solved.reason.violations[0]!.bound).toBe('min');
  });
});

// ─── Claim 3: one place decides a bound, and it cannot be lost ─────────────────
describe('the bound is stamped at derive and never carried', () => {
  it('stamps the product’s window onto the derived component', () => {
    const { formula } = solvedWith({ percent: 0.25, product: 'cure2' });
    const cure = formula.components.find((c) => c.ingredientId === 'ing-cure');
    expect(cure).toMatchObject({ saltProduct: 'cure2', minPercent: 0.15, maxPercent: 0.3 });
  });

  it('keeps the bound when a saved formula is re-derived from its own grams', () => {
    // THE DROP-ON-RE-SAVE THIS CLOSES. The formula screen round-trips derive → solve
    // → derive on every commit and carries no bounds through, so a stored window
    // used to vanish. Carrying the PRODUCT instead is what makes it impossible to
    // lose: the second derive recomputes the same window from the same product.
    const first = solvedWith({ percent: 0.25, product: 'cure1' });
    if (!first.solved.ok) throw new Error('expected a solve');
    const again = deriveFormula({
      recipeId: 'recipe-1',
      components: first.solved.solution.components.map((c) => {
        const stored = first.formula.components.find((s) => s.ingredientId === c.ingredientId)!;
        return {
          ingredientId: c.ingredientId,
          grams: c.exactGrams,
          inBasis: stored.inBasis,
          ...(stored.saltProduct === undefined ? {} : { saltProduct: stored.saltProduct }),
        };
      }),
    });
    if (!again.ok) throw new Error(`derive failed: ${again.reason.kind}`);
    expect(again.formula.components.find((c) => c.ingredientId === 'ing-cure')).toMatchObject({
      saltProduct: 'cure1',
      minPercent: 0.15,
      maxPercent: 0.3,
    });
  });

  it('lets a named product outrank a caller’s own bounds, rather than merging them', () => {
    // A MERGE WOULD LET A WINDOW BE WIDENED ONE END AT A TIME, which is the one
    // thing that must not be possible. The caller's 0%–10% is discarded whole.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        {
          ingredientId: 'ing-cure',
          grams: 2.5,
          inBasis: false,
          saltProduct: 'cure1',
          minPercent: 0,
          maxPercent: 10,
        },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(derived.formula.components[1]).toMatchObject({ minPercent: 0.15, maxPercent: 0.3 });
  });

  it('still honours a caller’s bounds where no product is named', () => {
    // Which is how `withComponentPercentScaled`'s leavening rail keeps working.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-flour', grams: 1000, inBasis: true },
        { ingredientId: 'ing-yeast', grams: 10, inBasis: false, minPercent: 0.2, maxPercent: 2.5 },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(derived.formula.components[1]).toMatchObject({ minPercent: 0.2, maxPercent: 2.5 });
  });
});

// ─── Claim 4: the rail's real limits, asserted as absences ─────────────────────
describe('what the rail does not do', () => {
  it('bounds nothing when no product is named', () => {
    // A 12% cure salt nobody has identified resolves into weights, and that is the
    // honest answer: the rail is on the dose of a NAMED product.
    const { formula, solved } = solvedWith({ percent: 12 });
    expect(solved.ok).toBe(true);
    const cure = formula.components.find((c) => c.ingredientId === 'ing-cure')!;
    expect(cure.minPercent).toBeUndefined();
    expect(cure.maxPercent).toBeUndefined();
    expect(cure.saltProduct).toBeUndefined();
  });

  it('has no entry for a celery-powder cure, and no keyword that would reach one', () => {
    // DELIBERATELY ABSENT. Their nitrite content varies by brand and batch, so a
    // fixed percentage would be a guess wearing a safety rail's clothes.
    for (const text of ['celery powder', 'celery juice powder', 'cultured celery extract']) {
      expect(guessSaltProduct({ canonName: null, rawText: text })).toBeNull();
    }
    const labels = Object.values(CURE_SALT_PRODUCTS).map((p) => p.label.toLowerCase());
    expect(labels.some((label) => label.includes('celery'))).toBe(false);
  });

  it('says nothing about the rest of the salt', () => {
    // A cure at a safe dose beside an absurd 40% plain salt resolves fine. Nothing
    // in this rail looks at any component but the one that names a product.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 400, inBasis: false },
        { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(solveFormula(derived.formula).ok).toBe(true);
  });

  it('is unaffected by scaling, because percentages scale linearly', () => {
    // A dose that is safe at 500 g is safe at 5 kg, and the rail checks the STORED
    // percentages for exactly that reason. This is the claim the code comment must
    // not overstate: the scaler does not make cures safe.
    const { formula } = solvedWith({ percent: 0.25, product: 'cure1' });
    for (const grams of [500, 1000, 5000, 40000]) {
      expect(solveFormula(formula, { kind: 'basis', grams }).ok).toBe(true);
    }
  });
});

describe('guessSaltProduct', () => {
  it('proposes a product from the words a recipe line actually uses', () => {
    expect(guessSaltProduct({ canonName: null, rawText: '2.5 g cure #1' })).toBe('cure1');
    expect(guessSaltProduct({ canonName: null, rawText: '2.5 g Cure No. 2' })).toBe('cure2');
    expect(guessSaltProduct({ canonName: null, rawText: '6 g Prague Powder #2' })).toBe('cure2');
    expect(guessSaltProduct({ canonName: null, rawText: '26 g Nitritpökelsalz' })).toBe(
      'nitritedCuringSalt',
    );
    expect(guessSaltProduct({ canonName: null, rawText: '26 g salvianda' })).toBe('salvianda');
  });

  it('leads with the canon name, exactly as the basis guess does', () => {
    expect(guessSaltProduct({ canonName: 'cure #2', rawText: '6 g pink curing salt' })).toBe(
      'cure2',
    );
  });

  it('proposes nothing for "curing salt" alone, which names both families', () => {
    // RECOGNITION THAT DECIDED HERE WOULD BE A COIN TOSS between 0.25% and 3%, so
    // it does not decide: it proposes nothing and the person picks.
    for (const text of ['30 g curing salt', '30 g pink salt', '30 g Himalayan pink salt']) {
      expect(guessSaltProduct({ canonName: null, rawText: text })).toBeNull();
    }
  });

  it('matches whole words, so no compound word matches by accident', () => {
    expect(guessSaltProduct({ canonName: null, rawText: '500 g obscurel' })).toBeNull();
    expect(guessSaltProduct({ canonName: null, rawText: 'cure for 1 hour' })).toBeNull();
    expect(guessSaltProduct({ canonName: null, rawText: 'manicure 1' })).toBeNull();
  });

  it('proposes nothing for the ordinary ingredients of a loaf', () => {
    for (const text of ['500 g strong white flour', '350 g water', '10 g salt', '7 g yeast']) {
      expect(guessSaltProduct({ canonName: null, rawText: text })).toBeNull();
    }
  });

  it('is a proposal and never a bound — the bound comes off the component', () => {
    // The claim that keeps the keyword list off the safety path. A line whose text
    // says "cure #1" but whose component names nitrited curing salt is bounded by
    // NITRITED CURING SALT: the recogniser's opinion reaches nothing.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        {
          ingredientId: 'ing-cure',
          grams: 26,
          inBasis: false,
          saltProduct: 'nitritedCuringSalt',
        },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(derived.formula.components[1]).toMatchObject({ minPercent: 2, maxPercent: 3.15 });
    expect(solveFormula(derived.formula).ok).toBe(true);
  });
});
