import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Ingredient, ParsedIngredient, Quantity } from '@salt/domain';

import IngredientText from '../src/routes/recipes/IngredientText.svelte';

// The first dedicated coverage for the component that writes every ingredient line
// in the app — the recipe page's three columns and, as `part="all"`, cook mode's
// and guided mode's rows.
//
// What it pins is the distinction the component used to miss (issue #951): a COUNT
// (`unit: null` WITH a `quantity` — "1 large egg", "4 garlic cloves") is a complete
// parse whose amount happens to carry no unit, and it splits into name and amount
// exactly as a metric line does. An UNPARSED line, and a line parsed to no quantity
// at all, still render their raw text verbatim with an empty amount column — that is
// what holds a part-parsed list straight, and issue #949's rows depend on it.
//
// Fixtures are built against `packages/domain/src/schemas/recipe.ts` deliberately:
// `apps/web-pwa/tsconfig.json` covers `src/**` only, so a structurally invalid
// fixture here would not be caught by `pnpm typecheck`.

// ─── Fixtures ────────────────────────────────────────────────────────────────

function single(value: number): Quantity {
  return { type: 'single', value };
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

// "1 large egg" — a count, as stored in staging today.
const COUNT = makeIngredient(
  '1 large egg',
  makeParsed({ quantity: single(1), unit: null, item: 'large egg', displayText: 'about 50g' }),
);

// "4 garlic cloves, peeled and finely sliced" — a count whose stored `item` is
// SINGULAR against a quantity of 4, which is what the render-time pluralisation
// exists for.
const COUNT_PLURAL = makeIngredient(
  '4 garlic cloves, peeled and finely sliced',
  makeParsed({
    quantity: single(4),
    unit: null,
    item: 'garlic clove',
    preparation: ['peeled and finely sliced'],
  }),
);

// The same shape, but the parse already stored the plural.
const COUNT_ALREADY_PLURAL = makeIngredient(
  '2 large eggs',
  makeParsed({ quantity: single(2), unit: null, item: 'large eggs' }),
);

// "½ clove garlic (about 3 g), finely minced" — a mixed quantity on a count line.
const COUNT_MIXED = makeIngredient(
  '½ clove garlic (about 3 g), finely minced',
  makeParsed({
    quantity: { type: 'mixed', whole: 0, numerator: 1, denominator: 2 },
    unit: null,
    item: 'garlic clove',
  }),
);

// The row every metric line in the library renders as, and must keep rendering as.
const METRIC = makeIngredient(
  '1 ½ cups red lentils, rinsed',
  makeParsed({
    quantity: single(300),
    unit: 'g',
    item: 'red lentils',
    preparation: ['rinsed'],
    displayText: '1 ½ cups',
  }),
);

// Genuinely unparsed — issue #949's rows, and the fallback that must survive.
const UNPARSED = makeIngredient('A jug of gravy, warmed', null);

// Parsed, but there is no separable amount to lift out.
const NO_QUANTITY = makeIngredient(
  'A crack of black pepper',
  makeParsed({ quantity: null, unit: null, item: 'black pepper' }),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textOf(ingredient: Ingredient, part?: 'all' | 'quantity' | 'name' | 'display'): string {
  const { container } = render(IngredientText, {
    props: part === undefined ? { ingredient } : { ingredient, part },
  });
  return container.textContent ?? '';
}

afterEach(cleanup);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IngredientText — a count is an amount (issue #951)', () => {
  it('splits a count line into name, amount and the gram estimate', () => {
    expect(textOf(COUNT, 'name')).toBe('Large egg');
    expect(textOf(COUNT, 'quantity')).toBe('1');
    expect(textOf(COUNT, 'display')).toBe('(about 50g)');
    // Reads "1 large egg (about 50g)" on screen. No text-node space before the
    // parenthetical — the gap is `ml-1`, exactly as it is on a metric row, and
    // `ShoppingListPage.recipeQuantity.test.ts` pins that same shape ("18g
    // Garlic(6 cloves)"). A count must not spell it differently.
    expect(textOf(COUNT, 'all')).toBe('1 large egg(about 50g)');
  });

  it('pluralises the stored item upward when the count is more than one', () => {
    expect(textOf(COUNT_PLURAL, 'name')).toBe('Garlic cloves, peeled and finely sliced');
    expect(textOf(COUNT_PLURAL, 'all')).toBe('4 garlic cloves, peeled and finely sliced');
  });

  it('leaves an already-plural item alone', () => {
    expect(textOf(COUNT_ALREADY_PLURAL, 'name')).toBe('Large eggs');
    expect(textOf(COUNT_ALREADY_PLURAL, 'all')).toBe('2 large eggs');
  });

  it('never singularises: a plural item stored against a quantity of 1 is untouched', () => {
    // Staging holds `item: "chicken legs"` at `quantity: 1`, off "Chicken legs
    // (thigh and drum)". Inflection is upward only, so this stays as authored.
    const one = makeIngredient(
      'Chicken legs (thigh and drum)',
      makeParsed({ quantity: single(1), unit: null, item: 'chicken legs' }),
    );
    expect(textOf(one, 'name')).toBe('Chicken legs');
  });

  it('renders a mixed quantity as a vulgar fraction, not a decimal', () => {
    expect(textOf(COUNT_MIXED, 'quantity')).toBe('½');
    expect(textOf(COUNT_MIXED, 'all')).toBe('½ garlic clove');
  });

  it('renders a whole-plus-fraction tight, and pluralises above one', () => {
    const oneAndAHalf = makeIngredient(
      '1 ½ garlic cloves',
      makeParsed({
        quantity: { type: 'mixed', whole: 1, numerator: 1, denominator: 2 },
        unit: null,
        item: 'garlic clove',
      }),
    );
    expect(textOf(oneAndAHalf, 'quantity')).toBe('1½');
    expect(textOf(oneAndAHalf, 'all')).toBe('1½ garlic cloves');
  });

  it('falls back to the decimal for a fraction outside the common set', () => {
    const odd = makeIngredient(
      'quarter of a seventh',
      makeParsed({
        quantity: { type: 'mixed', whole: 0, numerator: 1, denominator: 7 },
        unit: 'g',
        item: 'saffron',
      }),
    );
    expect(textOf(odd, 'quantity')).toBe(`${1 / 7}g`);
  });
});

describe('IngredientText — behaviour that must not change', () => {
  it('renders a metric row exactly as before, with no space before the parenthetical', () => {
    expect(textOf(METRIC, 'name')).toBe('Red lentils, rinsed');
    expect(textOf(METRIC, 'quantity')).toBe('300g');
    expect(textOf(METRIC, 'display')).toBe('(1 ½ cups)');
    // The gap between the amount and its restatement is `ml-1`, never a text node —
    // `ShoppingListPage.recipeQuantity.test.ts` pins the same string shape.
    expect(textOf(METRIC, 'all')).toBe('300g red lentils, rinsed(1 ½ cups)');
  });

  it('does not pluralise a metric item, whatever the number', () => {
    const many = makeIngredient(
      '400g plum tomatoes',
      makeParsed({ quantity: single(400), unit: 'g', item: 'plum tomato' }),
    );
    expect(textOf(many, 'name')).toBe('Plum tomato');
  });

  it('renders an unparsed line as its raw text, with an empty amount column', () => {
    expect(textOf(UNPARSED, 'name')).toBe('A jug of gravy, warmed');
    expect(textOf(UNPARSED, 'quantity')).toBe('');
    expect(textOf(UNPARSED, 'display')).toBe('');
    expect(textOf(UNPARSED, 'all')).toBe('A jug of gravy, warmed');
  });

  it('renders a line with no quantity as its raw text', () => {
    expect(textOf(NO_QUANTITY, 'name')).toBe('A crack of black pepper');
    expect(textOf(NO_QUANTITY, 'quantity')).toBe('');
    expect(textOf(NO_QUANTITY, 'all')).toBe('A crack of black pepper');
  });

  it('still appends notes and (optional) to the name', () => {
    const noted: Ingredient = {
      ...makeIngredient(
        '2 large eggs, from a farm shop',
        makeParsed({
          quantity: single(2),
          unit: null,
          item: 'large egg',
          notes: 'from a farm shop',
        }),
      ),
      isOptional: true,
    };
    expect(textOf(noted, 'name')).toBe('Large eggs(from a farm shop)(optional)');
  });

  it('defaults to `all`, which is the sum of its parts', () => {
    // One deliberate difference since the ingredients tab reads as a list: the
    // `name` part leads with a capital and `all` does not, because there the item
    // follows the amount mid-line. Both sides are normalised at exactly the one
    // character that may differ, so everything else stays a byte-for-byte match.
    const unlead = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
    for (const fixture of [COUNT, COUNT_PLURAL, METRIC, UNPARSED, NO_QUANTITY]) {
      const qty = textOf(fixture, 'quantity');
      const expected =
        (qty === '' ? '' : `${qty} `) +
        unlead(textOf(fixture, 'name')) +
        textOf(fixture, 'display');
      const actual = textOf(fixture);
      const nameStartsAt = qty === '' ? 0 : qty.length + 1;
      expect(actual.slice(0, nameStartsAt) + unlead(actual.slice(nameStartsAt))).toBe(expected);
    }
  });

  it('capitalises the name column, and only that part (recipe page ingredients tab)', () => {
    // The tab is a list of things, one per line. Every other surface composes the
    // item after its amount and must stay lowercase mid-line.
    expect(textOf(METRIC, 'name')).toBe('Red lentils, rinsed');
    expect(textOf(METRIC, 'all')).toBe('300g red lentils, rinsed(1 \u00bd cups)');
    expect(textOf(COUNT, 'all')).toBe('1 large egg(about 50g)');
    expect(textOf(METRIC, 'quantity')).toBe('300g');
    expect(textOf(METRIC, 'display')).toBe('(1 \u00bd cups)');
  });

  it('raises only the first letter, including where that is wrong for pH', () => {
    const branded = makeIngredient(
      '2g pH-neutral Maldon sea salt',
      makeParsed({ quantity: single(2), unit: 'g', item: 'pH-neutral Maldon sea salt' }),
    );
    expect(textOf(branded, 'name')).toBe('PH-neutral Maldon sea salt');
  });

  it('leaves a raw line that already starts with a capital alone', () => {
    expect(textOf(UNPARSED, 'name')).toBe('A jug of gravy, warmed');
    expect(textOf(NO_QUANTITY, 'name')).toBe('A crack of black pepper');
  });
});
