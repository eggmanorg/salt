import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyIngredientGroup, newIngredient } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// Saving from the editor IS the human review (issue #616): a person read the
// AI's imported output and committed it, so needs_approval comes off. The second
// half of the story is the import hand-off — the callable now persists the recipe
// and routes here by id, so the editor consumes the stashed copy rather than
// waiting on the Firestore listener, and never swallows a stash meant for a
// different recipe.

const { mockRecipes, mockCanonItems } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string }[]>([]),
  };
});

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  // The editor reads '?meal=' off the live router (issue #752, Phase 3); nothing
  // sent us here from a meal, so the querystring is empty.
  router: { querystring: undefined },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: { email: 'admin@test' } } }));
vi.mock('../src/lib/membersService.js', () => {
  const readable = <T>(v: T) => ({
    subscribe(fn: (x: T) => void) {
      fn(v);
      return () => {};
    },
  });
  return {
    members: readable([{ email: 'admin@test', admin: true }]),
    // The editor's "Added by" picker reads `people`, not `members` (issue #1300).
    people: readable([{ email: 'admin@test', admin: true, name: 'Admin' }]),
    isLoadingMembers: readable(false),
  };
});
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  persistRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  parseIngredients: vi.fn(),
  matchIngredient: vi.fn(),
  takeImportedDraft: vi.fn().mockReturnValue(null),
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));

import RecipeEditPage from '../src/routes/recipes/RecipeEditPage.svelte';
import { persistRecipe, takeImportedDraft } from '../src/lib/recipeService.js';

const RECIPE_ID = 'recipe-1';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    producesCanonId: null,
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Imported Carbonara',
    description: null,
    ingredients: [
      { ...emptyIngredientGroup('group-1'), items: [newIngredient('ing-1', '2 eggs')] },
    ],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: { type: 'url', url: 'https://example.com/carbonara' },
    notes: null,
    componentRecipeIds: [],
    kit: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  mockCanonItems._set([]);
  mockRecipes._set([]);
  vi.clearAllMocks();
  vi.mocked(takeImportedDraft).mockReturnValue(null);
});

describe('RecipeEditPage — review flag on save', () => {
  it('drops needs_approval when an imported recipe is saved', async () => {
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    render(RecipeEditPage, { props: { params: { id: RECIPE_ID } } });

    await userEvent.click(screen.getByTestId('recipe-save-btn'));

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(persistRecipe).mock.calls[0]![0];
    // Absent, not false — the schema treats absent as reviewed.
    expect('needs_approval' in saved).toBe(false);
    expect(saved.title).toBe('Imported Carbonara');
  });

  it('leaves an already-reviewed recipe alone', async () => {
    mockRecipes._set([makeRecipe()]);
    render(RecipeEditPage, { props: { params: { id: RECIPE_ID } } });

    await userEvent.click(screen.getByTestId('recipe-save-btn'));

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    expect('needs_approval' in vi.mocked(persistRecipe).mock.calls[0]![0]).toBe(false);
  });
});

describe('RecipeEditPage — stashed import hand-off', () => {
  it('paints from the stash when the listener has not delivered the recipe yet', async () => {
    // Empty store: the CF wrote the doc moments ago and the subscription is still
    // in flight. Without the stash this would render a blank form.
    vi.mocked(takeImportedDraft).mockReturnValue(makeRecipe({ needs_approval: true }));
    render(RecipeEditPage, { props: { params: { id: RECIPE_ID } } });

    await waitFor(() => expect(screen.getByDisplayValue('Imported Carbonara')).toBeInTheDocument());
    expect(takeImportedDraft).toHaveBeenCalledWith(RECIPE_ID);
  });

  it('never reaches for the stash when the recipe is already in the store', () => {
    mockRecipes._set([makeRecipe()]);
    render(RecipeEditPage, { props: { params: { id: RECIPE_ID } } });

    // Editing an existing recipe must not consume a single-use stash that
    // belongs to a different, in-flight import.
    expect(takeImportedDraft).not.toHaveBeenCalled();
  });
});
