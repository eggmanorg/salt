import { describe, it, expect } from 'vitest';
import { guessBasisIngredientIds, looksScalable } from '../../src/index.js';
import { BASIS_KEYWORDS } from '../../src/formula/index.js';
import type { BasisGuessEntry } from '../../src/formula/index.js';
// The basis guess (issue #806). It exists to save the common case a tap, not to
// be right — the mapping screen shows what it picked and every row toggles — so
// these tests pin the SHAPE of the guess (canon leads, raw text is the fallback,
// word boundaries hold) rather than trying to enumerate every flour in the world.

function entry(over: Partial<BasisGuessEntry> & { ingredientId: string }): BasisGuessEntry {
  return { canonName: null, rawText: '', ...over };
}

describe('guessBasisIngredientIds', () => {
  it('picks the flours out of a real loaf', () => {
    // The overnight white tin as it exists in Salt today.
    const ids = guessBasisIngredientIds([
      entry({ ingredientId: 'ing-flour', canonName: 'strong white flour' }),
      entry({ ingredientId: 'ing-water', canonName: 'water' }),
      entry({ ingredientId: 'ing-salt', canonName: 'salt' }),
      entry({ ingredientId: 'ing-yeast', canonName: 'instant yeast' }),
      entry({ ingredientId: 'ing-oil', canonName: 'olive oil' }),
    ]);
    expect(ids).toEqual(['ing-flour']);
  });

  it('picks BOTH flours in a two-flour recipe, in the order given', () => {
    // The case that makes the basis a set rather than a single ingredient: the
    // second tier of the formula (70% strong white / 30% wholemeal).
    const ids = guessBasisIngredientIds([
      entry({ ingredientId: 'ing-white', canonName: 'strong white flour' }),
      entry({ ingredientId: 'ing-water', canonName: 'water' }),
      entry({ ingredientId: 'ing-wholemeal', canonName: 'wholemeal flour' }),
    ]);
    expect(ids).toEqual(['ing-white', 'ing-wholemeal']);
  });

  it('falls back to the raw line when an ingredient never matched canon', () => {
    // An unmatched ingredient is exactly the one still worth guessing at.
    const ids = guessBasisIngredientIds([
      entry({ ingredientId: 'ing-1', rawText: '500 g strong white bread flour' }),
      entry({ ingredientId: 'ing-2', rawText: '350 g water' }),
    ]);
    expect(ids).toEqual(['ing-1']);
  });

  it('prefers the canon name over the raw line', () => {
    // "plus extra flour for dusting" is a note about the bench, not a component.
    // Canon resolved the line to butter, and canon leads.
    const ids = guessBasisIngredientIds([
      entry({
        ingredientId: 'ing-butter',
        canonName: 'butter',
        rawText: '30 g butter, plus extra flour for dusting',
      }),
    ]);
    expect(ids).toEqual([]);
  });

  it('matches on whole words, not substrings', () => {
    const ids = guessBasisIngredientIds([
      entry({ ingredientId: 'ing-1', canonName: 'cornflour-free baking powder' }),
      entry({ ingredientId: 'ing-2', canonName: 'plain flours' }),
    ]);
    // "cornflour" is one word and is not "flour"; "flours" is the plural and is.
    expect(ids).toEqual(['ing-2']);
  });

  it('is case-insensitive', () => {
    expect(
      guessBasisIngredientIds([entry({ ingredientId: 'ing-1', canonName: 'Strong White Flour' })]),
    ).toEqual(['ing-1']);
  });

  it('guesses nothing for a recipe with no flour, rather than guessing badly', () => {
    // A kraut's basis is the cabbage and a coppa's is the meat, and neither is
    // keyword-matchable honestly. An empty guess means "you pick".
    expect(
      guessBasisIngredientIds([
        entry({ ingredientId: 'ing-cabbage', canonName: 'white cabbage' }),
        entry({ ingredientId: 'ing-salt', canonName: 'sea salt' }),
      ]),
    ).toEqual([]);
  });

  it('is total on an empty list', () => {
    expect(guessBasisIngredientIds([])).toEqual([]);
  });

  it('keeps the keyword list short on purpose', () => {
    // A guard, not a assertion of taste: the list is allowed to grow, but growing
    // it silently past a handful means someone is building a taxonomy in here.
    expect(BASIS_KEYWORDS.length).toBeLessThanOrEqual(5);
  });
});

// The same guess asked as a gate (issue #823) — "is there a flour here at all?"
// — so the recipe page can decide whether to offer the mapping screen. These pin
// that it never disagrees with the guess it is built from: whatever the screen
// would preselect is exactly what makes the offer appear.
describe('looksScalable', () => {
  it('says yes to a loaf, by its canon names', () => {
    expect(
      looksScalable([
        entry({ ingredientId: 'ing-flour', canonName: 'strong white flour' }),
        entry({ ingredientId: 'ing-water', canonName: 'water' }),
        entry({ ingredientId: 'ing-salt', canonName: 'salt' }),
      ]),
    ).toBe(true);
  });

  it('says yes on the raw line alone, before canon has loaded', () => {
    // Canon arrives a beat after first paint, so the gate is asked at least once
    // with nothing resolved. The raw line is what carries it until then.
    expect(
      looksScalable([
        entry({ ingredientId: 'ing-1', rawText: '500 g strong white bread flour' }),
        entry({ ingredientId: 'ing-2', rawText: '350 g water' }),
      ]),
    ).toBe(true);
  });

  it('says no to an ordinary dinner', () => {
    // The whole point of the gate: baker's percentages stay off the curry.
    expect(
      looksScalable([
        entry({ ingredientId: 'ing-chicken', canonName: 'chicken thighs' }),
        entry({ ingredientId: 'ing-onion', canonName: 'onion' }),
        entry({ ingredientId: 'ing-cream', canonName: 'double cream' }),
      ]),
    ).toBe(false);
  });

  it('says no to an entry with no ingredients at all', () => {
    // A special and a placeholder both flatten to nothing, and neither is
    // scalable. Totality here is what keeps the caller free of its own guard.
    expect(looksScalable([])).toBe(false);
  });

  it('agrees with the guess it is built from, case by case', () => {
    // The invariant that matters more than any single case above: the offer and
    // the preselection are the same decision, so they can never disagree.
    const cases: BasisGuessEntry[][] = [
      [entry({ ingredientId: 'a', canonName: 'plain flours' })],
      [entry({ ingredientId: 'a', canonName: 'cornflour-free baking powder' })],
      [entry({ ingredientId: 'a', canonName: 'fine semolina' })],
      [entry({ ingredientId: 'a', rawText: '300 g strong wholemeal' })],
      [entry({ ingredientId: 'a', canonName: 'butter', rawText: '30 g butter, extra flour' })],
      [],
    ];
    for (const entries of cases) {
      expect(looksScalable(entries)).toBe(guessBasisIngredientIds(entries).length > 0);
    }
  });
});
