import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { appendCacheBuster } from '@salt/domain';
import type { Recipe, RecipeKind, RecipePhase } from '@salt/domain';
import { setNextCrop } from './fixtures/cropStub.js';

// ─── Mock stores and services ──────────────────────────────────────────────────
// The list page is a pure view over the recipeService stores; mock them so we can
// drive the search / sort / tag-filter pipeline without Firestore. Mirrors the
// store shim used by the RecipeEditPage tests.

const {
  mockRecipes,
  mockIsLoading,
  mockCurrentMember,
  mockSystemAccountNames,
  mockCanonItems,
  mockProductForms,
  mockIsLoadingAisles,
  mockIsLoadingProductForms,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    // Who is signed in (issue #845). Null by default — nobody signed in, so the
    // authorship row is not offered and every pre-existing test below is
    // untouched by it.
    mockCurrentMember: makeStore<{ name: string } | null>(null),
    // Names belonging to system accounts (issue #1300). Empty by default, so
    // every test written before the flag existed behaves exactly as it did.
    mockSystemAccountNames: makeStore<Set<string>>(new Set()),
    // The card's match pip (silent mis-matches) reads both collections. Empty by
    // default, which with the page's own load gate means no pip — so every test
    // written before the pip existed is untouched by it.
    mockCanonItems: makeStore<unknown[]>([]),
    mockProductForms: makeStore<unknown[]>([]),
    mockIsLoadingAisles: makeStore<boolean>(false),
    mockIsLoadingProductForms: makeStore<boolean>(false),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/membersService.js', () => ({
  currentMember: mockCurrentMember,
  // Issue #1300 — the names the authorship row must not count. Seeded per test.
  systemAccountNames: mockSystemAccountNames,
}));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: mockIsLoadingAisles,
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  isLoadingProductForms: mockIsLoadingProductForms,
}));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoading,
  importRecipeFromUrl: vi.fn(),
  urlImportMessage: vi.fn(),
  importRecipeFromPhoto: vi.fn(),
  photoImportMessage: vi.fn((outcome: { code?: string }) => `copy-for:${outcome.code}`),
  stashImportedDraft: vi.fn(),
  isSignedOutFailure: vi.fn((outcome: { kind: string }) => outcome.kind === 'AuthError'),
  stashPendingImportUrl: vi.fn(),
  takePendingImportUrl: vi.fn(() => null),
}));

// Only the cropper is swapped out of @salt/ui-components: jsdom has no canvas,
// so the real primitive can never produce cropped bytes (see
// tests/fixtures/StubImageCropper.svelte). Everything else the list page renders
// is the shipped primitive.
vi.mock('@salt/ui-components', async () => {
  const actual = await vi.importActual<typeof import('@salt/ui-components')>('@salt/ui-components');
  const stub = await import('./fixtures/StubImageCropper.svelte');
  return { ...actual, ImageCropper: stub.default };
});

import RecipeListPage from '../src/routes/recipes/RecipeListPage.svelte';
import {
  importRecipeFromPhoto,
  importRecipeFromUrl,
  stashImportedDraft,
  takePendingImportUrl,
} from '../src/lib/recipeService.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRecipe(over: {
  id: string;
  title: string;
  tags: string[];
  servings: number | null;
  ingredientCount: number;
  image: Recipe['image'];
  imageHidden?: boolean;
  imageRequestedAt?: number;
  createdAt: string;
  kind?: RecipeKind;
  componentRecipeIds?: string[];
  // Attribution (issue #845) — a `Member.name` snapshot, never a uid. '' is the
  // real production value for anything written before the field existed.
  createdBy?: string;
  lastEditedBy?: string;
  // The phase strip (issue #1122). Absent on almost every fixture here, which is
  // the state the whole library is in until the backfill runs.
  phases?: RecipePhase[];
}): Recipe {
  return {
    kit: [],
    id: over.id,
    schemaVersion: 1,
    kind: over.kind ?? 'recipe',
    title: over.title,
    description: null,
    ingredients: [
      {
        id: `${over.id}-g`,
        name: null,
        items: Array.from({ length: over.ingredientCount }, (_, i) => ({
          id: `${over.id}-i${i}`,
          rawText: `ingredient ${i}`,
          parsed: null,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: false,
          firstUsedInStepId: null,
        })),
      },
    ],
    steps: [],
    metadata: {
      servings: over.servings,
      tags: over.tags,
      ...(over.phases === undefined ? {} : { phases: over.phases }),
    },
    source: null,
    notes: null,
    producesCanonId: null,
    // Empty unless a test is building a MEAL (issue #752) — the Meals section is
    // derived from this array being non-empty, never from a kind.
    componentRecipeIds: over.componentRecipeIds ?? [],
    image: over.image,
    ...(over.imageHidden !== undefined ? { imageHidden: over.imageHidden } : {}),
    ...(over.imageRequestedAt !== undefined ? { imageRequestedAt: over.imageRequestedAt } : {}),
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    createdBy: over.createdBy ?? '',
    lastEditedBy: over.lastEditedBy ?? '',
  };
}

const APPLE = makeRecipe({
  id: 'apple',
  title: 'Apple Pie',
  tags: ['dessert', 'baking'],
  // The chip reads the phase strip and nothing else (issue #1213). The stored
  // total stays on the fixture, wrong on purpose, so a fallback creeping back
  // would be visible.
  phases: [
    { label: 'Pastry', handsOnMinutes: 25, handsOffMinutes: 5 },
    { label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 55 },
  ],
  servings: 8,
  ingredientCount: 5,
  image: { url: 'http://img.test/apple.jpg', source: 'ai' },
  createdAt: '2026-01-01T00:00:00.000Z',
});
const BANANA = makeRecipe({
  id: 'banana',
  title: 'Banana Bread',
  tags: ['baking', 'quick'],
  servings: 6,
  ingredientCount: 3,
  image: null, // → fallback tile
  createdAt: '2026-02-01T00:00:00.000Z',
});
const CARROT = makeRecipe({
  id: 'carrot',
  title: 'Carrot Soup',
  tags: ['soup', 'quick'],
  servings: 4,
  ingredientCount: 4,
  image: { url: 'http://img.test/carrot.jpg', source: 'ai' },
  imageHidden: true, // retired/inert (Phase 1): still shows its hero despite this flag
  createdAt: '2026-03-01T00:00:00.000Z',
});

function seed(recipes: Recipe[]): void {
  mockRecipes._set(recipes);
}

function cardTitles(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent?.trim() ?? '');
}

// jsdom's textContent preserves source whitespace between expression tags; the
// browser collapses it. Normalise so assertions read against the rendered text.
function normalized(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  cleanup();
  seed([]);
  mockCurrentMember._set(null);
  mockSystemAccountNames._set(new Set());
  mockCanonItems._set([]);
  mockProductForms._set([]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('RecipeListPage', () => {
  it('renders a card per recipe, sorted A–Z by default', () => {
    seed([CARROT, APPLE, BANANA]);
    render(RecipeListPage);

    expect(screen.getAllByTestId('recipe-list-item')).toHaveLength(3);
    expect(cardTitles()).toEqual(['Apple Pie', 'Banana Bread', 'Carrot Soup']);
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('3 recipes');
  });

  it('shows the hero image whenever a url exists (imageHidden retired) and a fallback tile otherwise', () => {
    seed([APPLE, BANANA, CARROT]);
    render(RecipeListPage);

    // Apple and Carrot both have image urls, so both show a hero — Carrot's
    // `imageHidden` is retired/inert (Phase 1) and no longer suppresses it. Only
    // Banana (image null) falls back to the placeholder tile.
    expect(screen.getAllByTestId('recipe-list-thumb')).toHaveLength(2);
    expect(screen.getAllByTestId('recipe-list-thumb-fallback')).toHaveLength(1);

    // Cards render A–Z, so Apple's thumb is first. It is cache-busted (issue
    // #460): Apple has no `imageRequestedAt`, so the nonce falls back to
    // `updatedAt`. The base URL carries no query, so the param is appended with
    // `?v=`.
    const src = screen.getAllByTestId('recipe-list-thumb')[0]!.getAttribute('src');
    expect(src).toBe(`http://img.test/apple.jpg?v=${APPLE.updatedAt}`);
  });

  it('cache-busts the thumb and re-fetches when imageRequestedAt changes even if the URL is unchanged', () => {
    // A regenerated hero reuses the SAME byte-identical Storage URL, so only the
    // per-regeneration nonce (`imageRequestedAt`) changes — the `?v=` param must
    // follow it or the browser serves the stale image (issue #460).
    const before = makeRecipe({
      id: 'peach',
      title: 'Peach Cobbler',
      tags: ['dessert'],
      servings: 6,
      ingredientCount: 4,
      image: { url: 'http://img.test/peach.jpg', source: 'ai' },
      imageRequestedAt: 1000,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    seed([before]);
    const { unmount } = render(RecipeListPage);
    const srcBefore = screen.getByTestId('recipe-list-thumb').getAttribute('src');
    expect(srcBefore).toBe('http://img.test/peach.jpg?v=1000');
    unmount();

    // Same URL, new regeneration nonce → the rendered src must change.
    const after = { ...before, imageRequestedAt: 2000 };
    seed([after]);
    render(RecipeListPage);
    const srcAfter = screen.getByTestId('recipe-list-thumb').getAttribute('src');
    expect(srcAfter).toBe('http://img.test/peach.jpg?v=2000');
    expect(srcAfter).not.toBe(srcBefore);
  });

  it('surfaces time, servings and ingredient count on a card', () => {
    seed([APPLE]);
    render(RecipeListPage);

    const card = screen.getByTestId('recipe-list-item');
    // The strip's sum, in the app's duration vocabulary — not the stored 20.
    expect(card.textContent).toContain('1 hr 30 min');
    expect(card.textContent).not.toContain('20 min');
    expect(card.textContent).toContain('8'); // servings
    expect(card.textContent).toContain('5'); // ingredient count
  });

  it('filters by search text over title and tags', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, CARROT]);
    render(RecipeListPage);

    const search = screen.getByTestId('recipe-search-input');
    await user.type(search, 'apple');
    expect(cardTitles()).toEqual(['Apple Pie']);
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('filtered');

    // Tag text is searchable too: "soup" is a tag on Carrot Soup.
    await user.clear(search);
    await user.type(search, 'soup');
    expect(cardTitles()).toEqual(['Carrot Soup']);
  });

  it('narrows to recipes carrying a selected tag, and clears', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, CARROT]);
    render(RecipeListPage);

    const filters = screen.getByTestId('recipe-tag-filters');
    const quickChip = within(filters).getByRole('button', { name: '#quick' });
    await user.click(quickChip);

    expect(cardTitles()).toEqual(['Banana Bread', 'Carrot Soup']);
    expect(quickChip).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('recipe-clear-filters'));
    expect(screen.getAllByTestId('recipe-list-item')).toHaveLength(3);
  });

  it('scopes the filter chips to tags on the currently displayed recipes', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, CARROT]);
    render(RecipeListPage);

    const filterTags = () =>
      within(screen.getByTestId('recipe-tag-filters'))
        .getAllByTestId('recipe-tag-filter')
        .map((b) => b.getAttribute('data-tag'));

    // All tags across the library are offered before any filtering, now ranked
    // by usage (most-used first, alpha tie-break): baking & quick appear on two
    // recipes each, dessert & soup on one.
    expect(filterTags()).toEqual(['baking', 'quick', 'dessert', 'soup']);

    // Selecting "dessert" leaves only Apple Pie, so the chips collapse to Apple's
    // own tags (the selected one pinned) — "quick"/"soup" drop away.
    await user.click(
      within(screen.getByTestId('recipe-tag-filters')).getByRole('button', {
        name: '#dessert',
      }),
    );
    expect(cardTitles()).toEqual(['Apple Pie']);
    expect(filterTags()).toEqual(['baking', 'dessert']);
  });

  it('caps the tag chips at 10 by default and expands on demand', async () => {
    const user = userEvent.setup();
    const many = makeRecipe({
      id: 'many',
      title: 'Kitchen Sink',
      tags: Array.from({ length: 12 }, (_, i) => `tag${String(i).padStart(2, '0')}`),
      servings: 2,
      ingredientCount: 2,
      image: null,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    seed([many]);
    render(RecipeListPage);

    const chips = () =>
      within(screen.getByTestId('recipe-tag-filters')).getAllByTestId('recipe-tag-filter');

    // Collapsed: only the first 10 chips plus a "+2 more" expander.
    expect(chips()).toHaveLength(10);
    expect(screen.getByTestId('recipe-tag-show-all')).toHaveTextContent('+2 more');

    // Expanding reveals all 12 chips and swaps in a "Show less" control.
    await user.click(screen.getByTestId('recipe-tag-show-all'));
    expect(chips()).toHaveLength(12);
    expect(screen.queryByTestId('recipe-tag-show-all')).toBeNull();
    expect(screen.getByTestId('recipe-tag-show-less')).toBeInTheDocument();
  });

  it('shows an empty-filter state when nothing matches', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, CARROT]);
    render(RecipeListPage);

    await user.type(screen.getByTestId('recipe-search-input'), 'zzz-no-match');
    expect(screen.queryByTestId('recipe-list')).toBeNull();
    expect(screen.getByTestId('recipe-no-matches')).toBeInTheDocument();
  });

  it('renders the full-collection empty state when there are no recipes', () => {
    seed([]);
    render(RecipeListPage);
    expect(screen.getByText('No recipes yet.')).toBeInTheDocument();
  });
});

// ─── Sections (issue #637) ────────────────────────────────────────────────────
// The chip row is a place you STAND, not a filter you have applied — which is
// why switching it clears the tag vocabulary but keeps your search, and why
// "Clear filters" leaves you exactly where you were.

const TAKEAWAY = makeRecipe({
  id: 'takeaway',
  kind: 'outing',
  title: 'Takeaway — Indian',
  tags: ['friday', 'quick'],
  servings: null,
  ingredientCount: 0,
  image: null,
  createdAt: '2026-06-01T00:00:00.000Z',
});
const PICNIC = makeRecipe({
  id: 'picnic',
  kind: 'outing',
  title: 'Picnic food',
  tags: ['summer'],
  servings: null,
  ingredientCount: 0,
  image: null,
  createdAt: '2026-06-02T00:00:00.000Z',
});

const NEGRONI = makeRecipe({
  id: 'negroni',
  kind: 'cocktail',
  title: 'Negroni',
  tags: ['aperitivo'],
  servings: 1,
  ingredientCount: 3,
  image: null,
  createdAt: '2026-06-03T00:00:00.000Z',
});

// Meals (issue #752). Both of these are ordinary documents of an ordinary kind —
// what makes them meals is `componentRecipeIds`, and nothing else. The cocktail
// one is the point of the fifth capability column: a drink built on a house syrup
// is the same relationship a roast has with its gravy.
const SUNDAY_ROAST = makeRecipe({
  id: 'roast',
  title: 'Sunday roast',
  tags: ['sunday'],
  servings: 4,
  ingredientCount: 4,
  image: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  componentRecipeIds: ['chicken', 'potatoes', 'gravy'],
});
const NEGRONI_WITH_SYRUP = makeRecipe({
  id: 'negroni-syrup',
  kind: 'cocktail',
  title: 'Negroni with house syrup',
  tags: ['aperitivo'],
  servings: 1,
  ingredientCount: 3,
  image: null,
  createdAt: '2026-07-02T00:00:00.000Z',
  componentRecipeIds: ['syrup'],
});

function queryKindChip(kind: string): HTMLElement | undefined {
  const row = screen.getByTestId('recipe-kind-filters');
  return within(row)
    .queryAllByTestId('recipe-kind-filter')
    .find((b) => b.getAttribute('data-kind') === kind);
}

function kindChip(kind: string): HTMLElement {
  const chip = queryKindChip(kind);
  if (!chip) throw new Error(`no chip for kind ${kind}`);
  return chip;
}

// Only the primary sections are on screen to start with; the rest sit behind the
// "+N more" chip. Reaching one is reveal-then-pick, so every test that switches
// section goes through here rather than assuming which chips are rendered.
async function pickKind(user: ReturnType<typeof userEvent.setup>, kind: string): Promise<void> {
  if (!queryKindChip(kind)) await user.click(screen.getByTestId('recipe-kind-show-all'));
  await user.click(kindChip(kind));
}

describe('RecipeListPage — sections', () => {
  it('shows only recipes by default, behind the three primary section chips', () => {
    seed([APPLE, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    expect(cardTitles()).toEqual(['Apple Pie']);
    expect(kindChip('recipe')).toHaveAttribute('aria-pressed', 'true');
    // Meals joined the primary row in #752, second after Recipes: it has no
    // New-menu entry of its own, so the chip is the only thing that says the
    // shelf exists.
    expect(kindChip('meal')).toHaveAttribute('aria-pressed', 'false');
    expect(kindChip('cocktail')).toHaveAttribute('aria-pressed', 'false');
    // The other two are not gone, just folded away — the row leads with the
    // sections you browse and counts the rest, exactly as the tag row does.
    expect(queryKindChip('outing')).toBeUndefined();
    expect(queryKindChip('placeholder')).toBeUndefined();
    expect(screen.getAllByTestId('recipe-kind-filter')).toHaveLength(3);
    expect(normalized(screen.getByTestId('recipe-kind-show-all'))).toBe('+2 more');
  });

  it('reveals every section behind the "+N more" chip, and folds them back', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-kind-show-all'));

    // All five sections, and only five — a chip row you STAND in, so a sixth
    // would be a section that shipped without anyone deciding to. The fourth
    // (issue #652) was decided: you need somewhere to open Regenerate from, and
    // that is the view page you reach from this grid. The fifth is Meals (#752),
    // which is a section and NOT a kind — you cannot create one.
    expect(screen.getAllByTestId('recipe-kind-filter')).toHaveLength(5);
    expect(kindChip('outing')).toHaveAttribute('aria-pressed', 'false');
    expect(kindChip('placeholder')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('recipe-kind-show-all')).toBeNull();

    await user.click(screen.getByTestId('recipe-kind-show-less'));
    expect(screen.getAllByTestId('recipe-kind-filter')).toHaveLength(3);
  });

  it('pins the section you are standing in when the row folds back up', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    await pickKind(user, 'outing');
    await user.click(screen.getByTestId('recipe-kind-show-less'));

    // Collapsing must never hide the chip that says where you are — otherwise
    // the row claims you are in Recipes while the grid shows outings.
    expect(kindChip('outing')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['Picnic food', 'Takeaway — Indian']);
    expect(queryKindChip('placeholder')).toBeUndefined();
  });

  it('switches sections and shows only that section', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    await pickKind(user, 'outing');

    expect(cardTitles()).toEqual(['Picnic food', 'Takeaway — Indian']);
    expect(kindChip('outing')).toHaveAttribute('aria-pressed', 'true');
    expect(kindChip('recipe')).toHaveAttribute('aria-pressed', 'false');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('2 ideas');
  });

  it('offers an empty section rather than hiding it', async () => {
    const user = userEvent.setup();
    // Recipes exist, outings do not — the section must still be reachable so you
    // can see for yourself that there is nothing in it.
    seed([APPLE, BANANA]);
    render(RecipeListPage);

    await pickKind(user, 'outing');

    expect(screen.queryByTestId('recipe-list')).toBeNull();
    expect(screen.getByTestId('recipe-kind-empty')).toBeInTheDocument();
    // Nothing to clear: this is an empty section, not a failed filter.
    expect(screen.queryByTestId('recipe-no-matches')).toBeNull();
    expect(screen.queryByTestId('recipe-clear-filters')).toBeNull();
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('0 ideas');
  });

  it('re-facets the tag chips to the section you are standing in', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    const filterTags = () =>
      within(screen.getByTestId('recipe-tag-filters'))
        .getAllByTestId('recipe-tag-filter')
        .map((b) => b.getAttribute('data-tag'));

    expect(filterTags()).toEqual(['baking', 'dessert', 'quick']);

    await pickKind(user, 'outing');
    // Only the outings' own tags — "baking" and "dessert" are recipe vocabulary.
    expect(filterTags()).toEqual(['friday', 'quick', 'summer']);
  });

  it('clears the selected tags on a switch but keeps what you typed', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    // "quick" exists in BOTH sections, so a stale selection would silently
    // survive the switch unless it is explicitly dropped.
    await user.click(
      within(screen.getByTestId('recipe-tag-filters')).getByRole('button', { name: '#quick' }),
    );
    expect(cardTitles()).toEqual(['Banana Bread']);

    const search = screen.getByTestId('recipe-search-input');
    await user.type(search, 'a');

    await pickKind(user, 'outing');

    // Tag dropped: both outings show, not just the one tagged "quick".
    expect(
      within(screen.getByTestId('recipe-tag-filters'))
        .getAllByTestId('recipe-tag-filter')
        .every((b) => b.getAttribute('aria-pressed') === 'false'),
    ).toBe(true);
    // Search kept: "Picnic food" has no "a", "Takeaway — Indian" does.
    expect(search).toHaveValue('a');
    expect(cardTitles()).toEqual(['Takeaway — Indian']);
  });

  it('does not throw you back to Recipes when you clear the filters', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    await pickKind(user, 'outing');
    await user.type(screen.getByTestId('recipe-search-input'), 'picnic');
    expect(cardTitles()).toEqual(['Picnic food']);

    await user.click(screen.getByTestId('recipe-clear-filters'));

    expect(kindChip('outing')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['Picnic food', 'Takeaway — Indian']);
  });

  it('reports "filtered" for a search but never merely for a section', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY, PICNIC]);
    render(RecipeListPage);

    await pickKind(user, 'outing');
    expect(normalized(screen.getByTestId('recipe-result-count'))).not.toContain('filtered');

    await user.type(screen.getByTestId('recipe-search-input'), 'picnic');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('filtered');
  });

  it('drops the ingredient count from cards that cannot have ingredients', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY]);
    render(RecipeListPage);

    // A recipe card carries three meta chips (time, servings, ingredients).
    expect(screen.getByTestId('recipe-list-item').textContent).toContain('5');

    await pickKind(user, 'outing');
    // No "0 ingredients" chip on a takeaway — the concept does not apply.
    const card = screen.getByTestId('recipe-list-item');
    expect(card.textContent).not.toContain('0');
  });

  it('routes the New menu straight to the outing editor', async () => {
    const user = userEvent.setup();
    const { push } = await import('svelte-spa-router');
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-outing'));

    expect(push).toHaveBeenCalledWith('/recipes/new/outing');
  });

  // ─── Cocktails (Phase 5) ───────────────────────────────────────────────────
  // A cocktail IS a recipe — ingredients, a method, the full editor and the full
  // recipe page. It differs in exactly three places, and two of them are here: its
  // own chip and its own way in. (The third — never offered in the dinner planner —
  // is `isPlannable('cocktail') === false`, pinned in MealPlanWeekPage.test.ts.)

  it('switches to the Cocktails section and shows only cocktails', async () => {
    const user = userEvent.setup();
    seed([APPLE, TAKEAWAY, NEGRONI]);
    render(RecipeListPage);

    await pickKind(user, 'cocktail');

    expect(cardTitles()).toEqual(['Negroni']);
    expect(kindChip('cocktail')).toHaveAttribute('aria-pressed', 'true');
    expect(kindChip('recipe')).toHaveAttribute('aria-pressed', 'false');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('1 cocktail');
  });

  it('keeps cocktails out of the Recipes section', async () => {
    // The chip row is the only thing separating them; a cocktail must not also
    // show up under Recipes just because it is cookable.
    seed([APPLE, NEGRONI]);
    render(RecipeListPage);

    expect(cardTitles()).toEqual(['Apple Pie']);
  });

  it('keeps the ingredient count on a cocktail card — a cocktail has ingredients', async () => {
    const user = userEvent.setup();
    seed([APPLE, NEGRONI]);
    render(RecipeListPage);

    await pickKind(user, 'cocktail');

    // `takesIngredients('cocktail')` is true, so unlike an outing the count stays.
    expect(screen.getByTestId('recipe-list-item').textContent).toContain('3');
  });

  it('routes the New menu straight to the cocktail editor', async () => {
    const user = userEvent.setup();
    const { push } = await import('svelte-spa-router');
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-cocktail'));

    expect(push).toHaveBeenCalledWith('/recipes/new/cocktail');
  });

  // ─── Meals (issue #752) ────────────────────────────────────────────────────
  // A section that is NOT a kind. A Sunday roast is an ordinary recipe document
  // that has gained `componentRecipeIds`; "is this a meal?" is derived from that
  // array being non-empty, so nothing is stored, nothing is created, and one
  // entry stands on exactly one shelf.

  it('puts a recipe with components under Meals and takes it out of Recipes', async () => {
    const user = userEvent.setup();
    seed([APPLE, SUNDAY_ROAST]);
    render(RecipeListPage);

    // The single membership rule: the roast is gone from the section its KIND
    // would put it in, and it is the only thing under Meals.
    expect(cardTitles()).toEqual(['Apple Pie']);

    await pickKind(user, 'meal');

    expect(cardTitles()).toEqual(['Sunday roast']);
    expect(kindChip('meal')).toHaveAttribute('aria-pressed', 'true');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('1 meal');
  });

  it('collects meals of any kind — a cocktail with components is a meal too', async () => {
    const user = userEvent.setup();
    seed([APPLE, SUNDAY_ROAST, NEGRONI_WITH_SYRUP]);
    render(RecipeListPage);

    await pickKind(user, 'meal');
    expect(cardTitles()).toEqual(['Negroni with house syrup', 'Sunday roast']);

    // ...and it has left Cocktails, exactly as the roast left Recipes.
    await user.click(kindChip('cocktail'));
    expect(screen.queryByTestId('recipe-list')).toBeNull();
  });

  it('keeps the ingredient count on a meal card — a meal has its OWN ingredients', async () => {
    const user = userEvent.setup();
    seed([APPLE, SUNDAY_ROAST]);
    render(RecipeListPage);

    await pickKind(user, 'meal');

    // Nothing is aggregated from the components: the 4 here is the roast's own
    // ingredient list, and the count means what it means on every other card.
    expect(screen.getByTestId('recipe-list-item').textContent).toContain('4');
  });

  it('offers an empty Meals section rather than hiding it', async () => {
    const user = userEvent.setup();
    seed([APPLE, BANANA]);
    render(RecipeListPage);

    await pickKind(user, 'meal');

    expect(screen.queryByTestId('recipe-list')).toBeNull();
    expect(normalized(screen.getByTestId('recipe-kind-empty'))).toContain('No meals yet');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('0 meals');
  });

  it('offers no way to create a meal — a recipe BECOMES one', async () => {
    const user = userEvent.setup();
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));

    // The New menu is still derived from the creatable KINDS, which Meals is not.
    // An empty meal would just be a recipe under another name.
    expect(screen.queryByTestId('recipe-new-meal')).toBeNull();
    expect(screen.getByTestId('recipe-new-outing')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-new-cocktail')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-new-placeholder')).toBeInTheDocument();
  });
});

// ─── Authorship filters (issue #845) ──────────────────────────────────────────
// Two independent toggles matching the signed-in member's `Member.name` against
// the recipe's `createdBy` / `lastEditedBy` snapshots. A display filter and
// nothing else: attribution gates no action anywhere in the app.

const ME = 'Daniel';
const THEM = 'Nigel';

const MY_PIE = makeRecipe({
  id: 'my-pie',
  title: 'My Pie',
  tags: ['dessert', 'quick'],
  servings: 4,
  ingredientCount: 3,
  image: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: ME,
  lastEditedBy: ME,
});
// Theirs end to end — the one entry neither chip can ever match.
const THEIR_BREAD = makeRecipe({
  id: 'their-bread',
  title: 'Their Bread',
  tags: ['baking'],
  servings: 8,
  ingredientCount: 5,
  image: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  createdBy: THEM,
  lastEditedBy: THEM,
});
// Added by them, last touched by me: the entry that separates the two chips.
const THEIR_SOUP = makeRecipe({
  id: 'their-soup',
  title: 'Their Soup',
  tags: ['quick'],
  servings: 2,
  ingredientCount: 4,
  image: null,
  createdAt: '2026-08-03T00:00:00.000Z',
  createdBy: THEM,
  lastEditedBy: ME,
});
const MY_TAKEAWAY = makeRecipe({
  id: 'my-takeaway',
  kind: 'outing',
  title: 'My Takeaway',
  tags: ['friday'],
  servings: null,
  ingredientCount: 0,
  image: null,
  createdAt: '2026-08-04T00:00:00.000Z',
  createdBy: ME,
  lastEditedBy: ME,
});
const THEIR_TAKEAWAY = makeRecipe({
  id: 'their-takeaway',
  kind: 'outing',
  title: 'Their Takeaway',
  tags: ['friday'],
  servings: null,
  ingredientCount: 0,
  image: null,
  createdAt: '2026-08-05T00:00:00.000Z',
  createdBy: THEM,
  lastEditedBy: THEM,
});

function signedInAs(name: string | null): void {
  mockCurrentMember._set(name === null ? null : { name });
}

function authorChip(which: 'added' | 'edited'): HTMLElement {
  const row = screen.getByTestId('recipe-author-filters');
  const chip = within(row)
    .getAllByTestId('recipe-author-filter')
    .find((b) => b.getAttribute('data-author') === which);
  if (!chip) throw new Error(`no author chip for ${which}`);
  return chip;
}

describe('RecipeListPage — authorship filters', () => {
  it('does not offer the row when every recipe carries one name', () => {
    // The state the library is in the moment the backfill finishes. A filter
    // whose only possible answer is "everything" is dead chrome.
    signedInAs(ME);
    seed([MY_PIE, { ...MY_TAKEAWAY, kind: 'recipe' as const }]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-author-filters')).toBeNull();
  });

  it('does not offer the row when there is no name to be "me"', () => {
    // Roster still loading, or a signed-in email that is not on it. Two names
    // exist across the library, so the count alone would render the row — but
    // "Added by me" with no "me" is a chip that cannot answer its own question.
    signedInAs(null);
    seed([MY_PIE, THEIR_BREAD]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-author-filters')).toBeNull();
    expect(cardTitles()).toEqual(['My Pie', 'Their Bread']);
  });

  it('does not count a system account as a second author (issue #1300)', () => {
    // A recipe added from the kitchen screen keeps its honest "Added by Fridge"
    // stamp, and both entries stay in the grid — but a fridge is not a person to
    // filter by, so the row is not offered on the strength of its name alone.
    signedInAs(ME);
    mockSystemAccountNames._set(new Set(['Fridge']));
    seed([MY_PIE, { ...THEIR_BREAD, createdBy: 'Fridge', lastEditedBy: 'Fridge' }]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-author-filters')).toBeNull();
    expect(cardTitles()).toEqual(['My Pie', 'Their Bread']);
  });

  it('still counts a name that is simply not on the roster', () => {
    // The neighbour to the case above: only accounts an admin has actually
    // flagged are subtracted. A member since removed, or an import from another
    // environment, is a real second author and always was.
    signedInAs(ME);
    mockSystemAccountNames._set(new Set(['Fridge']));
    seed([MY_PIE, THEIR_BREAD]);
    render(RecipeListPage);

    expect(screen.getByTestId('recipe-author-filters')).toBeInTheDocument();
  });

  it('narrows to what I added, and reports the view as filtered', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, THEIR_SOUP]);
    render(RecipeListPage);

    expect(normalized(screen.getByTestId('recipe-result-count'))).not.toContain('filtered');

    await user.click(authorChip('added'));

    expect(cardTitles()).toEqual(['My Pie']);
    expect(authorChip('added')).toHaveAttribute('aria-pressed', 'true');
    expect(normalized(screen.getByTestId('recipe-result-count'))).toContain('filtered');
  });

  it('separates "added" from "edited" — a dish of theirs I last touched', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, THEIR_SOUP]);
    render(RecipeListPage);

    await user.click(authorChip('edited'));
    // Their soup counts here and nowhere else: I am the last person to have
    // edited it, and I did not add it.
    expect(cardTitles()).toEqual(['My Pie', 'Their Soup']);

    // Both on is an AND, exactly as two tags are — added AND last edited by me.
    await user.click(authorChip('added'));
    expect(cardTitles()).toEqual(['My Pie']);
    expect(authorChip('added')).toHaveAttribute('aria-pressed', 'true');
    expect(authorChip('edited')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the row on screen once the filter narrows the grid to one name', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, THEIR_SOUP]);
    render(RecipeListPage);

    await user.click(authorChip('added'));

    // Counted over the whole library, not the filtered subset — otherwise the
    // row would disappear from under the finger that just used it, with no way
    // back to the unfiltered view except "Clear".
    expect(cardTitles()).toEqual(['My Pie']);
    expect(screen.getByTestId('recipe-author-filters')).toBeInTheDocument();
  });

  it('combines with search and tags', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, THEIR_SOUP]);
    render(RecipeListPage);

    await user.click(authorChip('edited'));
    expect(cardTitles()).toEqual(['My Pie', 'Their Soup']);

    // "quick" is on both of those; the search then picks one out of the two.
    await user.click(
      within(screen.getByTestId('recipe-tag-filters')).getByRole('button', { name: '#quick' }),
    );
    expect(cardTitles()).toEqual(['My Pie', 'Their Soup']);

    await user.type(screen.getByTestId('recipe-search-input'), 'soup');
    expect(cardTitles()).toEqual(['Their Soup']);
  });

  it('survives a section switch, while the tags still reset', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, MY_TAKEAWAY, THEIR_TAKEAWAY]);
    render(RecipeListPage);

    await user.click(authorChip('added'));
    await user.click(
      within(screen.getByTestId('recipe-tag-filters')).getByRole('button', { name: '#quick' }),
    );
    expect(cardTitles()).toEqual(['My Pie']);

    await pickKind(user, 'outing');

    // "Mine" means the same thing on every shelf, so it carries across — unlike
    // the tag vocabulary, which is per-section and is dropped.
    expect(authorChip('added')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['My Takeaway']);
    expect(
      within(screen.getByTestId('recipe-tag-filters'))
        .getAllByTestId('recipe-tag-filter')
        .every((b) => b.getAttribute('aria-pressed') === 'false'),
    ).toBe(true);
  });

  it('clears with "Clear filters", and leaves you where you were standing', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    seed([MY_PIE, THEIR_BREAD, MY_TAKEAWAY, THEIR_TAKEAWAY]);
    render(RecipeListPage);

    await pickKind(user, 'outing');
    await user.click(authorChip('added'));
    expect(cardTitles()).toEqual(['My Takeaway']);

    await user.click(screen.getByTestId('recipe-clear-filters'));

    expect(authorChip('added')).toHaveAttribute('aria-pressed', 'false');
    expect(cardTitles()).toEqual(['My Takeaway', 'Their Takeaway']);
    // Clearing a filter is not a teleport back to Recipes.
    expect(kindChip('outing')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers the same clear from the no-matches state', async () => {
    const user = userEvent.setup();
    signedInAs(ME);
    // Nothing in this section is mine, so the filter empties the grid.
    seed([THEIR_BREAD, THEIR_SOUP, MY_TAKEAWAY]);
    render(RecipeListPage);

    await user.click(authorChip('added'));

    expect(screen.queryByTestId('recipe-list')).toBeNull();
    expect(screen.getByTestId('recipe-no-matches')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cardTitles()).toEqual(['Their Bread', 'Their Soup']);
  });

  it('matches on the FULL stored name, not the first name shown on screen', async () => {
    const user = userEvent.setup();
    // Attribution renders first names ("everyone is a Pendery") but the split is
    // at DISPLAY time only — this filter is still a plain `===` against the
    // verbatim `Member.name`. Two people sharing a first name is the case that
    // proves it: only one of these is mine.
    signedInAs('Kate Pendery');
    seed([
      makeRecipe({
        id: 'hers',
        title: 'Hers',
        tags: [],
        servings: null,
        ingredientCount: 1,
        image: null,
        createdAt: '2026-08-06T00:00:00.000Z',
        createdBy: 'Kate Pendery',
        lastEditedBy: 'Kate Pendery',
      }),
      makeRecipe({
        id: 'the-other-kates',
        title: 'The Other Kates',
        tags: [],
        servings: null,
        ingredientCount: 1,
        image: null,
        createdAt: '2026-08-07T00:00:00.000Z',
        createdBy: 'Kate Ashworth',
        lastEditedBy: 'Kate Ashworth',
      }),
    ]);
    render(RecipeListPage);
    expect(cardTitles()).toEqual(['Hers', 'The Other Kates']);

    await user.click(authorChip('added'));
    expect(cardTitles()).toEqual(['Hers']);
  });
});

// ─── Import from photo (issue #649) ───────────────────────────────────────────
// The list page owns only the way in and the way out; capture, framing and the
// extraction call belong to RecipeImportPhotoDialog (covered by its own suite).

describe('RecipeListPage — import from photo', () => {
  beforeEach(() => {
    vi.mocked(URL).createObjectURL = vi.fn(() => 'blob:page-1');
    vi.mocked(URL).revokeObjectURL = vi.fn();
    setNextCrop('stub-cropped-base64');
  });

  it('offers photo import in the New menu and opens the capture dialog', async () => {
    const user = userEvent.setup();
    seed([APPLE]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-import-photo-dialog')).toBeNull();

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-import-photo'));

    expect(await screen.findByTestId('recipe-import-photo-dialog')).toBeInTheDocument();
  });

  it('offers photo import as a peer of URL import in the empty state', async () => {
    const user = userEvent.setup();
    seed([]);
    render(RecipeListPage);

    // An empty library is exactly where someone stands holding a cookbook, so
    // the two imports are offered side by side rather than one being buried.
    expect(screen.getByTestId('recipe-import-url-toggle-empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('recipe-import-photo-toggle-empty'));

    expect(await screen.findByTestId('recipe-import-photo-dialog')).toBeInTheDocument();
  });

  it('stashes the draft and opens the saved recipe’s editor on success', async () => {
    const user = userEvent.setup();
    const { push } = await import('svelte-spa-router');
    const draft = { ...APPLE, id: 'imported-9' };
    vi.mocked(importRecipeFromPhoto).mockResolvedValue({ kind: 'ok', value: draft });
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-import-photo'));
    await user.upload(
      await screen.findByTestId('recipe-import-photo-input'),
      new File(['bytes'], 'page.jpg', { type: 'image/jpeg' }),
    );
    await user.click(await screen.findByTestId('recipe-import-photo-use'));
    await user.click(await screen.findByTestId('recipe-import-photo-btn'));

    // The callable already persisted the recipe flagged as not yet reviewed
    // (issue #616), so this opens THAT recipe's editor — never /recipes/new.
    await waitFor(() => expect(stashImportedDraft).toHaveBeenCalledWith(draft));
    expect(push).toHaveBeenCalledWith('/recipes/imported-9/edit');
  });
});

// ─── Import from URL (issue #616; extracted to its own dialog in #752) ────────
// The form used to be inline here, twice — once in the empty state and once
// above the grid. It now lives in RecipeImportUrlDialog, which the meal page
// mounts too; this page still owns the ways IN and the landing, exactly as it
// does for photo import. The testids are unchanged on purpose: what moved is
// where the markup lives, not what any of it is called.

describe('RecipeListPage — import from URL', () => {
  beforeEach(() => {
    vi.mocked(takePendingImportUrl).mockReturnValue(null);
  });

  it('opens the import dialog from the New menu', async () => {
    const user = userEvent.setup();
    seed([APPLE]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-import-url-area')).toBeNull();

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-import'));

    expect(await screen.findByTestId('recipe-import-url-area')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-import-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-import-url-btn')).toBeInTheDocument();
  });

  it('opens the same dialog from the empty state', async () => {
    const user = userEvent.setup();
    seed([]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-import-url-toggle-empty'));

    // One dialog, one piece of state — the two entry points can no longer drift.
    expect(await screen.findByTestId('recipe-import-url-area')).toBeInTheDocument();
  });

  it('stashes the draft and opens the saved recipe’s editor on success', async () => {
    const user = userEvent.setup();
    const { push } = await import('svelte-spa-router');
    const draft = { ...APPLE, id: 'imported-7' };
    vi.mocked(importRecipeFromUrl).mockResolvedValue({ kind: 'ok', value: draft });
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-import'));
    // `fireEvent` for the typing: bits-ui focus traps inside a Dialog eat
    // `userEvent` keystrokes in these suites.
    await fireEvent.input(await screen.findByTestId('recipe-import-url-input'), {
      target: { value: 'https://example.com/pie' },
    });
    await user.click(screen.getByTestId('recipe-import-url-btn'));

    expect(importRecipeFromUrl).toHaveBeenCalledWith('https://example.com/pie');
    await waitFor(() => expect(stashImportedDraft).toHaveBeenCalledWith(draft));
    // No meal in play here, so the landing is the plain editor.
    expect(push).toHaveBeenCalledWith('/recipes/imported-7/edit');
  });

  it('offers the way back in — not a toast — when the session has died', async () => {
    const user = userEvent.setup();
    vi.mocked(importRecipeFromUrl).mockResolvedValue({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'unauthenticated' },
    });
    seed([APPLE]);
    render(RecipeListPage);

    await user.click(screen.getByTestId('recipe-new-btn'));
    await user.click(screen.getByTestId('recipe-new-import'));
    await fireEvent.input(await screen.findByTestId('recipe-import-url-input'), {
      target: { value: 'https://example.com/pie' },
    });
    await user.click(screen.getByTestId('recipe-import-url-btn'));

    // Issue #740's recovery survived the extraction intact: the message and the
    // route out are in the sheet, where they can be acted on.
    expect(await screen.findByTestId('recipe-import-signed-out')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-import-sign-in-btn')).toBeInTheDocument();
  });

  it('reopens pre-filled with a URL rescued from a signed-out import', async () => {
    // The other half of #740, and the one the extraction could most easily have
    // dropped: the stash is drained by THIS page at init and handed to the dialog
    // as its initial value, so signing back in costs the user nothing. It is also
    // where the share target lands (shareTarget.ts).
    vi.mocked(takePendingImportUrl).mockReturnValue('https://example.com/rescued');
    seed([APPLE]);
    render(RecipeListPage);

    expect(await screen.findByTestId('recipe-import-url-input')).toHaveValue(
      'https://example.com/rescued',
    );
  });
});

describe('RecipeListPage — silent match problems', () => {
  const LIME = {
    id: 'canon-lime',
    schemaVersion: 5,
    name: 'lime',
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    unit: 'count',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };

  // A recipe with one citrus line already matched to Lime — the #855 shape.
  function citrusRecipe(canonId: string | null = 'canon-lime'): Recipe {
    const base = makeRecipe({
      id: 'r-citrus',
      title: 'Margarita',
      tags: [],
      servings: null,
      ingredientCount: 1,
      image: null,
      createdAt: '2026-08-19T00:00:00.000Z',
    });
    return {
      ...base,
      ingredients: [
        {
          id: 'g',
          name: null,
          items: [
            {
              id: 'i0',
              rawText: 'Juice of 2 limes',
              parsed: {
                quantity: { type: 'single' as const, value: 60 },
                unit: 'ml' as const,
                item: 'lime juice',
                preparation: [],
                notes: null,
                displayText: '2 limes',
              },
              canonId,
              matchState: 'matched' as const,
              isOptional: false,
              firstUsedInStepId: null,
            },
          ],
        },
      ],
    };
  }

  it('pips a card whose line buys millilitres of a thing sold by the count', async () => {
    mockCanonItems._set([LIME]);
    // Lime carries a form for something else — zest, as the live Lemon does. That
    // is what puts it within the pip's reach: a canon with no form at all has
    // nothing for the line to point at and is silent by design (issue #867).
    mockProductForms._set([
      {
        id: 'form-lime-zest',
        schemaVersion: 1,
        matchers: [],
        parentCanonId: 'canon-lime',
        thumbnail: null,
        label: 'Lime zest',
        yield: { formUnit: 'g', amountPerParent: 5 },
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
    ]);
    seed([citrusRecipe()]);
    render(RecipeListPage);

    const pip = await screen.findByTestId('recipe-match-issue-pip');
    expect(pip).toHaveTextContent('1');
  });

  it('drops the pip once a product form bridges the line', async () => {
    mockCanonItems._set([LIME]);
    mockProductForms._set([
      {
        id: 'form-lime-juice',
        schemaVersion: 1,
        matchers: [],
        parentCanonId: 'canon-lime',
        thumbnail: null,
        label: 'Lime juice',
        yield: { formUnit: 'ml', amountPerParent: 30 },
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
    ]);
    seed([citrusRecipe()]);
    render(RecipeListPage);

    await screen.findAllByTestId('recipe-list-item');
    expect(screen.queryByTestId('recipe-match-issue-pip')).not.toBeInTheDocument();
  });

  it('pips a line pointing at a canon item that has been deleted', async () => {
    mockCanonItems._set([LIME]);
    seed([citrusRecipe('canon-since-deleted')]);
    render(RecipeListPage);

    expect(await screen.findByTestId('recipe-match-issue-pip')).toHaveTextContent('1');
  });

  it('shows nothing at all before canon has landed', async () => {
    // The flash guard: canon arrives after first paint, and an empty canon makes
    // every matched line look dangling. Judging early would amber the library.
    mockCanonItems._set([]);
    seed([citrusRecipe()]);
    render(RecipeListPage);

    await screen.findAllByTestId('recipe-list-item');
    expect(screen.queryByTestId('recipe-match-issue-pip')).not.toBeInTheDocument();
  });

  it('holds off while the product-form collection is still loading', async () => {
    mockCanonItems._set([LIME]);
    mockIsLoadingProductForms._set(true);
    seed([citrusRecipe()]);
    render(RecipeListPage);

    await screen.findAllByTestId('recipe-list-item');
    expect(screen.queryByTestId('recipe-match-issue-pip')).not.toBeInTheDocument();
    mockIsLoadingProductForms._set(false);
  });

  // ─── The three-clause readiness gate (issue #1055 characterisation) ──────────
  // `matchIssuesKnown` is `!$isLoadingAisles && !$isLoadingProductForms &&
  // $canonItems.length > 0`, and `RecipeViewPage` declares a character-identical
  // expression under a different name (`matchMarkersKnown`). The two must agree
  // exactly — the card says a recipe has three problems and the rows on that
  // recipe must show three (issue #867) — and until this table nothing but a
  // comment held them together.
  //
  // Each suite pinned a DIFFERENT two of the three clauses: `mockIsLoadingAisles`
  // was declared in this file and never set, and `mockCanonItems._set([])` never
  // appeared in the other one. So the gate's own suite could not see either half
  // being deleted. The counterpart table lives in
  // `RecipeViewPage.matchMarkers.test.ts`; the pair is the machine-checked form
  // of the claim "these are the same gate".
  describe('readiness gate — every clause closes it', () => {
    afterEach(() => {
      mockIsLoadingAisles._set(false);
      mockIsLoadingProductForms._set(false);
    });

    it.each([
      ['isLoadingAisles is still true', (): void => mockIsLoadingAisles._set(true)],
      ['isLoadingProductForms is still true', (): void => mockIsLoadingProductForms._set(true)],
      ['canon has not landed yet', (): void => mockCanonItems._set([])],
    ])('shows no pip while %s', async (_clause, closeTheGate) => {
      mockCanonItems._set([LIME]);
      closeTheGate();
      seed([citrusRecipe('canon-since-deleted')]);
      render(RecipeListPage);

      await screen.findAllByTestId('recipe-list-item');
      expect(screen.queryByTestId('recipe-match-issue-pip')).not.toBeInTheDocument();
    });

    it('pips as soon as all three clauses are satisfied', async () => {
      // The control the three rows above need: without it they would all pass on
      // a fixture that never pips at all, and the table would be vacuous.
      mockCanonItems._set([LIME]);
      seed([citrusRecipe('canon-since-deleted')]);
      render(RecipeListPage);

      expect(await screen.findByTestId('recipe-match-issue-pip')).toHaveTextContent('1');
    });
  });
});

// ─── Hero URL rule (issue #933 characterisation) ──────────────────────────────
// This is issue #933's characterisation net for the "hero URL" rule — one of
// eight identical copies of `appendCacheBuster(recipe.image.url,
// recipe.imageRequestedAt ?? recipe.updatedAt)` scattered across web-pwa. It
// must stay green, UNMODIFIED, once all eight collapse onto one shared
// `@salt/domain` function. Expectations are computed by calling the REAL
// `appendCacheBuster` rather than hand-encoding a query string, so the net pins
// the RULE rather than one particular encoding of it.
describe('RecipeListPage — hero URL rule (issue #933 characterisation)', () => {
  it.each([
    {
      name: 'busts with imageRequestedAt when present',
      url: 'http://img.test/hero-rule.jpg',
      imageRequestedAt: 5000,
    },
    {
      name: 'falls back to updatedAt when imageRequestedAt is absent',
      url: 'http://img.test/hero-rule.jpg',
      imageRequestedAt: undefined,
    },
    {
      // ?/&-aware: covered here because this suite's fixture already lets the
      // stored URL carry an arbitrary query string for free.
      name: 'is &-aware when the stored URL already carries a query string',
      url: 'http://img.test/hero-rule.jpg?w=400',
      imageRequestedAt: 42,
    },
  ])('$name', ({ url, imageRequestedAt }) => {
    const heroRecipe = makeRecipe({
      id: 'hero-rule',
      title: 'Hero Rule',
      tags: [],
      servings: null,
      ingredientCount: 0,
      image: { url, source: 'ai' },
      ...(imageRequestedAt !== undefined ? { imageRequestedAt } : {}),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seed([heroRecipe]);
    render(RecipeListPage);

    expect(screen.getByTestId('recipe-list-thumb')).toHaveAttribute(
      'src',
      appendCacheBuster(url, imageRequestedAt ?? heroRecipe.updatedAt),
    );
  });

  it('renders no thumb — only the fallback tile — when there is no image', () => {
    seed([
      makeRecipe({
        id: 'hero-none',
        title: 'Hero None',
        tags: [],
        servings: null,
        ingredientCount: 0,
        image: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    render(RecipeListPage);

    expect(screen.queryByTestId('recipe-list-thumb')).toBeNull();
    expect(screen.getByTestId('recipe-list-thumb-fallback')).toBeInTheDocument();
  });
});

// ─── Timing on the card, and in the sort (issue #1122) ────────────────────────
// The list is the surface where the two accounts of a recipe's timing were most
// obviously the same fact twice: a card labelled from a stored total and a
// Quickest sort ordering by it. Both now read the phase sum where there is one,
// and since #1211 there is no second figure left to read.
//
// The feature key reads ON throughout the unit suite — with no PostHog key
// nothing can be gated (`isObservabilityFeatureEnabled`) — so the fixtures
// without a strip are the key-off rendering as well as the un-backfilled one.
// The key-off resolution itself is pinned in `tests/phaseTimeline.test.ts`.

const STRIP_65 = [
  { label: 'Parboil', handsOnMinutes: 5, handsOffMinutes: 10 },
  { label: 'Roast', handsOnMinutes: 5, handsOffMinutes: 45 },
];

function timed(id: string, title: string, over: Partial<Parameters<typeof makeRecipe>[0]> = {}) {
  return makeRecipe({
    id,
    title,
    tags: [],
    servings: null,
    ingredientCount: 0,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

describe('RecipeListPage — how long it takes', () => {
  // #1213 removed the fallback under the chip and #1211 the field it fell back
  // to: only a recipe with a strip gets a chip, which is the mechanical half of
  // "the list shows no total time for anyone".
  it('labels the card from the phase sum, and shows nothing without one', () => {
    seed([timed('phased', 'Phased Dish', { phases: STRIP_65 }), timed('plain', 'Plain Dish')]);
    render(RecipeListPage);

    const cards = screen.getAllByTestId('recipe-list-item');
    expect(normalized(cards[0]!)).toContain('1 hr 5 min');
    expect(normalized(cards[1]!)).not.toContain('min');
  });

  it('shows no time chip at all for a recipe with no strip', () => {
    seed([timed('bare', 'Bare Dish')]);
    render(RecipeListPage);

    expect(normalized(screen.getByTestId('recipe-list-item'))).not.toContain('min');
  });

  // The chip and the sort go through one function, and this is what says so: the
  // 65-minute strip sorts BEHIND the 30-minute strip, and `Untimed Dish` — which
  // carries no strip at all — cannot be placed by a figure it does not have.
  // `fireEvent`, not `userEvent`: the popover primitive marks the page inert while
  // it opens, and user-event refuses to click through `pointer-events: none`.
  it('orders Quickest by the same figure the card shows', async () => {
    seed([
      timed('phased', 'Phased Dish', { phases: STRIP_65 }),
      timed('half', 'Half Hour', {
        phases: [{ label: 'Simmer', handsOnMinutes: 5, handsOffMinutes: 25 }],
      }),
      timed('untimed', 'Untimed Dish'),
    ]);
    render(RecipeListPage);

    await fireEvent.click(screen.getByTestId('recipe-sort-trigger'));
    const quickest = await waitFor(() => {
      const option = screen
        .getAllByTestId('recipe-sort-option')
        .find((el) => el.getAttribute('data-sort') === 'quickest');
      if (option === undefined) throw new Error('Quickest option not open');
      return option;
    });
    await fireEvent.click(quickest);

    await waitFor(() => expect(cardTitles()).toEqual(['Half Hour', 'Phased Dish', 'Untimed Dish']));
  });
});
