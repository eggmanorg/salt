import { describe, it, expect } from 'vitest';
import { deriveFormula, gramsAtStrength, solveFormula, statedStrength } from '../../src/index.js';
import type { FormulaComponent } from '../../src/schemas/index.js';

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
