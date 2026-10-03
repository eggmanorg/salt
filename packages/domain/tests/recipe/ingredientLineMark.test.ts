import { describe, it, expect } from 'vitest';
import {
  clearIngredientMatch,
  hasLiveCanonMatch,
  ingredientLineMark,
  ingredientMatchIssue,
} from '../../src/index.js';
import type { CanonItem, Ingredient, ProductForm } from '../../src/index.js';

// Every remedy `ingredientLineMark` names is a claim about what clears a mark
// (CLAUDE.md rule 12). Each block below APPLIES the remedy — as the ingredient
// shape it produces — and asserts the mark clears, or for a ladder moves to its
// next rung. What these cannot pin is model behaviour: that the parser does
// record a count, or arbitration does mint a form. Those are ladders for that
// reason.

const LIME: CanonItem = {
  id: 'canon-lime',
  schemaVersion: 5,
  name: 'lime',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  embedding: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

const WHOLE_CHICKEN: CanonItem = { ...LIME, id: 'canon-chicken', name: 'Whole Chicken' };

const LIME_JUICE: ProductForm = {
  id: 'form-lime-juice',
  schemaVersion: 1,
  matchers: [],
  thumbnail: null,
  parentCanonId: 'canon-lime',
  label: 'Lime juice',
  yield: { formUnit: 'ml', amountPerParent: 30 },
  updatedAt: '2026-08-19T00:00:00.000Z',
};

// Puts canon Lime within `missing_form`'s reach without bridging a juice line.
const LIME_ZEST: ProductForm = {
  ...LIME_JUICE,
  id: 'form-lime-zest',
  label: 'Lime zest',
  yield: { formUnit: 'g', amountPerParent: 5 },
};

const CHICKEN_BREAST: ProductForm = {
  ...LIME_JUICE,
  id: 'form-chicken-breast',
  parentCanonId: 'canon-chicken',
  label: 'Chicken breast',
  yield: { formUnit: 'count', amountPerParent: 2 },
};

const CANON = new Map([LIME, WHOLE_CHICKEN].map((c) => [c.id, c]));

function ing(over: Partial<Ingredient> = {}): Ingredient {
  return {
    id: 'ing-1',
    rawText: '90 ml lime juice',
    parsed: {
      quantity: { type: 'single', value: 90 },
      unit: 'ml',
      item: 'lime juice',
      preparation: [],
      notes: null,
      displayText: null,
    },
    canonId: 'canon-lime',
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
    ...over,
  };
}

/** "400 g chicken breasts", as the parse reads it; `statedCount` per case. */
function breasts(statedCount: NonNullable<Ingredient['parsed']>['statedCount']): Ingredient {
  return ing({
    rawText: '400 g chicken breasts',
    canonId: 'canon-chicken',
    parsed: {
      quantity: { type: 'single', value: 400 },
      unit: 'g',
      item: 'chicken breast',
      preparation: [],
      notes: null,
      displayText: null,
      ...(statedCount === undefined ? {} : { statedCount }),
    },
  });
}

/** The shape `matchIngredient` writes after a successful re-parse + canon match. */
function matched(line: Ingredient, parsed: Ingredient['parsed'], canonId: string): Ingredient {
  return { ...line, parsed, canonId, matchState: 'matched' };
}

/** The shape `matchIngredient` writes when the parse returns nothing. */
function unreadable(line: Ingredient): Ingredient {
  return { ...line, parsed: null, canonId: null, matchState: 'failed' };
}

const mark = (line: Ingredient, forms: readonly ProductForm[] = [LIME_JUICE]) =>
  ingredientLineMark(line, CANON, forms);

describe('ingredientLineMark — which lines are marked, and why', () => {
  it('is null for a clean line', () => {
    expect(mark(ing())).toBeNull();
  });

  it('names a never-matched line not_matched', () => {
    expect(mark(ing({ canonId: null, matchState: 'pending' }))).toEqual({
      issue: 'not_matched',
      remedy: 'match_again',
    });
  });

  it('names a canon-side failure not_matched — the line was read', () => {
    expect(mark(ing({ canonId: null, matchState: 'failed' }))).toEqual({
      issue: 'not_matched',
      remedy: 'match_again',
    });
  });

  it('names a failed line with nothing parsed unreadable', () => {
    expect(mark(unreadable(ing()))).toEqual({
      issue: 'unreadable',
      remedy: 'match_again_then_reword',
    });
  });

  it('names a match to a deleted canon dangling', () => {
    expect(mark(ing({ canonId: 'canon-gone' }))).toEqual({
      issue: 'dangling_canon',
      remedy: 'match_again',
    });
  });

  it('carries every ingredientMatchIssue kind through on a live line', () => {
    expect(mark(ing({ parsed: null }))?.issue).toBe('missing_amount');
    expect(mark(ing(), [LIME_ZEST])?.issue).toBe('missing_form');
    expect(mark(breasts(null), [CHICKEN_BREAST])?.issue).toBe('missing_count');
  });
});

describe('ingredientLineMark — every remedy, applied', () => {
  describe('match_again', () => {
    it('clears not_matched once the line is matched', () => {
      const line = ing({ canonId: null, matchState: 'pending', parsed: null });
      expect(mark(line)?.remedy).toBe('match_again');
      expect(mark(matched(line, ing().parsed, 'canon-lime'))).toBeNull();
    });

    it('clears dangling_canon once the line is matched to a live canon', () => {
      const line = ing({ canonId: 'canon-gone' });
      expect(mark(line)?.remedy).toBe('match_again');
      expect(mark(matched(line, line.parsed, 'canon-lime'))).toBeNull();
    });

    it('clears missing_amount once the re-parse reads an amount', () => {
      const line = ing({ parsed: null });
      expect(mark(line)).toEqual({ issue: 'missing_amount', remedy: 'match_again' });
      expect(mark(matched(line, ing().parsed, 'canon-lime'))).toBeNull();
    });

    it('turns missing_amount into unreadable — not clean — when the re-parse reads nothing', () => {
      // The boundary of "match again clears it": a parse that comes back empty is
      // a different mark with a different remedy, never a cleared one.
      expect(mark(unreadable(ing({ parsed: null })))?.issue).toBe('unreadable');
    });
  });

  describe('match_again_then_reword', () => {
    it('rung 1: a re-parse that reads the line clears it', () => {
      const line = unreadable(ing());
      expect(mark(matched(line, ing().parsed, 'canon-lime'))).toBeNull();
    });

    it('rung 2: rewording leaves a not_matched line, which matching then clears', () => {
      const line = unreadable(ing({ rawText: 'a good splash of the green stuff' }));
      const reworded = clearIngredientMatch({ ...line, rawText: '90 ml lime juice' });
      expect(mark(reworded)).toEqual({ issue: 'not_matched', remedy: 'match_again' });
      expect(mark(matched(reworded, ing().parsed, 'canon-lime'))).toBeNull();
    });
  });

  describe('match_again_then_add_form', () => {
    it('rung 2: a mass/volume form covering the line clears it', () => {
      const line = ing();
      expect(mark(line, [LIME_ZEST])).toEqual({
        issue: 'missing_form',
        remedy: 'match_again_then_add_form',
      });
      expect(mark(line, [LIME_ZEST, LIME_JUICE])).toBeNull();
    });

    it('a COUNT form covering the line is not a clear — it becomes missing_count', () => {
      // So nobody may claim "add a form" always clears a missing_form mark.
      const countedJuice: ProductForm = {
        ...LIME_JUICE,
        yield: { formUnit: 'count', amountPerParent: 1 },
      };
      expect(mark(ing(), [LIME_ZEST, countedJuice])?.issue).toBe('missing_count');
    });
  });

  describe('match_again_then_state_count — a counted line parsed before #1643', () => {
    it('is the remedy when the line has no statedCount key at all', () => {
      expect(mark(breasts(undefined), [CHICKEN_BREAST])).toEqual({
        issue: 'missing_count',
        remedy: 'match_again_then_state_count',
      });
    });

    it('rung 1: a re-parse that records a count clears it', () => {
      const line = breasts(undefined);
      const reRead = breasts({ type: 'single', value: 2 });
      expect(mark(matched(line, reRead.parsed, 'canon-chicken'), [CHICKEN_BREAST])).toBeNull();
    });

    it('rung 2: a re-parse that finds no count moves it to state_count', () => {
      const line = breasts(undefined);
      const reRead = breasts(null);
      expect(mark(matched(line, reRead.parsed, 'canon-chicken'), [CHICKEN_BREAST])).toEqual({
        issue: 'missing_count',
        remedy: 'state_count',
      });
    });
  });

  describe('state_count — a counted line the #1643 parse already read', () => {
    it('is the remedy when statedCount is null', () => {
      expect(mark(breasts(null), [CHICKEN_BREAST])).toEqual({
        issue: 'missing_count',
        remedy: 'state_count',
      });
    });

    it('matching again cannot clear it: the same words re-read are the same mark', () => {
      // The negative pin #1644's review asked for, and the reason the copy for
      // this remedy must not say "Match again".
      const line = breasts(null);
      const reMatched = matched(line, breasts(null).parsed, 'canon-chicken');
      expect(mark(reMatched, [CHICKEN_BREAST])).toEqual({
        issue: 'missing_count',
        remedy: 'state_count',
      });
    });

    it('editing the line to state a count, then matching it, clears it', () => {
      const reworded = clearIngredientMatch({ ...breasts(null), rawText: '2 chicken breasts' });
      expect(mark(reworded, [CHICKEN_BREAST])?.issue).toBe('not_matched');
      const reRead = breasts({ type: 'single', value: 2 });
      expect(mark(matched(reworded, reRead.parsed, 'canon-chicken'), [CHICKEN_BREAST])).toBeNull();
    });
  });
});

describe('ingredientLineMark — the marked set is exactly the recipe page’s', () => {
  // The page's rule before this query existed: ✗ for no live match, then
  // whatever `ingredientMatchIssue` says. The query must not add or drop a line.
  const forms = [LIME_ZEST, CHICKEN_BREAST];
  const lines: Ingredient[] = [
    ing(),
    ing({ canonId: null, matchState: 'pending' }),
    ing({ canonId: null, matchState: 'pending', parsed: null }),
    ing({ canonId: null, matchState: 'failed' }),
    unreadable(ing()),
    ing({ canonId: 'canon-gone' }),
    ing({ canonId: 'canon-gone', parsed: null }),
    ing({ canonId: 'canon-lime', matchState: 'pending' }),
    ing({ canonId: 'canon-lime', matchState: 'failed' }),
    ing({ parsed: null }),
    breasts(undefined),
    breasts(null),
    breasts({ type: 'single', value: 2 }),
    ing({
      canonId: 'canon-chicken',
      parsed: {
        quantity: { type: 'single', value: 1600 },
        unit: 'g',
        item: 'whole chicken',
        preparation: [],
        notes: null,
        displayText: null,
      },
    }),
  ];

  it.each(lines.map((l, i) => [i, l] as const))('line %i', (_i, line) => {
    const live = hasLiveCanonMatch(line, new Set(CANON.keys()));
    const issue = ingredientMatchIssue(line, CANON, forms);
    const result = ingredientLineMark(line, CANON, forms);
    expect(result !== null).toBe(!live || issue !== null);
    if (live) expect(result?.issue ?? null).toBe(issue);
  });
});
