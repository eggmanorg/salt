import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Ingredient, ParsedIngredient, Quantity } from '@salt/domain';

import IngredientText from '../src/routes/recipes/IngredientText.svelte';

// Scaling an ingredient line (issue #1314). It happens HERE and at none of the
// eight call sites, which is the whole reason the recipe page, cook mode and
// guided cook cannot disagree about what 6 servings of something is.
//
// The fixtures are built against `packages/domain/src/schemas/recipe.ts`
// deliberately: `apps/web-pwa/tsconfig.json` covers `src/**` only, so a
// structurally invalid fixture here would not be caught by `pnpm typecheck`.

function single(value: number): Quantity {
  return { type: 'single', value };
}

function makeParsed(over: Partial<ParsedIngredient>): ParsedIngredient {
  return {
    quantity: null,
    unit: null,
    item: '',
    preparation: [],
    notes: null,
    displayText: null,
    ...over,
  };
}

function makeIngredient(rawText: string, parsed: ParsedIngredient | null): Ingredient {
  return {
    id: 'ing-1',
    rawText,
    parsed,
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const FLOUR = makeIngredient(
  '300g strong white flour',
  makeParsed({ quantity: single(300), unit: 'g', item: 'strong white flour' }),
);

const EGGS = makeIngredient('3 eggs', makeParsed({ quantity: single(3), unit: null, item: 'egg' }));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function textAt(ingredient: Ingredient, scale: number, part: 'all' | 'quantity' = 'all'): string {
  const { container } = render(IngredientText, { props: { ingredient, part, scale } });
  return container.textContent ?? '';
}

describe('IngredientText — scale', () => {
  it('renders exactly as before at scale 1', () => {
    expect(textAt(FLOUR, 1)).toBe('300g strong white flour');
    expect(textAt(EGGS, 1)).toBe('3 eggs');
  });

  it('restates a measured amount', () => {
    expect(textAt(FLOUR, 1.5, 'quantity')).toBe('450g');
    expect(textAt(FLOUR, 0.5, 'quantity')).toBe('150g');
  });

  it('writes a scaled count as a fraction, not a decimal', () => {
    // 3 eggs at 6/4 servings is 4.5 — a cook reads "4½", nobody reads "4.5 eggs".
    expect(textAt(EGGS, 1.5, 'quantity')).toBe('4½');
  });

  it('agrees the item plural with the SCALED amount, not the stated one', () => {
    // 1 egg scaled up is eggs; the stored item stays singular.
    const one = makeIngredient(
      '1 egg',
      makeParsed({ quantity: single(1), unit: null, item: 'egg' }),
    );
    expect(textAt(one, 1)).toBe('1 egg');
    expect(textAt(one, 3)).toBe('3 eggs');
  });

  it('suppresses the source’s own second measure while scaled', () => {
    // "1 ½ cups" is a verbatim restating of the amount the recipe STATES. Beside a
    // rescaled figure it is a second number on the row that is simply false, and
    // recomputing it is not this app's to do — it is the source's wording.
    const cups = makeIngredient(
      '1 ½ cups flour',
      makeParsed({
        quantity: single(300),
        unit: 'g',
        item: 'flour',
        displayText: '1 ½ cups',
      }),
    );
    expect(textAt(cups, 1)).toContain('(1 ½ cups)');
    expect(textAt(cups, 2)).not.toContain('cups');
    expect(textAt(cups, 2)).toContain('600g');
  });

  it('scales a range end by end, and keeps it a range', () => {
    // "2–3 tbsp olive oil" parses to a 30–45 ml range. Both ends move; neither is
    // collapsed to a single figure, because which end a range MEANS is
    // `quantityToNumber`'s decision (issue #917) and the display must not grow a
    // second opinion about it.
    const oil = makeIngredient(
      '2–3 tbsp olive oil',
      makeParsed({ quantity: { type: 'range', min: 30, max: 45 }, unit: 'ml', item: 'olive oil' }),
    );
    expect(textAt(oil, 1, 'quantity')).toBe('30–45ml');
    expect(textAt(oil, 2, 'quantity')).toBe('60–90ml');
    // A range's plural agreement reads its upper bound, scaled or not.
    const cloves = makeIngredient(
      '1–2 garlic cloves',
      makeParsed({ quantity: { type: 'range', min: 1, max: 2 }, unit: null, item: 'garlic clove' }),
    );
    expect(textAt(cloves, 1)).toBe('1–2 garlic cloves');
    expect(textAt(cloves, 2)).toBe('2–4 garlic cloves');
  });

  it('leaves a line with no separable amount alone at any scale', () => {
    // An unparsed line, and a line parsed to no quantity, carry their raw text
    // verbatim — scaling has nothing to multiply and must not invent anything.
    const unparsed = makeIngredient('A crack of black pepper', null);
    expect(textAt(unparsed, 3)).toBe('A crack of black pepper');
    const noQuantity = makeIngredient(
      'Salt, to taste',
      makeParsed({ quantity: null, item: 'salt' }),
    );
    expect(textAt(noQuantity, 3)).toBe('Salt, to taste');
  });
});
