import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { CanonItem } from '@salt/domain';
import type { Ingredient, IngredientGroup } from '@salt/domain';

// ─── Mock firebase-sync ──────────────────────────────────────────────────────
vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn(),
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

import * as firebaseSync from '@salt/firebase-sync';
import { matchIngredient } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePendingIngredient(): Ingredient {
  return {
    id: 'ing-1',
    rawText: '2 cups flour',
    parsed: null,
    canonId: null,
    matchState: 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const parsedFlour = {
  quantity: { type: 'single' as const, value: 240 },
  unit: 'g' as const,
  item: 'flour',
  preparation: [],
  notes: null,
  displayText: '2 cups',
};

const parseGroup: IngredientGroup = {
  id: 'g1',
  name: null,
  items: [{ ...makePendingIngredient(), parsed: parsedFlour }],
};

function makeCanonItem(id: string): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name: id,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('matchIngredient', () => {
  it('returns matched ingredient with canonId and parsed when both CFs succeed', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({ kind: 'ok', value: [parseGroup] });
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: makeCanonItem('canon-flour') } }],
    });

    const result = await matchIngredient(makePendingIngredient());

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.matchState).toBe('matched');
    expect(result.value.canonId).toBe('canon-flour');
    expect(result.value.parsed).toEqual(parsedFlour);
    expect(result.value.id).toBe('ing-1');
    expect(result.value.rawText).toBe('2 cups flour');
  });

  it('returns failed + null canonId when canonise slot returns an error', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({ kind: 'ok', value: [parseGroup] });
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'err', error: { kind: 'NetworkError', reason: 'transient' } }],
    });

    const result = await matchIngredient(makePendingIngredient());

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.matchState).toBe('failed');
    expect(result.value.canonId).toBeNull();
    expect(result.value.parsed).toEqual(parsedFlour);
  });

  it('returns failed + null parsed when parse returns no structured item', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({ kind: 'ok', value: [] });

    const result = await matchIngredient(makePendingIngredient());

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.matchState).toBe('failed');
    expect(result.value.canonId).toBeNull();
    expect(result.value.parsed).toBeNull();
    expect(fs.callCanonicaliseRecipeIngredients).not.toHaveBeenCalled();
  });

  it('bubbles up transport error from callParseRecipeIngredients', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    const result = await matchIngredient(makePendingIngredient());

    expect(result.kind).toBe('err');
    expect(fs.callCanonicaliseRecipeIngredients).not.toHaveBeenCalled();
  });

  it('bubbles up transport error from callCanonicaliseRecipeIngredients', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({ kind: 'ok', value: [parseGroup] });
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    const result = await matchIngredient(makePendingIngredient());

    expect(result.kind).toBe('err');
  });

  it('calls canonicalise with rawName from parsed.item and rawText from ingredient', async () => {
    fs.callParseRecipeIngredients.mockResolvedValue({ kind: 'ok', value: [parseGroup] });
    fs.callCanonicaliseRecipeIngredients.mockResolvedValue({
      kind: 'ok',
      value: [{ kind: 'ok', value: { decision: 'matched', item: makeCanonItem('canon-flour') } }],
    });

    await matchIngredient(makePendingIngredient());

    expect(fs.callCanonicaliseRecipeIngredients).toHaveBeenCalledWith({
      items: [{ rawName: 'flour', rawText: '2 cups flour' }],
    });
  });
});
