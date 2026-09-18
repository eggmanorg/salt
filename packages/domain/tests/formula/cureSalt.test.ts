import { describe, it, expect } from 'vitest';
import {
  CURE_SALT_PAIRS,
  CURE_SALT_PRODUCTS,
  deriveFormula,
  guessSaltProduct,
  ingoingNitritePpm,
  isCuringSalt,
  pairOf,
  saltProductBounds,
  solveFormula,
  withCureSaltSubstituted,
} from '../../src/formula/index.js';
import { SaltProductSchema, type Formula, type SaltProduct } from '../../src/schemas/formula.js';

// THE CURING PRODUCTS, which since phase 3 is not every member of the enum: `plain`
// joined it so a substitution can find the ordinary salt it moves mass into, and it
// deliberately carries no window. Every claim about windows below is a claim about
// the products that HAVE one, and `isCuringSalt` is read off composition rather than
// hand-listed here so the two cannot drift.
const CURING = SaltProductSchema.options.filter(isCuringSalt);

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

  it('gives every curing product a window with both ends', () => {
    for (const product of CURING) {
      const { minPercent, maxPercent } = saltProductBounds(product);
      // Both ends, because UNDER-dosing is a hazard too — too little nitrite is a
      // cure that does not protect.
      expect(minPercent).toBeGreaterThan(0);
      expect(maxPercent).toBeGreaterThan(minPercent!);
    }
  });

  it('gives a window to exactly the products that carry nitrite', () => {
    // WHAT LICENSES EVERY `CURING` LOOP ABOVE, in both directions (CLAUDE.md rule
    // 12). A window is derived from ingoing nitrite, so a product carrying nitrite
    // must have one and a product carrying none must not: a fifth curing salt added
    // with no window would otherwise be skipped silently by every claim below.
    for (const product of SaltProductSchema.options) {
      const { minPercent, maxPercent } = saltProductBounds(product);
      const hasWindow = minPercent !== undefined && maxPercent !== undefined;
      expect(hasWindow).toBe(isCuringSalt(product));
    }
    // And `plain` is the one member that is not a curing salt today, so the filter
    // above is not quietly hiding a second one.
    expect(SaltProductSchema.options.filter((p) => !isCuringSalt(p))).toEqual(['plain']);
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

    it.each([...CURING])('keeps %s under the ceiling at the top of its window', (product) => {
      const top = saltProductBounds(product).maxPercent!;
      expect(ingoingNitritePpm(product, top)).toBeLessThan(CEILING_PPM);
    });

    it('leaves real headroom rather than sitting on the ceiling', () => {
      // A window whose top landed on 199.9 ppm would pass the assertion above and
      // still be a figure chosen to pass it. Every product is at least 5% clear.
      for (const product of CURING) {
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
      for (const product of CURING) {
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

// ─── The jar you actually have (issue #1402, phase 3) ─────────────────────────
//
// WHAT THESE PIN, and again it is deliberately not "the swap is safe":
//
//   5. THE NITRITE DOSE IS HELD CONSTANT AND THE NITRATE DIVERGES. Both directions
//      of the worked example land on the figures the issue states, ingoing nitrite
//      is equal across the swap, and the nitrate is ~2.3× apart — computed from the
//      table rather than asserted in prose.
//   6. NOTHING CROSSES A PAIR, and the pairing itself is checked against the
//      compositions rather than trusted: each pair's members agree about whether
//      they carry nitrate.
//   7. THE SUBSTITUTION CHECKS NO DOSE. It restamps the substitute's own window and
//      `solveFormula` is what refuses an out-of-window result — the same refusal a
//      hand-typed percentage gets, and there is still exactly one.
//   8. A RESIDUAL THAT WILL NOT BALANCE IS REFUSED WITH ITS FIGURES, never clamped
//      in either direction.

/** The coppa as it is mapped for a substitution: meat, named plain salt, named cure. */
function pairedFormula(cure: { product: SaltProduct; grams: number }, saltGrams = 25) {
  const derived = deriveFormula({
    recipeId: 'recipe-1',
    components: [
      { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
      ...(saltGrams === 0
        ? []
        : [
            {
              ingredientId: 'ing-salt',
              grams: saltGrams,
              inBasis: false,
              saltProduct: 'plain' as const,
            },
          ]),
      { ingredientId: 'ing-cure', grams: cure.grams, inBasis: false, saltProduct: cure.product },
    ],
  });
  if (!derived.ok) throw new Error(`derive failed: ${derived.reason.kind}`);
  return derived.formula;
}

function percentOf(formula: Formula, id: string) {
  const component = formula.components.find((c) => c.ingredientId === id);
  if (component === undefined) throw new Error(`no component ${id}`);
  return component.percent;
}

function gramsAt(formula: Formula, id: string, basisGrams: number) {
  const solved = solveFormula(formula, { kind: 'basis', grams: basisGrams });
  if (!solved.ok) throw new Error(`solve failed: ${solved.reason.kind}`);
  const component = solved.solution.components.find((c) => c.ingredientId === id);
  if (component === undefined) throw new Error(`no component ${id}`);
  return component.grams;
}

describe('withCureSaltSubstituted', () => {
  it('converts the worked example, and the plain salt absorbs the difference', () => {
    // 1000 g of meat, 2.5 g of cure #1 (6.25% nitrite ⇒ 0.156 g nitrite) and 25 g of
    // salt. 0.156 ÷ 0.006 is 26 g of nitrited curing salt, leaving 1.5 g of plain
    // salt — the figures the issue states, through the ordinary solve.
    const result = withCureSaltSubstituted(pairedFormula({ product: 'cure1', grams: 2.5 }), {
      to: 'nitritedCuringSalt',
    });
    if (!result.ok) throw new Error(`expected a substitution: ${result.reason.kind}`);
    expect(gramsAt(result.formula, 'ing-cure', 1000)).toBe(26);
    expect(gramsAt(result.formula, 'ing-salt', 1000)).toBe(1.5);
    // Nothing else moves.
    expect(gramsAt(result.formula, 'ing-meat', 1000)).toBe(1000);
  });

  it('converts back to exactly the figures it started from', () => {
    const original = pairedFormula({ product: 'cure1', grams: 2.5 });
    const forward = withCureSaltSubstituted(original, { to: 'nitritedCuringSalt' });
    if (!forward.ok) throw new Error('expected a substitution');
    const back = withCureSaltSubstituted(forward.formula, { to: 'cure1' });
    if (!back.ok) throw new Error('expected a substitution back');
    // EXACTLY, not approximately: percentages are rounded to four decimals on the
    // way through, so a conversion that lost a ten-thousandth would show here.
    expect(percentOf(back.formula, 'ing-cure')).toBe(percentOf(original, 'ing-cure'));
    expect(percentOf(back.formula, 'ing-salt')).toBe(percentOf(original, 'ing-salt'));
    expect(back.formula.components).toEqual(original.components);
  });

  it('holds ingoing nitrite constant and lets the nitrate diverge', () => {
    // THE DECISION, MADE MECHANICAL. Nitrite is the acute number, so it is the one
    // that must not move; the two cannot both be matched, and this is how far apart
    // the other one ends up. A conversion that split the difference would fail the
    // first assertion — which is the point of having it.
    const original = pairedFormula({ product: 'cure2', grams: 2.5 });
    const result = withCureSaltSubstituted(original, { to: 'salvianda' });
    if (!result.ok) throw new Error('expected a substitution');

    const before = percentOf(original, 'ing-cure');
    const after = percentOf(result.formula, 'ing-cure');
    expect(ingoingNitritePpm('salvianda', after)).toBeCloseTo(
      ingoingNitritePpm('cure2', before),
      2,
    );

    const nitratePpm = (product: SaltProduct, percent: number) =>
      percent * CURE_SALT_PRODUCTS[product].nitratePercent * 100;
    const divergence = nitratePpm('salvianda', after) / nitratePpm('cure2', before);
    // "Roughly 2.3× apart", stated as a range rather than a figure chosen to pass.
    expect(divergence).toBeGreaterThan(2.2);
    expect(divergence).toBeLessThan(2.5);
  });

  it('refuses a salt total too low to carry the dose, with both figures', () => {
    // A REAL RECIPE, and both ways of hiding it are harmful: clamping the substitute
    // under-cures, clamping the residual over-salts. So it refuses and says what it
    // would need against what there is.
    const result = withCureSaltSubstituted(pairedFormula({ product: 'cure1', grams: 2.5 }, 1), {
      to: 'nitritedCuringSalt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toEqual({
      kind: 'saltTooLow',
      needsPercent: 2.6042,
      saltBearingPercent: 0.35,
    });
  });

  it('refuses when the freed-up weight has no plain salt to go into', () => {
    // The other direction of the same problem: the substitute needs LESS mass than
    // the product it replaces and there is no ordinary-salt row to put the rest in.
    // Dropping it would quietly make a less salty cure.
    const result = withCureSaltSubstituted(
      pairedFormula({ product: 'nitritedCuringSalt', grams: 26 }, 0),
      { to: 'cure1' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('noPlainSalt');
  });

  it('names the real remedy — not a false "salt too low" — on the state every real formula is in', () => {
    // THE STATE EVERY REAL FORMULA IS ACTUALLY IN (#1402 review, blocking 1). Phase
    // 2 shipped with no keyword that ever proposes `plain`, and `FormulaPage`'s
    // Select answers "Which curing salt is this?" with "Not a curing salt" for an
    // ordinary salt row — the honest-sounding answer nobody has a reason to
    // override. So the PRIMARY direction (a concentrated cure named, swapping to a
    // dilute one) meets a formula whose ordinary salt is on the formula but named
    // nothing at all — not `plain`, not any other product.
    //
    // Before this fix, `withCureSaltSubstituted` could not tell that apart from
    // "the salt really is too low": it returned `saltTooLow` with
    // `saltBearingPercent: 0.25` — a figure that is false about the recipe, which
    // has 2.5% of salt sitting right there — and a remedy ("put the salt up") that
    // can never clear the refusal, because an unnamed row's weight never reaches
    // `saltBearingPercent`. The fix routes this to `noPlainSalt`, whose remedy
    // (name the ordinary salt) is the one that actually works.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        // No `saltProduct` at all — "Not a curing salt" was left as the answer,
        // exactly as a real recipe's ordinary salt row is today.
        { ingredientId: 'ing-salt', grams: 25, inBasis: false },
        { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');

    const result = withCureSaltSubstituted(derived.formula, { to: 'nitritedCuringSalt' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toEqual({
      kind: 'noPlainSalt',
      // Negative: the substitute needs MORE than the named cure alone provides —
      // the deficit direction `noPlainSalt` did not used to cover.
      residualPercent: -2.3542,
      needsPercent: 2.6042,
      saltBearingPercent: 0.25,
    });
  });

  it('refuses rather than dropping the residual when the named plain-salt row carries no weight', () => {
    // Should-fix 2 from the #1402 review: guarding on `plain.length === 0` instead
    // of `plainPercent === 0` let a 0 g plain-salt row slip past both branches and
    // have its residual silently rounded to zero and written back — "a quietly less
    // salty cure", which is the exact harm `noPlainSalt`'s own comment names.
    // Built directly rather than through `deriveFormula`, which refuses a 0 g
    // component outright (`invalidAmount`) — a stored formula can still reach this
    // shape by hand-clearing a row's weight without removing it.
    const formula: Formula = {
      recipeId: 'recipe-1',
      schemaVersion: 1,
      components: [
        { ingredientId: 'ing-meat', percent: 100, inBasis: true, stageId: null },
        {
          ingredientId: 'ing-salt',
          percent: 0,
          inBasis: false,
          saltProduct: 'plain',
          stageId: null,
        },
        {
          ingredientId: 'ing-cure',
          percent: 2.6,
          inBasis: false,
          saltProduct: 'nitritedCuringSalt',
          minPercent: 2,
          maxPercent: 3.15,
          stageId: null,
        },
      ],
      referenceYield: { kind: 'basis', grams: 1000 },
      target: null,
    };
    const result = withCureSaltSubstituted(formula, { to: 'cure1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('noPlainSalt');
  });

  it('never crosses a pair, in either direction or onto plain salt', () => {
    // CROSSING CHANGES WHAT THE CURE IS FIT FOR, not merely its concentration —
    // which is the suitability question Salt deliberately does not ask.
    const nitriteOnly = pairedFormula({ product: 'cure1', grams: 2.5 });
    for (const to of ['cure2', 'salvianda', 'cure1', 'plain'] as const) {
      expect(withCureSaltSubstituted(nitriteOnly, { to }).ok).toBe(false);
    }
    const nitrateBearing = pairedFormula({ product: 'cure2', grams: 2.5 });
    for (const to of ['cure1', 'nitritedCuringSalt', 'cure2', 'plain'] as const) {
      expect(withCureSaltSubstituted(nitrateBearing, { to }).ok).toBe(false);
    }
  });

  it('pairs products that agree about nitrate, and pairs nothing else', () => {
    // THE PAIRING CHECKED AGAINST THE COMPOSITIONS rather than trusted: a pair
    // written the wrong way round would put a nitrate-bearing product opposite a
    // nitrite-only one, and this is what goes red for it.
    for (const [one, other] of CURE_SALT_PAIRS) {
      const carries = (product: SaltProduct) => CURE_SALT_PRODUCTS[product].nitratePercent > 0;
      expect(carries(one)).toBe(carries(other));
      expect(pairOf(one)).toBe(other);
      expect(pairOf(other)).toBe(one);
    }
    // Every curing product has exactly one partner; plain salt has none.
    for (const product of CURING) expect(pairOf(product)).not.toBeNull();
    expect(pairOf('plain')).toBeNull();
  });

  it('restamps the substitute’s own window, and agrees with the table on every component that names one', () => {
    // ONE PLACE DECIDES A WINDOW FOR A NAMED PRODUCT, and this is what keeps that
    // true across the swap: no component NAMING A PRODUCT may carry a window that
    // product does not dictate. Stamp a figure here, or leave the replaced
    // product's window behind, and this fails.
    //
    // NARROWED FROM "no component ... disagrees with it" (#1402 review, should-fix
    // 3): that unqualified claim was false as stated, because a component naming NO
    // product may legitimately carry a caller's own bounds (`boundsOn`'s precedence
    // rule in `deriveFormula`, and `withComponentPercentScaled`'s leavening stamp).
    // `pairedFormula` never included one, so the over-broad half of the old
    // assertion could not fail on the case that falsifies it. `ing-yeast` here is
    // that case: it carries hand-declared bounds, no `saltProduct`, and the
    // substitution must leave it exactly as it arrived.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 25, inBasis: false, saltProduct: 'plain' },
        { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
        {
          ingredientId: 'ing-yeast',
          grams: 10,
          inBasis: false,
          minPercent: 0.2,
          maxPercent: 2.5,
        },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    const result = withCureSaltSubstituted(derived.formula, { to: 'nitritedCuringSalt' });
    if (!result.ok) throw new Error('expected a substitution');

    for (const component of result.formula.components) {
      if (component.saltProduct === undefined) continue;
      const expected = saltProductBounds(component.saltProduct);
      expect(component.minPercent).toBe(expected.minPercent);
      expect(component.maxPercent).toBe(expected.maxPercent);
    }
    // THE CASE THAT FALSIFIES THE UNQUALIFIED CLAIM: untouched, caller-declared
    // bounds on a component naming no product.
    const yeast = result.formula.components.find((c) => c.ingredientId === 'ing-yeast');
    expect(yeast).toMatchObject({ minPercent: 0.2, maxPercent: 2.5 });

    const cure = result.formula.components.find((c) => c.ingredientId === 'ing-cure');
    expect(cure).toMatchObject({
      saltProduct: 'nitritedCuringSalt',
      minPercent: 2,
      maxPercent: 3.15,
    });
  });

  it('checks no dose itself — an out-of-window result is the solve’s to refuse', () => {
    // Cure #1 at 0.16% is inside ITS window; the same nitrite as nitrited curing
    // salt is 1.667%, which is below that product's 2% floor. The substitution
    // happily returns it and `solveFormula` refuses it, naming the window — exactly
    // as it refuses a hand-typed percentage. There is no second check.
    const result = withCureSaltSubstituted(pairedFormula({ product: 'cure1', grams: 1.6 }), {
      to: 'nitritedCuringSalt',
    });
    if (!result.ok) throw new Error('expected a substitution');
    const solved = solveFormula(result.formula);
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.reason.kind).toBe('boundViolation');
    if (solved.reason.kind !== 'boundViolation') return;
    expect(solved.reason.violations[0]).toMatchObject({
      ingredientId: 'ing-cure',
      bound: 'min',
      minPercent: 2,
      maxPercent: 3.15,
    });
  });

  it('leaves the formula it was given untouched', () => {
    const original = pairedFormula({ product: 'cure1', grams: 2.5 });
    const before = JSON.stringify(original);
    withCureSaltSubstituted(original, { to: 'nitritedCuringSalt' });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('splits the residual across several plain-salt rows in proportion', () => {
    // THE STATED BOUNDARY of the exact-round-trip claim above (CLAUDE.md rule 12).
    // Two plain rows share the residual in proportion to what they already hold, and
    // each is re-rounded — so the total is preserved but a round trip can land a
    // ten-thousandth of a point from where it started.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 20, inBasis: false, saltProduct: 'plain' },
        { ingredientId: 'ing-flakes', grams: 5, inBasis: false, saltProduct: 'plain' },
        { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    const result = withCureSaltSubstituted(derived.formula, { to: 'nitritedCuringSalt' });
    if (!result.ok) throw new Error('expected a substitution');
    const salt = percentOf(result.formula, 'ing-salt');
    const flakes = percentOf(result.formula, 'ing-flakes');
    // 4 : 1, as they went in — 0.11664 and 0.02916 of an exact 0.1458 residual,
    // each rounded to the four decimals every percentage here is stored at. The
    // total is preserved; the RATIO is now 3.993 rather than 4, which is the whole
    // of the cost and the reason the round-trip claim above is stated for one row.
    expect(salt).toBe(0.1166);
    expect(flakes).toBe(0.0292);
    expect(salt + flakes).toBeCloseTo(0.1458, 10);
  });

  it('refuses a formula naming more than one curing salt', () => {
    // No single answer to "which one is being swapped", so it is refused rather
    // than guessed at — and `batchService` relies on exactly this to find the
    // substituted row by its product.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 25, inBasis: false, saltProduct: 'plain' },
        { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
        { ingredientId: 'ing-cure-2', grams: 2.5, inBasis: false, saltProduct: 'cure2' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(withCureSaltSubstituted(derived.formula, { to: 'nitritedCuringSalt' }).ok).toBe(false);
  });

  it('refuses a formula that names no curing salt at all', () => {
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-flour', grams: 500, inBasis: true },
        { ingredientId: 'ing-salt', grams: 10, inBasis: false, saltProduct: 'plain' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    expect(withCureSaltSubstituted(derived.formula, { to: 'cure1' }).ok).toBe(false);
  });
});

describe('plain salt is a member of the enum and not of the rail', () => {
  it('bounds a component named plain by nothing at all', () => {
    // A WINDOW IS A FACT ABOUT NITRITE, and ordinary salt carries none. Naming it
    // therefore bounds it exactly as naming nothing does — 40% of plain salt is a
    // dish nobody eats, which is a taste failure and not this rail's business.
    const derived = deriveFormula({
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'ing-meat', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 400, inBasis: false, saltProduct: 'plain' },
      ],
    });
    if (!derived.ok) throw new Error('expected a derive');
    const salt = derived.formula.components.find((c) => c.ingredientId === 'ing-salt');
    expect(salt).toMatchObject({ saltProduct: 'plain' });
    expect(salt?.minPercent).toBeUndefined();
    expect(salt?.maxPercent).toBeUndefined();
    expect(solveFormula(derived.formula).ok).toBe(true);
  });

  it('is never PROPOSED by the recogniser, however the line is worded', () => {
    // THE DECISION BEHIND `plain`'s EMPTY KEYWORD LIST. Bare "salt" is the obvious
    // keyword and it is the wrong one: word-boundary matched it reaches "pink curing
    // salt" and "curing salt" — the lines the table deliberately refuses to guess at
    // — and a confident "Plain salt" on a curing salt is worse than "you pick".
    for (const text of [
      '10 g salt',
      '25 g sea salt',
      '25 g fine sea salt',
      '30 g pink curing salt',
      '30 g curing salt',
    ]) {
      expect(guessSaltProduct({ canonName: null, rawText: text })).not.toBe('plain');
    }
    expect(CURE_SALT_PRODUCTS.plain.keywords).toEqual([]);
  });
});
