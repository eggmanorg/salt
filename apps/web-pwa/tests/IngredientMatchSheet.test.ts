import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import type { Aisle, CanonItem, Ingredient, Member, ProductForm } from '@salt/domain';

// The match inspector answers "what does this line actually buy?". Everything it
// shows is DERIVED at render time — the ingredient stores only `canonId` — so the
// cases worth pinning are the derivations: that a product form is claimed only
// when it resolves to the ingredient's OWN canon (the guard that keeps a
// repointed form from being reported as the route taken), and that a canonId
// with no live canon reads as dangling rather than as a clean match.

const { mockCanonItems, mockProductForms, mockAisles, mockCurrentMember } = vi.hoisted(() => {
  function store<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      _set(v: T) {
        value = v;
        subs.forEach((fn) => fn(v));
      },
    };
  }
  return {
    mockCanonItems: store<CanonItem[]>([]),
    mockProductForms: store<ProductForm[]>([]),
    mockAisles: store<Aisle[]>([]),
    mockCurrentMember: store<Member | null>(null),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/productFormService.js', () => ({ productForms: mockProductForms }));
vi.mock('../src/lib/aisleService.js', () => ({ aisles: mockAisles }));
vi.mock('../src/lib/membersService.js', () => ({ currentMember: mockCurrentMember }));

import IngredientMatchSheet from '../src/routes/recipes/IngredientMatchSheet.svelte';

const LIME: CanonItem = {
  embedding: null,
  id: 'canon-lime',
  schemaVersion: 5,
  name: 'lime',
  synonyms: [],
  aisleId: 'aisle-produce',
  thumbnail: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

const LIME_JUICE_FORM: ProductForm = {
  id: 'form-lime-juice',
  schemaVersion: 1,
  matchers: [],
  parentCanonId: 'canon-lime',
  thumbnail: null,
  label: 'Lime juice',
  yield: { formUnit: 'ml', amountPerParent: 30 },
  updatedAt: '2026-08-19T00:00:00.000Z',
};

// A form of the SAME parent that the juice line does not name. `missing_form` is
// reported only for a canon the household already buys in some other shape
// (issue #867) — a canon with no form at all has nothing to point at — so this is
// what keeps Lime within the marker's reach without bridging the line itself.
const LIME_ZEST_FORM: ProductForm = {
  ...LIME_JUICE_FORM,
  id: 'form-lime-zest',
  label: 'Lime zest',
  yield: { formUnit: 'g', amountPerParent: 5 },
};

function ingredient(over: Partial<Ingredient> = {}): Ingredient {
  return {
    id: 'ing-1',
    rawText: '90ml lime juice',
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

afterEach(() => {
  cleanup();
  mockCanonItems._set([]);
  mockProductForms._set([]);
  mockAisles._set([]);
  mockCurrentMember._set(null);
});

describe('IngredientMatchSheet', () => {
  it('names the canon item, its aisle, and the product form that carried it there', async () => {
    mockCanonItems._set([LIME]);
    mockProductForms._set([LIME_JUICE_FORM]);
    mockAisles._set([{ id: 'aisle-produce', name: 'Fruit & Veg', order: 0 }]);

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });

    expect(await screen.findByTestId('ingredient-match-canon-name')).toHaveTextContent('Lime');
    expect(screen.getByText(/Fruit & Veg/)).toBeInTheDocument();
    const form = screen.getByTestId('ingredient-match-form');
    expect(form).toHaveTextContent('Lime juice');
    // Yield reads in the direction a cook thinks in: one buyable → this much form.
    expect(form).toHaveTextContent('1 Lime → 30 ml lime juice');
  });

  it('does not claim a form that resolves to a different parent', async () => {
    mockCanonItems._set([LIME]);
    mockProductForms._set([LIME_ZEST_FORM, { ...LIME_JUICE_FORM, parentCanonId: 'canon-lemon' }]);

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });

    // Not claimed — and since nothing else covers a metric line on a by-the-count
    // canon, this lands on the missing-form hint rather than a clean direct match.
    expect(await screen.findByTestId('ingredient-match-missing-form')).toBeInTheDocument();
    expect(screen.queryByTestId('ingredient-match-form')).not.toBeInTheDocument();
  });

  it('reads as a clean direct match when no form is called for', async () => {
    // Flour is bought by weight and the line is in grams: nothing to bridge.
    mockCanonItems._set([{ ...LIME, id: 'canon-flour', name: 'plain flour', unit: 'g' }]);

    render(IngredientMatchSheet, {
      props: {
        ingredient: ingredient({
          rawText: '200g plain flour',
          canonId: 'canon-flour',
          parsed: {
            quantity: { type: 'single', value: 200 },
            unit: 'g',
            item: 'plain flour',
            preparation: [],
            notes: null,
            displayText: null,
          },
        }),
        open: true,
        onRematch: () => {},
      },
    });

    expect(await screen.findByTestId('ingredient-match-direct')).toBeInTheDocument();
    expect(screen.queryByTestId('ingredient-match-missing-form')).not.toBeInTheDocument();
  });

  it('says a matched line has no amount rather than calling it a clean match', async () => {
    // Issue #949: this row read "Matched straight to the canon item" — true, and
    // useless, because it had nothing to scale or to shop with.
    mockCanonItems._set([LIME]);

    render(IngredientMatchSheet, {
      props: {
        ingredient: ingredient({ rawText: '125 g gingernuts (ginger snaps)', parsed: null }),
        open: true,
        onRematch: () => {},
      },
    });

    expect(await screen.findByTestId('ingredient-match-missing-amount')).toBeInTheDocument();
    expect(screen.queryByTestId('ingredient-match-direct')).not.toBeInTheDocument();
    // The repair is right there, as it is on every other state.
    expect(screen.getByTestId('ingredient-match-rematch')).toBeInTheDocument();
  });

  it('calls out a match pointing at a canon item that no longer exists', async () => {
    mockCanonItems._set([]);

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });

    expect(await screen.findByTestId('ingredient-match-dangling')).toBeInTheDocument();
  });

  it('offers the admin jump-offs only to an admin', async () => {
    mockCanonItems._set([LIME]);
    mockProductForms._set([LIME_JUICE_FORM]);

    const { unmount } = render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });
    expect(await screen.findByTestId('ingredient-match-canon-name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open canon item/ })).not.toBeInTheDocument();
    unmount();

    mockCurrentMember._set({
      id: 'd@example.com',
      schemaVersion: 1,
      name: 'Daniel',
      email: 'd@example.com',
      admin: true,
      sortOrder: 0,
      icon: null,
    } as Member);
    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });

    expect(await screen.findByRole('button', { name: /Open canon item/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open product form/ })).toBeInTheDocument();
  });

  it('says an unmatched line is unmatched, and on what it would match', async () => {
    render(IngredientMatchSheet, {
      props: {
        ingredient: ingredient({ canonId: null, matchState: 'pending' }),
        open: true,
        onRematch: () => {},
      },
    });

    const body = await screen.findByTestId('ingredient-match-unmatched');
    expect(body).toHaveTextContent('Not matched yet.');
    expect(body).toHaveTextContent('lime juice');
  });
  it('flags a metric line whose canon is bought by the count as having no form', async () => {
    // The #855 smell and the reason a deleted product form needs naming: nothing
    // dangles, the line just quietly shops as millilitres of a countable thing.
    mockCanonItems._set([LIME]);
    mockProductForms._set([LIME_ZEST_FORM]);

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch: () => {} },
    });

    const hint = await screen.findByTestId('ingredient-match-missing-form');
    expect(hint).toHaveTextContent('ml');
    expect(hint).toHaveTextContent('Lime');
    // ...and it must NOT read as a clean direct match.
    expect(screen.queryByTestId('ingredient-match-direct')).not.toBeInTheDocument();
  });

  it('offers Match again on a line that already looks matched, ungated by admin', async () => {
    // The whole reason the button exists: a deleted product form leaves the
    // ingredient pointing at a live parent canon, so the ✗ never appears.
    mockCanonItems._set([LIME]);
    mockProductForms._set([LIME_JUICE_FORM]);
    const onRematch = vi.fn();

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch },
    });

    const button = await screen.findByTestId('ingredient-match-rematch');
    await fireEvent.click(button);
    expect(onRematch).toHaveBeenCalledOnce();
  });

  it('disables Match again while the re-run is in flight', async () => {
    mockCanonItems._set([LIME]);
    const onRematch = vi.fn();

    render(IngredientMatchSheet, {
      props: { ingredient: ingredient(), open: true, onRematch, rematching: true },
    });

    expect(await screen.findByTestId('ingredient-match-rematch')).toBeDisabled();
  });

  it('says a counted form fed only grams has no count, and how to fix it (issue #1643)', async () => {
    const chicken: CanonItem = { ...LIME, id: 'canon-chicken', name: 'chicken' };
    const carcass: ProductForm = {
      ...LIME_JUICE_FORM,
      id: 'form-carcass',
      parentCanonId: 'canon-chicken',
      label: 'Chicken carcass',
      matchers: ['roast chicken carcass'],
      yield: { formUnit: 'count', amountPerParent: 1 },
    };
    mockCanonItems._set([chicken]);
    mockProductForms._set([carcass]);
    const stored = ingredient({
      rawText: '1 roast chicken carcass',
      canonId: 'canon-chicken',
      parsed: {
        quantity: { type: 'single', value: 1500 },
        unit: 'g',
        item: 'roast chicken carcass',
        preparation: [],
        notes: null,
        displayText: null,
      },
    });

    render(IngredientMatchSheet, {
      props: { ingredient: stored, open: true, onRematch: () => {} },
    });

    const hint = await screen.findByTestId('ingredient-match-missing-count');
    expect(hint).toHaveTextContent('whole Chicken');
    expect(hint).toHaveTextContent('Match again');
    // The form that resolved is still named — the line found its bridge.
    expect(screen.getByTestId('ingredient-match-form')).toHaveTextContent('Chicken carcass');
  });

  it('shows no count warning once the line states its count', async () => {
    const chicken: CanonItem = { ...LIME, id: 'canon-chicken', name: 'chicken' };
    mockCanonItems._set([chicken]);
    mockProductForms._set([
      {
        ...LIME_JUICE_FORM,
        id: 'form-carcass',
        parentCanonId: 'canon-chicken',
        label: 'Chicken carcass',
        matchers: ['roast chicken carcass'],
        yield: { formUnit: 'count', amountPerParent: 1 },
      },
    ]);
    const reRead = ingredient({
      canonId: 'canon-chicken',
      parsed: {
        quantity: { type: 'single', value: 500 },
        unit: 'g',
        statedCount: { type: 'single', value: 1 },
        item: 'roast chicken carcass',
        preparation: [],
        notes: null,
        displayText: null,
      },
    });
    render(IngredientMatchSheet, {
      props: { ingredient: reRead, open: true, onRematch: () => {} },
    });
    await screen.findByTestId('ingredient-match-form');
    expect(screen.queryByTestId('ingredient-match-missing-count')).not.toBeInTheDocument();
  });
});
