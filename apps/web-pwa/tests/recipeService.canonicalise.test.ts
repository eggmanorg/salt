import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { emptyRecipe } from '@salt/domain';
import type { Recipe, CanonItem, IngredientGroup } from '@salt/domain';

// ─── Mock firebase-sync ──────────────────────────────────────────────────────
vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
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
}));

// ─── Mock canonService ───────────────────────────────────────────────────────
const { mockGetCanonItemsSnapshot } = vi.hoisted(() => ({
  mockGetCanonItemsSnapshot: vi.fn(() => [] as import('@salt/domain').CanonItem[]),
}));

vi.mock('../src/lib/canonService.js', () => ({
  getCanonItemsSnapshot: mockGetCanonItemsSnapshot,
}));

import * as firebaseSync from '@salt/firebase-sync';
import { canonicaliseIngredients, matchIngredient } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCanonItem(id: string, needs_approval = false): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name: id,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

function makeRecipe(groups: IngredientGroup[]): Recipe {
  return {
    ...emptyRecipe('recipe-1', '2026-01-01T00:00:00.000Z'),
    title: 'Test Recipe',
    ingredients: groups,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeGroup(items: IngredientGroup['items']): IngredientGroup {
  return { id: 'g1', name: null, items };
}

const parsedIngredient = {
  quantity: { type: 'single' as const, value: 240 },
  unit: 'g' as const,
  item: 'flour',
  preparation: [],
  notes: null,
  displayText: '2 cups',
};

// The ingredient ids the one batch call carried, in order.
function sentIds(): (string | undefined)[] {
  const [payload] = fs.callCanonicaliseRecipeIngredients.mock.calls[0]!;
  return payload.items.map((i) => i.ingredientId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  // Default: empty canon store (no live matches).
  mockGetCanonItemsSnapshot.mockReturnValue([]);
});

// WHAT THIS SUITE OWNS SINCE #1434: the SELECTION — which ingredient lines are
// sent — and the fact that this function writes nothing at all. The per-item FOLD
// (`canonId`/`matchState`, the `needs_approval` case, the errored slot) moved into
// the Cloud Function with the write, and is pinned there by
// `apps/cloud-functions/tests/flows/canonicaliseRecipeIngredients.persist.test.ts`.
// Selection stayed here because it reads the BROWSER's live canon snapshot.
describe('canonicaliseIngredients', () => {
  it('returns success immediately when no ingredients are canonisable', async () => {
    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: '2 cups flour',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    const result = await canonicaliseIngredients(recipe);

    expect(result).toEqual({ kind: 'ok', value: undefined });
    expect(fs.callCanonicaliseRecipeIngredients).not.toHaveBeenCalled();
    expect(fs.saveRecipe).not.toHaveBeenCalled();
  });

  it('writes nothing itself — the function it called records the match (#1434)', async () => {
    // The defect this fixes: the write used to be the statement AFTER a
    // two-minute await, so a tab that went away performed none of it. This
    // asserts the browser write is GONE, not merely moved later.
    const canon = makeCanonItem('canon-flour', false);
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: canon } }],
    });

    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: '2 cups flour',
          parsed: parsedIngredient,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    const result = await canonicaliseIngredients(recipe);

    expect(result).toEqual({ kind: 'ok', value: undefined });
    expect(fs.saveRecipe).not.toHaveBeenCalled();
  });

  it('sends the recipe id and the per-row ingredient id, so the function can name what it writes', async () => {
    const canon = makeCanonItem('canon-butter', false);
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: canon } }],
    });

    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: '100g unsalted butter, melted',
          parsed: { ...parsedIngredient, item: 'butter' },
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    await canonicaliseIngredients(recipe);

    // `rawName` still comes from `parsed.item` and `rawText` from the line; the
    // identity fields are the addition.
    expect(fs.callCanonicaliseRecipeIngredients).toHaveBeenCalledWith({
      recipeId: 'recipe-1',
      items: [{ ingredientId: 'i1', rawName: 'butter', rawText: '100g unsalted butter, melted' }],
    });
  });

  it('retries failed ingredients (matchState failed + parsed)', async () => {
    const canon = makeCanonItem('canon-butter', false);
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: canon } }],
    });

    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: '100g butter',
          parsed: { ...parsedIngredient, item: 'butter' },
          canonId: null,
          matchState: 'failed',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    await canonicaliseIngredients(recipe);

    expect(fs.callCanonicaliseRecipeIngredients).toHaveBeenCalledOnce();
    expect(sentIds()).toEqual(['i1']);
  });

  it('skips ingredients whose canonId is live in the canon store', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour')]);

    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: 'flour',
          parsed: parsedIngredient,
          canonId: 'canon-flour',
          matchState: 'matched',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    const result = await canonicaliseIngredients(recipe);

    expect(result).toEqual({ kind: 'ok', value: undefined });
    expect(fs.callCanonicaliseRecipeIngredients).not.toHaveBeenCalled();
    expect(fs.saveRecipe).not.toHaveBeenCalled();
  });

  it('re-canonicalises a matched ingredient whose canon item was deleted (dangling)', async () => {
    // canon store is empty — 'canon-flour' no longer exists.
    mockGetCanonItemsSnapshot.mockReturnValue([]);

    const canon = makeCanonItem('canon-flour-new');
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: canon } }],
    });

    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: 'flour',
          parsed: parsedIngredient,
          canonId: 'canon-flour',
          matchState: 'matched',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);

    await canonicaliseIngredients(recipe);

    expect(fs.callCanonicaliseRecipeIngredients).toHaveBeenCalledOnce();
    expect(sentIds()).toEqual(['i1']);
  });

  it('handles multiple ingredients across groups in a single batch call', async () => {
    const canonFlour = makeCanonItem('canon-flour', false);
    const canonSugar = makeCanonItem('canon-sugar', false);
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [
        { kind: 'ok', value: { decision: 'matched', item: canonFlour } },
        { kind: 'ok', value: { decision: 'matched', item: canonSugar } },
      ],
    });

    const recipe = makeRecipe([
      {
        id: 'g1',
        name: 'Dry',
        items: [
          {
            id: 'i1',
            rawText: '2 cups flour',
            parsed: { ...parsedIngredient, item: 'flour' },
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
      {
        id: 'g2',
        name: 'Wet',
        items: [
          {
            id: 'i2',
            rawText: '1 cup sugar',
            parsed: { ...parsedIngredient, item: 'sugar' },
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ]);

    await canonicaliseIngredients(recipe);

    expect(fs.callCanonicaliseRecipeIngredients).toHaveBeenCalledOnce();
    // Both groups' rows go in one call, each carrying its own id so the function
    // can tell them apart.
    expect(sentIds()).toEqual(['i1', 'i2']);
  });
});

// The per-row match is the OTHER caller of the same callable, and #1435 settled
// that it stays a browser write until one `{ recipeId, ingredientId }` callable
// replaces both of its calls. Now that the callable CAN be asked to write, that
// decision needs a pin rather than a paragraph: sending `recipeId` from here would
// stamp `canonId`/`matchState` onto a row whose `parsed` is still null in
// Firestore, because the parse half of the pair is written by this function's
// caller afterwards.
describe('matchIngredient (per-row, still a browser write)', () => {
  it('does not ask the function to write', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [
        {
          id: 'g1',
          name: null,
          items: [
            {
              id: 'i1',
              rawText: '2 cups flour',
              parsed: parsedIngredient,
              canonId: null,
              matchState: 'pending' as const,
              isOptional: false,
              firstUsedInStepId: null,
            },
          ],
        },
      ],
    });
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: makeCanonItem('canon-flour') } }],
    });

    await matchIngredient({
      id: 'i1',
      rawText: '2 cups flour',
      parsed: null,
      canonId: null,
      matchState: 'pending',
      isOptional: false,
      firstUsedInStepId: null,
    });

    const [payload] = fs.callCanonicaliseRecipeIngredients.mock.calls[0]!;
    expect(payload.recipeId).toBeUndefined();
    expect(payload.items[0]!.ingredientId).toBeUndefined();
    expect(fs.saveRecipe).not.toHaveBeenCalled();
  });
});
