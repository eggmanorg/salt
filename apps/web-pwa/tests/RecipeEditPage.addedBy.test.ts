import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Member, Recipe } from '@salt/domain';

// The editable "Added by" control (issue #845, Phase 3). `createdBy` is a
// snapshot of `Member.name`, and the backfill that filled it in for the existing
// library could only guess — so the record can be wrong, and the editor is where
// it is corrected.
//
// Four things are load-bearing and all four are asserted here: the control is
// EDIT-ONLY (on a create route the author is whoever is typing), it writes a
// VERBATIM roster name (the list's chip compares with `===`), a name that is no
// longer on the roster is neither dropped nor crashed on, and `lastEditedBy`
// gets no control at all.
//
// A fifth since "everyone is a Pendery": the picker READS first names and STORES
// full ones. The split is at render, so nothing about the stored value — or the
// `===` that finds it again — changes.

const { mockRecipes, mockCanonItems } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string }[]>([]),
  };
});

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { querystring: undefined },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  persistRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  parseIngredients: vi.fn(),
  matchIngredient: vi.fn(),
  takeImportedDraft: vi.fn().mockReturnValue(null),
  attachComponentToMeal: vi.fn(),
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
// The REAL members service, seeded rather than stubbed: it owns both halves of
// what this file asserts — the roster in display order, and `firstName`, the
// rendering rule the picker's labels go through. A hand-written stub of the
// latter would let the truncation drift out from under the tests that pin it.
vi.mock('@salt/firebase-sync', () => ({
  subscribeMembers: vi.fn(),
  upsertMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));

import RecipeEditPage from '../src/routes/recipes/RecipeEditPage.svelte';
import { persistRecipe } from '../src/lib/recipeService.js';
import { seedMembers, __resetMembersServiceForTest } from '../src/lib/membersService.js';

function makeMember(name: string, sortOrder: number, system = false): Member {
  return {
    id: `member-${name.toLowerCase()}`,
    schemaVersion: 1,
    name,
    email: `${name.toLowerCase()}@example.com`,
    admin: false,
    sortOrder,
    icon: null,
    cookMode: 'standard',
    system,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    kit: [],
    id: 'entry-1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Carbonara',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
    ...overrides,
  };
}

function trigger(): HTMLElement {
  return screen.getByTestId('recipe-added-by-select');
}

// Open the listbox and pick a name. The options only exist while it is open —
// `SelectContent` renders nothing when closed — so this is the only way in.
async function pickAuthor(name: string): Promise<void> {
  await userEvent.click(trigger());
  await screen.findByRole('listbox');
  await userEvent.click(screen.getByRole('option', { name }));
}

async function savedRecipe(): Promise<Recipe> {
  await userEvent.click(screen.getByTestId('recipe-save-btn'));
  await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
  return vi.mocked(persistRecipe).mock.calls[0]![0];
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  mockCanonItems._set([]);
  mockRecipes._set([]);
  __resetMembersServiceForTest();
  vi.clearAllMocks();
});

describe('RecipeEditPage — "Added by"', () => {
  it('is absent on the create routes, where the author is whoever is typing', () => {
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);

    render(RecipeEditPage, { props: { params: undefined } });
    expect(screen.queryByTestId('recipe-added-by')).toBeNull();

    cleanup();
    render(RecipeEditPage, { props: { params: { kind: 'cocktail' } } });
    expect(screen.queryByTestId('recipe-added-by')).toBeNull();
  });

  it('shows the recorded name when editing, and offers the roster in display order', async () => {
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel', lastEditedBy: 'Daniel' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });

    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());
    expect(trigger()).toHaveTextContent('Daniel');

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual([
      'Daniel',
      'Kate',
    ]);
  });

  it('writes the chosen name verbatim, and the save leaves it alone', async () => {
    // The correction the feature exists for: the backfill said Daniel, it was
    // really Kate. The name must land byte-identical to `Member.name` — the
    // list's "Added by me" chip is a plain `===` against it, so anything
    // trimmed, cased differently or resolved to a uid stops matching silently.
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel', lastEditedBy: 'Daniel' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());

    await pickAuthor('Kate');
    expect(trigger()).toHaveTextContent('Kate');

    const saved = await savedRecipe();
    expect(saved.createdBy).toBe('Kate');
    // The editor hands the draft over untouched; `stampRecipeAttribution` fills
    // `createdBy` only when it is EMPTY, so a chosen name survives, and it
    // re-stamps `lastEditedBy` on the far side — which is why the editor writes
    // nothing to that field itself.
    expect(saved.lastEditedBy).toBe('Daniel');
  });

  it('records a name onto an entry that has none', async () => {
    // Every recipe written before the field existed carries ''. The trigger
    // reads as an empty field rather than naming somebody at random.
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);
    mockRecipes._set([makeRecipe()]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());
    expect(trigger()).toHaveTextContent('Not recorded');

    await pickAuthor('Kate');
    expect((await savedRecipe()).createdBy).toBe('Kate');
  });

  it('keeps a name that is no longer on the roster, and still offers it', async () => {
    // A member who has since been removed, or a library restored from another
    // environment. The stored value is shown, is one of the options, and — the
    // point — is not quietly rewritten by a visit to the editor.
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Sam', lastEditedBy: 'Daniel' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());
    expect(trigger()).toHaveTextContent('Sam');

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual([
      'Daniel',
      'Kate',
      'Sam',
    ]);
    expect(screen.getByRole('option', { name: 'Sam' })).toHaveAttribute('aria-selected', 'true');

    // Close without choosing, then save: the off-roster name is untouched.
    await userEvent.keyboard('{Escape}');
    expect((await savedRecipe()).createdBy).toBe('Sam');
  });

  it('reads first names but stores the full one', async () => {
    // The whole of the "everyone is a Pendery" change. Both halves matter: the
    // option and the closed trigger say "Kate", and the draft handed to
    // `persistRecipe` still says "Kate Pendery" — the value the list's `===`
    // filter and the next visit to this picker both depend on.
    seedMembers([makeMember('Daniel Pendery', 0), makeMember('Kate Pendery', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel Pendery', lastEditedBy: 'Daniel Pendery' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());
    expect(trigger()).toHaveTextContent('Daniel');
    expect(trigger()).not.toHaveTextContent('Pendery');

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual([
      'Daniel',
      'Kate',
    ]);

    await userEvent.click(screen.getByRole('option', { name: 'Kate' }));
    expect(trigger()).toHaveTextContent('Kate');
    expect((await savedRecipe()).createdBy).toBe('Kate Pendery');
  });

  it('keeps two people who share a first name as two options', async () => {
    // The reason the dedupe and the `{#each}` key stay on the FULL name: shorten
    // the identity and these two collapse into one option, and picking it would
    // store whichever of them won.
    seedMembers([makeMember('Kate Pendery', 0), makeMember('Kate Ashworth', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Kate Pendery', lastEditedBy: 'Kate Pendery' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('offers nothing while the roster is empty', async () => {
    // Still loading, or a stream the rules refused. A dropdown that opens on
    // nothing is worse than no dropdown.
    mockRecipes._set([makeRecipe({ createdBy: '', lastEditedBy: '' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('recipe-added-by')).toBeNull();
  });

  it('does not offer a system account (issue #1300)', async () => {
    // A people-picker, so the rule applies: the fridge signs in and adds recipes,
    // but is never offered as someone who added one.
    seedMembers([makeMember('Daniel', 0), makeMember('Fridge', 1, true)]);
    mockRecipes._set([makeRecipe({ createdBy: '', lastEditedBy: '' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Daniel']);
  });

  it('still offers a system account that a recipe is already stamped with', async () => {
    // The stamp is honest and stays put — attribution is an audit snapshot, never
    // rewritten — so the current value must remain selectable or opening the
    // editor would silently drop it. Same path an off-roster name takes.
    seedMembers([makeMember('Daniel', 0), makeMember('Fridge', 1, true)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Fridge', lastEditedBy: 'Fridge' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());

    await userEvent.click(trigger());
    await screen.findByRole('listbox');
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.textContent?.trim())
        .sort(),
    ).toEqual(['Daniel', 'Fridge']);
    expect((await savedRecipe()).createdBy).toBe('Fridge');
  });

  it('never offers a way to edit who last touched it', async () => {
    // `lastEditedBy` is written by the save and by nothing else — a field
    // recording the last edit that a person can type into contradicts itself.
    seedMembers([makeMember('Daniel', 0), makeMember('Kate', 1)]);
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel', lastEditedBy: 'Kate' })]);

    render(RecipeEditPage, { props: { params: { id: 'entry-1' } } });
    await waitFor(() => expect(screen.getByTestId('recipe-added-by')).toBeInTheDocument());

    expect(screen.queryByLabelText(/edited by/i)).toBeNull();
    expect(screen.queryByText(/edited by/i)).toBeNull();

    expect((await savedRecipe()).lastEditedBy).toBe('Kate');
  });
});
