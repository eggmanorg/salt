import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Recipe, CanonItem, IngredientGroup, ProductForm } from '@salt/domain';

// The first render coverage for the recipe-add review sheet. A product-form row is
// labelled with the PARENT product ("Lime (3 count)") — deliberately far from the
// recipe's own wording — and a collapsed row mentions neither of the lines that
// justified its count. This pins that the original wording is rendered ALONGSIDE
// the label (issue #528), and that ordinary rows are untouched.

const { mockCanonItems, mockGetCanonItemsSnapshot, mockGetProductFormsSnapshot } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockGetCanonItemsSnapshot: vi.fn(() => [] as CanonItem[]),
      mockGetProductFormsSnapshot: vi.fn(() => [] as ProductForm[]),
    };
  },
);

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
}));
// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  startUserActionSpan: vi.fn(() => ({ traceparent: undefined, end: vi.fn() })),
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  getCanonItemsSnapshot: mockGetCanonItemsSnapshot,
}));
vi.mock('../src/lib/productFormService.js', () => ({
  getProductFormsSnapshot: mockGetProductFormsSnapshot,
}));

import RecipeAddToListSheet from '../src/routes/recipes/RecipeAddToListSheet.svelte';
import { saveShoppingListItem } from '@salt/firebase-sync';
import { addToast } from '../src/lib/toastStore.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCanonItem(id: string, name: string): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

function ingredient(id: string, canonId: string, item: string, amount: number, unit: 'ml' | 'g') {
  return {
    id,
    rawText: `${amount} ${unit} ${item}`,
    parsed: {
      quantity: { type: 'single' as const, value: amount },
      unit,
      item,
      preparation: [],
      notes: null,
      displayText: null,
    } as never,
    canonId,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function makeRecipe(items: IngredientGroup['items']): Recipe {
  return {
    cureCategory: null,
    createdBy: '',
    lastEditedBy: '',
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    image: null,
    id: 'recipe-1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Test Recipe',
    description: null,
    ingredients: [{ id: 'g1', name: null, items }],
    steps: [],
    metadata: {
      servings: 2,
      tags: [],
    },
    source: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderSheet(recipe: Recipe) {
  return render(RecipeAddToListSheet, { props: { recipe, listId: 'list-1', open: true } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCanonItemsSnapshot.mockReturnValue([]);
  mockGetProductFormsSnapshot.mockReturnValue([]);
});
afterEach(() => cleanup());

describe('RecipeAddToListSheet — original recipe wording', () => {
  it('shows the recipe wording beneath the parent-product label', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime', 'lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      {
        id: 'form-juice',
        schemaVersion: 1,
        matchers: ['lime juice'],
        parentCanonId: 'canon-lime',
        thumbnail: null,
        label: 'lime juice',
        yield: { formUnit: 'ml', amountPerParent: 30 },
        updatedAt: '',
      },
    ]);

    renderSheet(makeRecipe([ingredient('i1', 'canon-lime', 'lime juice', 60, 'ml')]));

    // The parent label survives — the wording rides ALONGSIDE it, never instead.
    const row = await screen.findByTestId('recipe-add-review-row');
    expect(row.textContent).toContain('Lime');
    expect(row.textContent).toContain('2 count');
    const lines = screen.getAllByTestId('recipe-add-review-original-text');
    expect(lines.map((el) => el.textContent)).toEqual(['60 ml lime juice']);
  });

  it('lists both lines under a single collapsed row', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime', 'lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      {
        id: 'form-juice',
        schemaVersion: 1,
        matchers: ['lime juice'],
        parentCanonId: 'canon-lime',
        thumbnail: null,
        label: 'lime juice',
        yield: { formUnit: 'ml', amountPerParent: 30 },
        updatedAt: '',
      },
      {
        id: 'form-zest',
        schemaVersion: 1,
        matchers: ['lime zest'],
        parentCanonId: 'canon-lime',
        thumbnail: null,
        label: 'lime zest',
        yield: { formUnit: 'g', amountPerParent: 5 },
        updatedAt: '',
      },
    ]);

    renderSheet(
      makeRecipe([
        ingredient('i1', 'canon-lime', 'lime juice', 60, 'ml'),
        ingredient('i2', 'canon-lime', 'lime zest', 15, 'g'),
      ]),
    );

    // One row, both lines — winner (zest, 3 limes) first.
    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    const lines = screen.getAllByTestId('recipe-add-review-original-text');
    expect(lines.map((el) => el.textContent)).toEqual(['15 g lime zest', '60 ml lime juice']);
  });

  it('renders ordinary rows exactly as before — no wording line', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-salt', 'salt')]);

    renderSheet(makeRecipe([ingredient('i1', 'canon-salt', 'salt', 5, 'g')]));

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    expect(screen.queryAllByTestId('recipe-add-review-original-text')).toHaveLength(0);
  });
});

describe('RecipeAddToListSheet — nothing to add', () => {
  it('says so and disables the confirm when there are no rows at all', async () => {
    // Reachable two ways: an entry that takes no ingredients, and a recipe whose
    // ingredients are all unresolvable. Either way the sheet used to render a
    // bare header row above an enabled "Add 0 to list".
    renderSheet(makeRecipe([]));

    await waitFor(() => expect(screen.getByTestId('recipe-add-review-empty')).toBeInTheDocument());
    expect(screen.queryAllByTestId('recipe-add-review-row')).toHaveLength(0);
    expect(screen.getByTestId('recipe-add-to-list-confirm')).toBeDisabled();
  });

  it('disables the confirm once the last row is toggled off', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-salt', 'salt')]);
    renderSheet(makeRecipe([ingredient('i1', 'canon-salt', 'salt', 5, 'g')]));

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    const confirm = screen.getByTestId('recipe-add-to-list-confirm');
    expect(confirm).not.toBeDisabled();

    // The testid sits on the Checkbox's wrapper; the control itself is the
    // role=checkbox button inside it.
    await userEvent.click(
      within(screen.getByTestId('recipe-add-review-add')).getByRole('checkbox'),
    );

    // A pre-existing hole, not a kind-specific one: the sheet let you press
    // "Add 0 to list" and then told you nothing had been added.
    await waitFor(() => expect(confirm).toBeDisabled());
    // The row is still there — it is deselected, not gone, so it can be
    // selected again.
    expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1);
  });
});

// ─── Driven as one of a sequence (#724, Phase 2) ─────────────────────────────
// Three optional props. What matters most is what they do when they are ABSENT:
// a recipe's own page and a planner day's "Add to shop" pass none of them, and
// both must behave exactly as they did before this existed.
describe('RecipeAddToListSheet — the optional sequence props', () => {
  const RECIPE = () => makeRecipe([ingredient('i1', 'canon-salt', 'salt', 5, 'g')]);

  beforeEach(() => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-salt', 'salt')]);
  });

  it('is unchanged without them: the action names itself, dismiss is Cancel, servings are the recipe’s', async () => {
    renderSheet(RECIPE());

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    expect(screen.getByText('Add to shopping list')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-add-sequence')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('2 servings');

    // …and it still says what it wrote itself.
    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Added 1 item to the list.', 'success'),
    );
  });

  it('names the recipe and its position, and turns the dismiss into a Skip', async () => {
    render(RecipeAddToListSheet, {
      props: {
        recipe: RECIPE(),
        listId: 'list-1',
        open: true,
        sequence: { index: 2, total: 4 },
      },
    });

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    expect(screen.getByText('Test Recipe')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-sequence')).toHaveTextContent('2 of 4');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('opens at the caller’s servings, and the stepper still moves from there', async () => {
    render(RecipeAddToListSheet, {
      props: { recipe: RECIPE(), listId: 'list-1', open: true, servings: 5 },
    });

    await waitFor(() =>
      expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('5 servings'),
    );
    await userEvent.click(screen.getByTestId('recipe-servings-decrease'));
    await waitFor(() =>
      expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('4 servings'),
    );
  });

  it('reports what it wrote instead of toasting when the caller is listening', async () => {
    const onSettled = vi.fn();
    render(RecipeAddToListSheet, {
      props: { recipe: RECIPE(), listId: 'list-1', open: true, onSettled },
    });

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));

    // The count goes to the caller, which totals a run of these and says it once.
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(1));
    expect(vi.mocked(addToast)).not.toHaveBeenCalled();
  });

  it('still reports a failure itself, and stays open on it', async () => {
    vi.mocked(saveShoppingListItem).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'write-failed', message: 'nope' },
    } as never);
    const onSettled = vi.fn();
    render(RecipeAddToListSheet, {
      props: { recipe: RECIPE(), listId: 'list-1', open: true, onSettled },
    });

    await waitFor(() => expect(screen.getAllByTestId('recipe-add-review-row')).toHaveLength(1));
    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));

    // A failed write is the sheet's own business either way — and nothing is
    // reported as settled, which is what stops a sequence on it.
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        'Failed to add to shopping list.',
        'destructive',
      ),
    );
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByTestId('recipe-add-review-list')).toBeInTheDocument();
  });
});
