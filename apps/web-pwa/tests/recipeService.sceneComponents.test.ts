import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { componentDisplayLines } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// The dishes a meal is built from, on their way to the art director (issue #838).
//
// The property this file exists for is an EQUALITY BETWEEN TWO CALLERS, not a
// string. The onRecipeWritten trigger resolves a meal's dishes against Firestore
// (it has no in-memory store); this side resolves them against the recipes store
// the app is already subscribed to, for zero extra reads. Both then render them
// with the SAME `componentDisplayLines` — so a brief authored from the regenerate
// dialog and a brief authored on write describe the same dinner. Every assertion
// below therefore compares against `componentDisplayLines(...)` rather than a
// hand-written line: a literal here could drift from the trigger's, this cannot.
//
// The recipes store is module-internal singleton state with no reset seam and
// seeded recipes accumulate across tests, so every fixture id is namespaced per
// test (see recipeService.attachComponent.test.ts).

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  callDescribeRecipeScene: vi.fn(),
  saveShoppingListItem: vi.fn(),
}));

// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  // Inert no-op span: tracing is best-effort, so the traced brief actions behave
  // exactly as a bare callable call when the tracer has nothing to say.
  startUserActionSpan: vi.fn(() => ({
    child: () => ({ end: () => {} }),
    end: () => {},
    setAttribute: () => {},
    setError: () => {},
    traceparent: '',
  })),
}));

vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));
vi.mock('../src/lib/productFormService.js', () => ({ getProductFormsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import {
  initRecipeSync,
  reviseRecipeSceneBrief,
  startOverRecipeSceneBrief,
} from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

let ns = 0;
function nsId(id: string): string {
  return `t${ns}-${id}`;
}

function recipe(
  id: string,
  opts: {
    title?: string;
    description?: string | null;
    componentRecipeIds?: string[];
  } = {},
): Recipe {
  return {
    cureCategory: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title: opts.title ?? id,
    description: opts.description ?? null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: opts.componentRecipeIds ?? [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    // Fresh, monotonically-increasing stamp so a re-seed of the same id is never
    // rejected by the store's stale-echo guard.
    updatedAt: new Date().toISOString(),
  };
}

/** Seed the in-memory recipes store via the (mocked) subscription seam. */
function seedRecipes(list: Recipe[]): void {
  (fs.subscribeRecipes as ReturnType<typeof vi.fn>).mockImplementation(
    (onNext: (r: Recipe[]) => void) => {
      onNext(list);
      return () => {};
    },
  );
  initRecipeSync();
}

/** What the flow was actually asked to read. */
function sceneInput(): { components: string[] } {
  return (fs.callDescribeRecipeScene as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    components: string[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ns++;
  fs.callDescribeRecipeScene.mockResolvedValue({
    kind: 'ok',
    value: { brief: 'A laid table under a low lamp.' },
  });
});

describe('scene brief — a meal carries its dishes', () => {
  it('sends the dishes the trigger would send for the same meal', async () => {
    const chicken = recipe(nsId('chicken'), {
      title: 'Roast chicken',
      description: 'Lemon and thyme, skin crisp and burnished.',
    });
    // No description — the line is the title alone, and that asymmetry is the
    // detail two hand-written literals would most easily disagree about.
    const potatoes = recipe(nsId('potatoes'), { title: 'Roast potatoes' });
    const roast = recipe(nsId('roast'), {
      title: 'Sunday roast',
      componentRecipeIds: [chicken.id, potatoes.id],
    });
    seedRecipes([roast, chicken, potatoes]);

    await startOverRecipeSceneBrief(roast);

    // The trigger renders its Firestore-resolved dishes through this very helper,
    // so asserting against it is asserting the two callers agree.
    expect(sceneInput().components).toEqual(componentDisplayLines([chicken, potatoes]));
  });

  it('keeps the stored order, which is roughly the order the dinner runs', async () => {
    const gravy = recipe(nsId('gravy'), { title: 'Onion gravy' });
    const chicken = recipe(nsId('chicken'), { title: 'Roast chicken' });
    const roast = recipe(nsId('roast'), { componentRecipeIds: [gravy.id, chicken.id] });
    seedRecipes([roast, gravy, chicken]);

    await startOverRecipeSceneBrief(roast);

    expect(sceneInput().components).toEqual(componentDisplayLines([gravy, chicken]));
  });

  it('skips a dish deleted on another device rather than sending a hole', async () => {
    // `resolveComponents`' dangling-id contract, which the trigger's Firestore
    // reader reproduces: one dish fewer in the brief, never a failed call.
    const chicken = recipe(nsId('chicken'), { title: 'Roast chicken' });
    const roast = recipe(nsId('roast'), {
      componentRecipeIds: [chicken.id, nsId('deleted-elsewhere')],
    });
    seedRecipes([roast, chicken]);

    await startOverRecipeSceneBrief(roast);

    expect(sceneInput().components).toEqual(componentDisplayLines([chicken]));
  });

  it('sends [] for a plain recipe, so its prompt is the one it always had', async () => {
    const plain = recipe(nsId('melanzane'), { title: 'Melanzane alla parmigiana' });
    seedRecipes([plain]);

    await startOverRecipeSceneBrief(plain);

    expect(sceneInput().components).toEqual([]);
    expect(sceneInput().components).toEqual(componentDisplayLines([]));
  });

  it('carries the dishes through a revision too', async () => {
    // "make it summery" on a roast is still a steer applied to a picture of a
    // TABLE — both brief actions flatten the recipe the same way, so the dishes
    // cannot fall out of one of them.
    const chicken = recipe(nsId('chicken'), { title: 'Roast chicken' });
    const roast = recipe(nsId('roast'), { componentRecipeIds: [chicken.id] });
    seedRecipes([roast, chicken]);

    await reviseRecipeSceneBrief(roast, 'A single plated portion.', 'make it summery');

    expect(sceneInput().components).toEqual(componentDisplayLines([chicken]));
  });
});
