import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/svelte';
import type { CanonItem, ProductForm, ShoppingList, ShoppingListItem } from '@salt/domain';

// A row a RECIPE put on the list reads the way the recipe detail page reads it
// the quantity first, tight against its unit — "1.5kg Whole
// Chicken" — rather than the name with a trailing "(1.5 kg)". These tests pin
// the split: recipe rows flip, MANUAL rows do not (what a person typed onto the
// list is what they read back), and the two product-form shapes — the "Lime ×3"
// headline and the #530 breakdown inversion beneath it — are untouched.

// ─── Mock stores (hoisted so vi.mock factories can reference them) ─────────────

const {
  mockCanonItems,
  mockAisles,
  mockLists,
  mockItems,
  mockDefaultListId,
  mockLoading,
  mockForms,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCanonItems: makeStore<CanonItem[]>([]),
    mockAisles: makeStore<{ id: string; name: string; order: number }[]>([]),
    mockLists: makeStore<ShoppingList[]>([]),
    mockItems: makeStore<ShoppingListItem[]>([]),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockLoading: makeStore<boolean>(false),
    mockForms: makeStore<ProductForm[]>([]),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  aisles: mockAisles,
  purchaseCounts: {
    subscribe(fn: (v: Record<string, number>) => void) {
      fn({});
      return () => {};
    },
  },
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockForms,
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({
  lists: mockLists,
  defaultListId: mockDefaultListId,
  itemsForActiveList: mockItems,
  isLoadingShoppingList: mockLoading,
  setActiveListId: vi.fn(),
  addItemToList: vi.fn(),
  updateItemRawText: vi.fn(),
  updateItemAmountUnit: vi.fn(),
  updateItemNotes: vi.fn(),
  toggleItemChecked: vi.fn(),
  checkItems: vi.fn(),
  uncheckItems: vi.fn(),
  removeItem: vi.fn(),
  removeItems: vi.fn(),
  clearChecked: vi.fn(),
  moveSelectedItems: vi.fn(),
}));

import ShoppingListPage from '../src/routes/shopping/ShoppingListPage.svelte';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: 'a-produce',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

function item(overrides: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return {
    rawText: 'thing',
    notes: '',
    sources: [],
    canonId: null,
    matchState: 'matched',
    checked: false,
    needsCheck: false,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const fromRecipe = (label: string, recipeId = 'r1') => [
  { kind: 'recipe' as const, recipeId, servings: 2, label },
];

const props = { props: { params: { listId: 'list-1' } } };

// The row's HEADLINE line — the first span inside the edit button. Scoped that
// tightly on purpose: the button also carries the notes and "Added by" / recipe
// sub-lines, and the CanonIcon beside it renders its own fallback text, none of
// which may be mistaken for part of the label under test.
function labelOf(row: HTMLElement): string {
  const headline = within(row).getByTestId('shopping-item-edit-btn').querySelector('span');
  return headline!.textContent!.replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLists._set([{ id: 'list-1', name: 'Groceries' } as ShoppingList]);
  mockDefaultListId._set('list-1');
  mockLoading._set(false);
  // Rows only COMBINE inside an aisle group, so the canon needs a live aisle.
  mockAisles._set([{ id: 'a-produce', name: 'Produce', order: 1 }]);
  mockCanonItems._set([
    canonItem({ id: 'c-chicken', name: 'chicken' }),
    canonItem({ id: 'c-onion', name: 'onion' }),
    canonItem({ id: 'c-egg', name: 'egg' }),
  ]);
  mockForms._set([]);
  mockItems._set([]);
});

describe('ShoppingListPage — a recipe row leads with its quantity', () => {
  it('reads "1.5kg Whole Chicken", the way the recipe page writes it', async () => {
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'whole chicken',
        canonId: 'c-chicken',
        amount: 1.5,
        unit: 'kg',
        sources: fromRecipe('Sunday Roast'),
      }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    const label = labelOf(await findByTestId('shopping-item-row'));
    // Leads with it — `toContain` would pass on the old trailing render too.
    expect(label).toMatch(/^1\.5kg Whole Chicken/);
    // And the amount is not ALSO repeated in the old parenthetical.
    expect(label).not.toContain('(1.5 kg)');
  });

  it('shows the bare number when the recipe line carried no unit', async () => {
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'egg',
        canonId: 'c-egg',
        amount: 2,
        sources: fromRecipe('Omelette'),
      }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    expect(labelOf(await findByTestId('shopping-item-row'))).toMatch(/^2 Egg/);
  });

  it('shows the original measure beside the weight — "18g Garlic (6 cloves)"', async () => {
    mockCanonItems._set([canonItem({ id: 'c-garlic', name: 'garlic' })]);
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'garlic',
        canonId: 'c-garlic',
        amount: 18,
        unit: 'g',
        measureNote: '6 cloves',
        sources: fromRecipe('Sunday Roast'),
      }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    const row = await findByTestId('shopping-item-row');
    // No text-node space before the note — the gap is `ml-1`, exactly as the
    // recipe page's IngredientText renders the same string.
    expect(labelOf(row)).toBe('18g Garlic(6 cloves)');
    const note = within(row).getByText('(6 cloves)');
    expect(note.className).toContain('ml-1');
    expect(note.className).toContain('text-muted-foreground');
  });

  it('shows the weight alone when the add was scaled and carries no note', async () => {
    // The write side drops the note on a scaled add, so the row must read fine
    // without it — no empty parens, no gap.
    mockCanonItems._set([canonItem({ id: 'c-garlic', name: 'garlic' })]);
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'garlic',
        canonId: 'c-garlic',
        amount: 36,
        unit: 'g',
        sources: fromRecipe('Sunday Roast'),
      }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    expect(labelOf(await findByTestId('shopping-item-row'))).toBe('36g Garlic');
  });

  it('leaves a quantity-less recipe row alone', async () => {
    mockItems._set([
      item({ id: 'i1', rawText: 'onion', canonId: 'c-onion', sources: fromRecipe('Stew') }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    expect(labelOf(await findByTestId('shopping-item-row'))).toMatch(/^Onion/);
  });
});

describe('ShoppingListPage — a manual row keeps the wording it was added with', () => {
  it('keeps the trailing amount rather than flipping', async () => {
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'whole chicken',
        canonId: 'c-chicken',
        amount: 2,
        sources: [{ kind: 'manual', addedBy: 'Daniel' }],
      }),
    ]);

    const { findByTestId } = render(ShoppingListPage, props);

    const label = labelOf(await findByTestId('shopping-item-row'));
    expect(label).toMatch(/^Whole Chicken/);
    expect(label).toContain('(2)');
  });

  it('treats a row with no source at all as a person’s, not a recipe’s', async () => {
    mockItems._set([item({ id: 'i1', rawText: 'onion', canonId: 'c-onion', amount: 3 })]);

    const { findByTestId } = render(ShoppingListPage, props);

    expect(labelOf(await findByTestId('shopping-item-row'))).toMatch(/^Onion/);
  });
});

// The header stays exactly as it was; only the rows beneath it flip.
describe('ShoppingListPage — a plain multi-recipe aggregate', () => {
  function twoOnionRecipes() {
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'onion',
        canonId: 'c-onion',
        amount: 200,
        unit: 'g',
        sources: fromRecipe('Stew', 'r1'),
      }),
      item({
        id: 'i2',
        rawText: 'onion',
        canonId: 'c-onion',
        amount: 300,
        unit: 'g',
        sources: fromRecipe('Soup', 'r2'),
      }),
    ]);
  }

  it('keeps the combined header’s summed trailing subtotal', async () => {
    twoOnionRecipes();

    const { findByTestId } = render(ShoppingListPage, props);

    const toggle = await findByTestId('shopping-combined-toggle');
    expect(toggle.textContent!.replace(/\s+/g, ' ')).toContain('Onion (500 g)');
  });

  it('gives each contributor beneath it the same shape as a lone recipe row', async () => {
    twoOnionRecipes();

    const view = render(ShoppingListPage, props);
    fireEvent.click(await view.findByTestId('shopping-combined-toggle'));
    const breakdown = within(await view.findByTestId('shopping-combined-breakdown'));

    const rows = breakdown.getAllByTestId('shopping-item-row');
    expect(labelOf(rows[0]!)).toMatch(/^200g Onion/);
    expect(labelOf(rows[1]!)).toMatch(/^300g Onion/);
  });
});

// Product forms are deliberately out of scope: the parent count is an aggregate
// (Σwhole + MAXforms), not a measure, so neither the "×3" headline nor the #530
// breakdown inversion may start reading as a leading quantity.
describe('ShoppingListPage — product-form rows are untouched', () => {
  const limeForm: ProductForm = {
    id: 'pf-juice',
    schemaVersion: 1,
    matchers: ['lime juice'],
    parentCanonId: 'c-lime',
    thumbnail: null,
    label: 'lime juice',
    yield: { formUnit: 'ml', amountPerParent: 30 },
    updatedAt: '',
  };

  const limeItem = () =>
    item({
      id: 'i1',
      rawText: 'lime juice',
      canonId: 'c-lime',
      amount: 3,
      unit: 'count',
      sources: fromRecipe('Ceviche'),
    });

  it('still headlines "Lime ×3"', async () => {
    mockCanonItems._set([canonItem({ id: 'c-lime', name: 'lime' })]);
    mockForms._set([limeForm]);
    mockItems._set([limeItem()]);

    const { findByTestId } = render(ShoppingListPage, props);

    const label = labelOf(await findByTestId('shopping-item-row'));
    expect(label).toMatch(/^Lime ×3/);
    expect(label).not.toContain('3count');
  });

  it('does not read as "3count Lime" when the form no longer resolves', async () => {
    // The degrade path: the count sentinel is not a measure, so a row that has
    // fallen past the ×N branch keeps its existing trailing wording.
    mockCanonItems._set([canonItem({ id: 'c-lime', name: 'lime' })]);
    mockForms._set([]);
    mockItems._set([limeItem()]);

    const { findByTestId } = render(ShoppingListPage, props);

    const label = labelOf(await findByTestId('shopping-item-row'));
    expect(label).not.toContain('3count');
    expect(label).toMatch(/^Lime Juice/);
  });
});

describe('a counted recipe row carries its weight (issue #1643)', () => {
  it('reads "1 Red Onion (150g)" — the weight in the note’s place', async () => {
    mockCanonItems._set([canonItem({ id: 'c-onion', name: 'red onion' })]);
    mockItems._set([
      item({
        id: 'i1',
        rawText: 'red onion',
        canonId: 'c-onion',
        amount: 1,
        weightGrams: 150,
        sources: fromRecipe('Salsa'),
      }),
    ]);
    const { findByTestId } = render(ShoppingListPage, props);
    expect(labelOf(await findByTestId('shopping-item-row'))).toBe('1 Red Onion(150g)');
  });
});
