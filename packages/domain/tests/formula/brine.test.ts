import { describe, it, expect } from 'vitest';
import {
  basisYield,
  deriveFormula,
  gramsAtStrength,
  solveFormula,
  statedStrength,
  withBasisWeighed,
} from '../../src/index.js';
import type { Formula, FormulaComponent } from '../../src/schemas/index.js';

// A salt read against one basis member (issue #1657). The figures are the issue's own
// worked example: 1 kg cucumbers + 1 kg water + 30 g salt reads 1.5% of the basis
// and 3% of the water.

const component = (patch: Partial<FormulaComponent> & { ingredientId: string }) =>
  ({
    percent: 0,
    inBasis: false,
    stageId: null,
    statedOf: null,
    ...patch,
  }) satisfies FormulaComponent;

const PICKLE: FormulaComponent[] = [
  component({ ingredientId: 'ing-cucumber', percent: 50, inBasis: true }),
  component({ ingredientId: 'ing-water', percent: 50, inBasis: true }),
  component({
    ingredientId: 'ing-salt',
    percent: 1.5,
    saltProduct: 'plain',
    statedOf: 'ing-water',
  }),
];

describe('statedStrength', () => {
  it('reads 1.5% of the basis as 3% of a member that is half of it', () => {
    const salt = PICKLE[2];
    if (salt === undefined) throw new Error('fixture');
    expect(statedStrength(salt, PICKLE)).toEqual({ ingredientId: 'ing-water', percent: 3 });
  });

  it('is null for a line stated against the whole basis', () => {
    const salt = { ...PICKLE[2], statedOf: null } as FormulaComponent;
    expect(statedStrength(salt, PICKLE)).toBeNull();
  });

  it('is null when the name does not resolve to a basis member — a stored document is not a derived one', () => {
    const salt = PICKLE[2] as FormulaComponent;
    const waterOut = PICKLE.map((c) =>
      c.ingredientId === 'ing-water' ? { ...c, inBasis: false } : c,
    );
    expect(statedStrength(salt, waterOut)).toBeNull();
    expect(statedStrength({ ...salt, statedOf: 'ing-gone' }, PICKLE)).toBeNull();
    const waterZero = PICKLE.map((c) =>
      c.ingredientId === 'ing-water' ? { ...c, percent: 0 } : c,
    );
    expect(statedStrength(salt, waterZero)).toBeNull();
  });

  it('is null for a curing salt carrying a stated member — a cure is a percentage of the meat', () => {
    const salt = { ...PICKLE[2], saltProduct: 'cure1' } as FormulaComponent;
    expect(statedStrength(salt, PICKLE)).toBeNull();
    expect(statedStrength({ ...salt, saltProduct: undefined }, PICKLE)).toBeNull();
  });

  it('agrees with what the solve weighs out: salt grams ÷ water grams', () => {
    const derived = deriveFormula({
      recipeId: 'r1',
      components: [
        { ingredientId: 'ing-cucumber', grams: 1200, inBasis: true },
        { ingredientId: 'ing-water', grams: 1500, inBasis: true },
        {
          ingredientId: 'ing-salt',
          grams: 45,
          inBasis: false,
          saltProduct: 'plain',
          statedOf: 'ing-water',
        },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    const salt = derived.formula.components.find((c) => c.ingredientId === 'ing-salt');
    if (salt === undefined) throw new Error('no salt');
    // NOT EXACTLY 3, and that is the stated boundary: the stored percentages are
    // themselves rounded to four decimals (1.6667 and 55.5556), so the ratio of the
    // two carries their rounding — 3.0001 here, a ten-thousandth of a point that no
    // screen prints and no scale weighs.
    expect(statedStrength(salt, derived.formula.components)?.percent).toBeCloseTo(3, 3);

    const solved = solveFormula(derived.formula);
    if (!solved.ok) throw new Error(solved.reason.kind);
    const grams = new Map(solved.solution.components.map((c) => [c.ingredientId, c.grams]));
    expect(grams.get('ing-salt')).toBe(45);
    expect(grams.get('ing-water')).toBe(1500);
  });
});

describe('gramsAtStrength', () => {
  it('holds 3% of the water at 45 g when the water becomes 1.5 kg', () => {
    expect(gramsAtStrength(3, 1500)).toBe(45);
  });

  it('is exact, leaving rounding to the one authority downstream', () => {
    expect(gramsAtStrength(3, 1234)).toBeCloseTo(37.02, 10);
  });
});

// ─── Weighing each part of the basis (issue #1657, phase 2) ───────────────────
//
// The issue's own table, row by row, solved end to end through the unchanged
// `solveFormula` at the basis the re-split hands back.

/** A formula derived from grams, as every stored formula is. */
function derived(components: Parameters<typeof deriveFormula>[0]['components']): Formula {
  const result = deriveFormula({ recipeId: 'r1', components });
  if (!result.ok) throw new Error(result.reason.kind);
  return result.formula;
}

/** The pickle: 1 kg cucumbers + 1 kg water, salt 3% of the water. */
const pickle = (statedOf: string | null = 'ing-water') =>
  derived([
    { ingredientId: 'ing-cucumber', grams: 1000, inBasis: true },
    { ingredientId: 'ing-water', grams: 1000, inBasis: true },
    { ingredientId: 'ing-salt', grams: 30, inBasis: false, saltProduct: 'plain', statedOf },
  ]);

/** Weigh `formula` by member and solve it: grams by ingredient, as the scale reads. */
function weighOut(formula: Formula, typed: Record<string, number>): Map<string, number> {
  const weighed = withBasisWeighed(formula, new Map(Object.entries(typed)));
  if (weighed === null) throw new Error('nothing weighed');
  const solved = solveFormula(weighed.formula, basisYield(weighed.basisGrams));
  if (!solved.ok) throw new Error(solved.reason.kind);
  return new Map(solved.solution.components.map((c) => [c.ingredientId, c.grams]));
}

describe('withBasisWeighed — the issue’s table', () => {
  it('1.2 kg cucumbers, water left blank: the water follows to 1.2 kg and the salt is 36 g', () => {
    const grams = weighOut(pickle(), { 'ing-cucumber': 1200 });
    expect(grams.get('ing-water')).toBe(1200);
    expect(grams.get('ing-salt')).toBe(36);
  });

  it('1.2 kg cucumbers and 1.5 kg water: the salt holds 3% of the water at 45 g', () => {
    const grams = weighOut(pickle(), { 'ing-cucumber': 1200, 'ing-water': 1500 });
    expect(grams.get('ing-cucumber')).toBe(1200);
    expect(grams.get('ing-water')).toBe(1500);
    expect(grams.get('ing-salt')).toBe(45);
  });

  it('2% of the basis, 1 kg cabbage and 0.8 kg water: 2% of everything in the jar is 36 g', () => {
    const kraut = derived([
      { ingredientId: 'ing-cabbage', grams: 1000, inBasis: true },
      { ingredientId: 'ing-water', grams: 1000, inBasis: true },
      { ingredientId: 'ing-salt', grams: 40, inBasis: false, saltProduct: 'plain' },
    ]);
    const grams = weighOut(kraut, { 'ing-cabbage': 1000, 'ing-water': 800 });
    expect(grams.get('ing-salt')).toBe(36);
  });
});

describe('withBasisWeighed — the four things it does', () => {
  it('re-measures the basis to the weighed ratio, reconciled to exactly 100', () => {
    // Three members typed to thirds: each floors to 33.3333 and the residual unit
    // goes to one of them, as `deriveFormula` itself does.
    const loaf = derived([
      { ingredientId: 'a', grams: 100, inBasis: true },
      { ingredientId: 'b', grams: 200, inBasis: true },
      { ingredientId: 'c', grams: 300, inBasis: true },
      { ingredientId: 'salt', grams: 12, inBasis: false },
    ]);
    const weighed = withBasisWeighed(
      loaf,
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
    );
    if (weighed === null) throw new Error('nothing weighed');
    const basis = weighed.formula.components.filter((c) => c.inBasis).map((c) => c.percent);
    expect([...basis].sort()).toEqual([33.3333, 33.3333, 33.3334]);
    const units = basis.reduce((sum, percent) => sum + Math.round(percent * 10_000), 0);
    expect(units).toBe(1_000_000);
    expect(weighed.basisGrams).toBe(3);
  });

  it('leaves every other line’s percentage as it was — a curing salt stays a percentage of the meat', () => {
    // A salami: pork and back fat as the basis, Cure #1 inside its window.
    const salami = derived([
      { ingredientId: 'ing-pork', grams: 800, inBasis: true },
      { ingredientId: 'ing-fat', grams: 200, inBasis: true },
      { ingredientId: 'ing-salt', grams: 25, inBasis: false, saltProduct: 'plain' },
      { ingredientId: 'ing-cure', grams: 2.5, inBasis: false, saltProduct: 'cure1' },
      { ingredientId: 'ing-pepper', grams: 3, inBasis: false },
    ]);
    const weighed = withBasisWeighed(
      salami,
      new Map([
        ['ing-pork', 900],
        ['ing-fat', 300],
      ]),
    );
    if (weighed === null) throw new Error('nothing weighed');
    const before = new Map(salami.components.map((c) => [c.ingredientId, c]));
    for (const component of weighed.formula.components) {
      if (component.inBasis) continue;
      // The whole component, bounds and all — nothing but a basis member moved.
      expect(component).toEqual(before.get(component.ingredientId));
    }
    const solved = solveFormula(weighed.formula, basisYield(weighed.basisGrams));
    if (!solved.ok) throw new Error(solved.reason.kind);
    expect(solved.solution.components.find((c) => c.ingredientId === 'ing-cure')?.grams).toBe(3);
  });

  it('holds a stated strength against the member’s new grams, and reads back as that strength', () => {
    const weighed = withBasisWeighed(
      pickle(),
      new Map([
        ['ing-cucumber', 1200],
        ['ing-water', 1500],
      ]),
    );
    if (weighed === null) throw new Error('nothing weighed');
    const salt = weighed.formula.components.find((c) => c.ingredientId === 'ing-salt');
    if (salt === undefined) throw new Error('no salt');
    expect(salt.statedOf).toBe('ing-water');
    expect(statedStrength(salt, weighed.formula.components)?.percent).toBeCloseTo(3, 3);
  });

  it('moves a salt stated against the whole basis only with the basis', () => {
    const weighed = withBasisWeighed(
      pickle(null),
      new Map([
        ['ing-cucumber', 1200],
        ['ing-water', 1500],
      ]),
    );
    expect(weighed?.formula.components.find((c) => c.ingredientId === 'ing-salt')?.percent).toBe(
      1.5,
    );
  });

  it('hands back the basis total, typed and followed members added up', () => {
    const weighed = withBasisWeighed(pickle(), new Map([['ing-cucumber', 1200]]));
    expect(weighed?.basisGrams).toBe(2400);
  });

  it('lets a blank member follow the typed ones in aggregate, at the recipe’s ratio', () => {
    // 50 / 30 / 20: typing a and b (60 + 40 g against 80% of the basis) puts c at
    // 20% × 100 g ÷ 80% = 25 g, on a basis of 125 g.
    const three = derived([
      { ingredientId: 'a', grams: 500, inBasis: true },
      { ingredientId: 'b', grams: 300, inBasis: true },
      { ingredientId: 'c', grams: 200, inBasis: true },
    ]);
    const weighed = withBasisWeighed(
      three,
      new Map([
        ['a', 60],
        ['b', 40],
      ]),
    );
    expect(weighed?.basisGrams).toBeCloseTo(125, 10);
    expect(weighOut(three, { a: 60, b: 40 }).get('c')).toBe(25);
  });

  it('writes nothing back: the formula it was handed is untouched', () => {
    const formula = pickle();
    const copy = structuredClone(formula);
    withBasisWeighed(
      formula,
      new Map([
        ['ing-cucumber', 1200],
        ['ing-water', 1500],
      ]),
    );
    expect(formula).toEqual(copy);
  });
});

describe('withBasisWeighed — nothing weighed', () => {
  it('is null when no basis member carries a usable figure', () => {
    const formula = pickle();
    expect(withBasisWeighed(formula, new Map())).toBeNull();
    // A line outside the basis is not a basis weight.
    expect(withBasisWeighed(formula, new Map([['ing-salt', 30]]))).toBeNull();
    // Nor is a figure no scale reads.
    expect(withBasisWeighed(formula, new Map([['ing-water', 0]]))).toBeNull();
    expect(withBasisWeighed(formula, new Map([['ing-water', -5]]))).toBeNull();
    expect(withBasisWeighed(formula, new Map([['ing-water', Number.NaN]]))).toBeNull();
  });

  it('ignores an unusable figure beside a usable one — that box follows like a blank', () => {
    const grams = weighOut(pickle(), { 'ing-cucumber': 1200, 'ing-water': Number.NaN });
    expect(grams.get('ing-water')).toBe(1200);
  });

  it('is null when the typed members hold no share of a hand-edited basis to follow', () => {
    const edited: Formula = {
      ...pickle(),
      components: pickle().components.map((c) =>
        c.ingredientId === 'ing-cucumber' ? { ...c, percent: 0 } : c,
      ),
    };
    expect(withBasisWeighed(edited, new Map([['ing-cucumber', 1200]]))).toBeNull();
  });
});
