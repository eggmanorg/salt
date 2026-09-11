import { describe, it, expect, beforeEach, afterEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// In-place recipe editing writes at KEYSTROKE rate (issue #1319), so recipe
// writes go through the same debounced coalescer the meal planner already uses.
// This file pins the four properties the feature rests on, each of which is
// false under an obvious wrong implementation:
//
//   1. a burst inside one window is ONE write, of the LAST document;
//   2. the optimistic store apply is NOT deferred with it — every edit composes
//      from the previous one, so a deferred apply would silently discard edits;
//   3. a flush writes now rather than waiting the window out;
//   4. every edit in one window is handed the SAME promise. That is what makes
//      "at most one toast per burst" checkable rather than merely intended — see
//      `RecipeViewPage.reviewFlag.test.ts`, which pins the toast itself.
//
// And the fifth, which is about what did NOT change: `persistRecipe` is still
// immediate. Every existing caller is one deliberate tap, and deferring one
// would mean a reload inside the window discards a finished act.
//
// The recipes store is module-internal singleton state with no reset seam, so
// every fixture id is namespaced per test (see recipeService.attachComponent).

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn(),
  subscribeMembers: vi.fn(() => vi.fn()),
  upsertMember: vi.fn(),
  deleteMember: vi.fn(),
}));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  startUserActionSpan: vi.fn(),
}));
vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));
vi.mock('../src/lib/productFormService.js', () => ({ getProductFormsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import {
  recipes,
  persistRecipe,
  queueRecipeEdit,
  flushRecipeWrites,
  discardPendingRecipeWrites,
} from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const NOW = '2026-01-01T00:00:00.000Z';

let ns = 0;
function seeded(overrides: Partial<Recipe> = {}): Recipe {
  ns += 1;
  return { ...emptyRecipe(`coalesce-${ns}`, NOW), title: 'Carbonara', ...overrides };
}

/** The recipe as the in-memory store currently holds it. */
function fromStore(id: string): Recipe | undefined {
  return get(recipes).find((r) => r.id === id);
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  vi.useFakeTimers();
});

afterEach(() => {
  discardPendingRecipeWrites();
  vi.useRealTimers();
});

describe('queueRecipeEdit — coalesced in-place edits', () => {
  it('turns a burst of edits into one write carrying the last document', async () => {
    const base = seeded();
    for (const title of ['C', 'Ca', 'Car', 'Carb']) {
      queueRecipeEdit({ ...(fromStore(base.id) ?? base), title });
    }

    expect(fs.saveRecipe).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    expect(fs.saveRecipe).toHaveBeenCalledTimes(1);
    expect(fs.saveRecipe.mock.calls[0]![0].title).toBe('Carb');
  });

  it('applies every edit to the store synchronously, so edits compose', () => {
    const base = seeded();
    queueRecipeEdit({ ...base, title: 'Renamed' });
    // Read back BEFORE any timer runs: the apply is what must not be deferred.
    expect(fromStore(base.id)?.title).toBe('Renamed');

    queueRecipeEdit({ ...fromStore(base.id)!, description: 'Silky' });
    const composed = fromStore(base.id)!;
    expect(composed.title).toBe('Renamed');
    expect(composed.description).toBe('Silky');
  });

  it('keeps the edited recipe in its place in the store rather than moving it', async () => {
    const first = seeded({ title: 'First' });
    const second = seeded({ title: 'Second' });
    await persistRecipe(first);
    await persistRecipe(second);
    const before = get(recipes).map((r) => r.id);

    queueRecipeEdit({ ...fromStore(first.id)!, title: 'First, edited' });

    expect(get(recipes).map((r) => r.id)).toEqual(before);
  });

  it('writes on a flush rather than waiting the debounce out', async () => {
    const base = seeded();
    queueRecipeEdit({ ...base, title: 'Flushed' });

    await flushRecipeWrites();

    expect(fs.saveRecipe).toHaveBeenCalledTimes(1);
    expect(fs.saveRecipe.mock.calls[0]![0].title).toBe('Flushed');
  });

  it('hands every edit in one window the same promise — one burst, one result', async () => {
    const base = seeded();
    const first = queueRecipeEdit({ ...base, title: 'A' });
    const second = queueRecipeEdit({ ...fromStore(base.id)!, title: 'AB' });

    expect(second).toBe(first);
    await vi.runAllTimersAsync();
    expect(await first).toEqual({ kind: 'ok', value: undefined });
  });

  it('surfaces a failed write as a Failure rather than throwing (Rule 10)', async () => {
    fs.saveRecipe.mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    } as never);
    const base = seeded();
    const write = queueRecipeEdit({ ...base, title: 'Doomed' });

    await vi.runAllTimersAsync();

    expect((await write).kind).toBe('err');
  });

  it('leaves persistRecipe immediate — a deliberate tap is never deferred', async () => {
    await persistRecipe(seeded({ title: 'Tapped' }));

    expect(fs.saveRecipe).toHaveBeenCalledTimes(1);
  });
});
