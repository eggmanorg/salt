import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { DomainError } from '@salt/shared-types';
import type { Recipe, Ingredient, IngredientGroup } from '@salt/domain';

// Stable, gated report() spy — delegates to the REAL category gate so suppressed
// write failures genuinely no-op (see canonService.errorReporting.test.ts).
const { reportSpy } = vi.hoisted(() => ({ reportSpy: vi.fn() }));

// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    isReportableCategory: actual.isReportableCategory,
    // Inert no-op span: tracing is best-effort, so the traced service functions must
    // behave exactly as a bare callable call when the tracer has nothing to say.
    startUserActionSpan: vi.fn(() => ({
      child: () => ({ end: () => {} }),
      end: () => {},
      setAttribute: () => {},
      setError: () => {},
      traceparent: '',
    })),
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        reportSpy(error, category);
      },
    })),
  };
});

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  callExtractRecipeFromUrl: vi.fn(),
  callDescribeRecipeScene: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
}));

const { mockGetCanonItemsSnapshot } = vi.hoisted(() => ({
  mockGetCanonItemsSnapshot: vi.fn(() => [] as import('@salt/domain').CanonItem[]),
}));
vi.mock('../src/lib/canonService.js', () => ({
  getCanonItemsSnapshot: mockGetCanonItemsSnapshot,
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  persistRecipe,
  removeRecipe,
  matchIngredient,
  canonicaliseIngredients,
  commitRecipeAddPlan,
  reviseRecipeSceneBrief,
  startOverRecipeSceneBrief,
  type RecipeAddRow,
} from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const STORAGE_ERR: DomainError = { kind: 'StorageError', reason: 'unavailable' };
const SYNC_ERR: DomainError = { kind: 'SyncError', reason: 'push-failed' };
const NETWORK_ERR: DomainError = { kind: 'NetworkError', reason: 'offline' };
const CONFLICT_ERR: DomainError = { kind: 'ConflictError' };

function makeRecipe(groups: IngredientGroup[] = []): Recipe {
  return {
    cureCategory: null,
    createdBy: '',
    lastEditedBy: '',
    kind: 'recipe',
    producesCanonId: null,
    kit: [],
    image: null,
    id: 'recipe-1',
    schemaVersion: 1,
    title: 'Test',
    description: null,
    ingredients: groups,
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    // Required on `Recipe` (`RecipeSchema` defaults it, so every document read
    // through firebase-sync carries it) and absent from this fixture until now —
    // `apps/web-pwa/tsconfig.json` only typechecks `src/**`, so nothing caught it.
    // The scene-brief input resolves a meal's dishes off this field (issue #838),
    // which turns the gap from harmless into a TypeError.
    componentRecipeIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeIngredient(id: string): Ingredient {
  return {
    firstUsedInStepId: null,
    id,
    rawText: '2 eggs',
    parsed: null,
    canonId: null,
    matchState: 'pending',
    isOptional: false,
  };
}

/** The same ingredient once the parse callable has filled in `parsed`. */
function parsedIngredient(id: string): Ingredient {
  return {
    ...makeIngredient(id),
    parsed: {
      item: 'egg',
      quantity: null,
      unit: null,
      preparation: [],
      notes: null,
      displayText: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportSpy.mockReset();
  fs.saveRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.deleteRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.saveShoppingListItem.mockResolvedValue({ kind: 'ok', value: undefined });
  mockGetCanonItemsSnapshot.mockReturnValue([]);
});

describe('recipeService — write/command failure reporting (Phase 2)', () => {
  describe('persistRecipe', () => {
    it('reports a StorageError save failure', async () => {
      fs.saveRecipe.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await persistRecipe(makeRecipe());
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('does NOT surface a ConflictError save failure (gate suppresses)', async () => {
      fs.saveRecipe.mockResolvedValueOnce({ kind: 'err', error: CONFLICT_ERR });
      await persistRecipe(makeRecipe());
      expect(reportSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeRecipe', () => {
    it('reports a SyncError delete failure', async () => {
      fs.deleteRecipe.mockResolvedValueOnce({ kind: 'err', error: SYNC_ERR });
      await removeRecipe('recipe-1');
      expect(reportSpy).toHaveBeenCalledWith(SYNC_ERR, 'SyncError');
    });
  });

  describe('matchIngredient (parse + canonicalise AI callables)', () => {
    it('reports a StorageError parse failure', async () => {
      fs.callParseRecipeIngredients.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await matchIngredient(makeIngredient('a'));
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('does NOT surface a NetworkError parse failure (gate suppresses)', async () => {
      fs.callParseRecipeIngredients.mockResolvedValueOnce({ kind: 'err', error: NETWORK_ERR });
      await matchIngredient(makeIngredient('a'));
      expect(reportSpy).not.toHaveBeenCalled();
    });

    it('reports a StorageError canonicalise failure after a successful parse', async () => {
      fs.callParseRecipeIngredients.mockResolvedValueOnce({
        kind: 'ok',
        value: [{ id: 'g1', name: null, items: [parsedIngredient('a')] }],
      });
      fs.callCanonicaliseRecipeIngredients.mockResolvedValueOnce({
        kind: 'err',
        error: STORAGE_ERR,
      });
      await matchIngredient(makeIngredient('a'));
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });
  });

  describe('canonicaliseIngredients (batch AI callable)', () => {
    it('reports a StorageError batch failure', async () => {
      const recipe = makeRecipe([{ id: 'g1', name: null, items: [parsedIngredient('a')] }]);
      fs.callCanonicaliseRecipeIngredients.mockResolvedValueOnce({
        kind: 'err',
        error: STORAGE_ERR,
      });
      await canonicaliseIngredients(recipe);
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });
  });

  describe('commitRecipeAddPlan (shopping-list item writes)', () => {
    const row: RecipeAddRow = {
      ingredientId: 'a',
      rawText: '2 eggs',
      itemText: 'eggs',
      notes: '',
      name: 'eggs',
      fromCanon: false,
      isOptional: false,
      canonId: null,
      matched: false,
      add: true,
      check: false,
      producers: [],
      make: false,
      producerId: null,
      madeServings: 1,
      subRows: null,
    };

    it('reports the first StorageError item-write failure', async () => {
      fs.saveShoppingListItem.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await commitRecipeAddPlan(makeRecipe(), 'list-1', 1, [row]);
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('does NOT report when all item writes succeed', async () => {
      fs.saveShoppingListItem.mockResolvedValue({ kind: 'ok', value: undefined });
      await commitRecipeAddPlan(makeRecipe(), 'list-1', 1, [row]);
      expect(reportSpy).not.toHaveBeenCalled();
    });
  });

  // Scene brief on demand (issue #522, Phase 3). Same category gate as every other
  // AI callable: report the unexpected, suppress the expected.
  describe('scene brief (describeRecipeScene callable)', () => {
    it('reports a StorageError revision failure', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await reviseRecipeSceneBrief(makeRecipe(), 'An autumnal bake.', 'make it summery');
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('does NOT surface a NetworkError revision failure (gate suppresses)', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({ kind: 'err', error: NETWORK_ERR });
      await reviseRecipeSceneBrief(makeRecipe(), 'An autumnal bake.', 'make it summery');
      expect(reportSpy).not.toHaveBeenCalled();
    });

    it('reports a StorageError start-over failure', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await startOverRecipeSceneBrief(makeRecipe());
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('returns the brief and reports nothing on success', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({
        kind: 'ok',
        value: { brief: 'A summery bake.' },
      });
      const result = await startOverRecipeSceneBrief(makeRecipe());
      // The brief itself, unwrapped — the object exists only for Genkit's structured
      // output and no caller wants it.
      expect(result).toEqual({ kind: 'ok', value: 'A summery bake.' });
      expect(reportSpy).not.toHaveBeenCalled();
    });

    it('sends the recipe with the brief and the hint on a revision', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({ kind: 'ok', value: { brief: 'x' } });
      await reviseRecipeSceneBrief(makeRecipe(), 'An autumnal bake.', 'make it summery');
      expect(fs.callDescribeRecipeScene).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test',
          currentBrief: 'An autumnal bake.',
          hint: 'make it summery',
        }),
        undefined,
      );
    });

    it('start over sends the recipe and NOTHING else', async () => {
      fs.callDescribeRecipeScene.mockResolvedValueOnce({ kind: 'ok', value: { brief: 'x' } });
      await startOverRecipeSceneBrief(makeRecipe());
      const input = fs.callDescribeRecipeScene.mock.calls[0]![0];
      // Neither half of a revision — so the flow authors from a fresh reading and the
      // accumulated edits are discarded, which is the whole point of "start over".
      expect(input).not.toHaveProperty('currentBrief');
      expect(input).not.toHaveProperty('hint');
    });
  });
});
