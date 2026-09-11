import { describe, it, expect, beforeEach, afterEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import { emptyRecipe, diffRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { RecipeDoc } from '@salt/domain/schemas';

// A chat amendment against an in-place recipe edit (issue #1330).
//
// These tests run the REAL `recipeService` — its store, its coalescer, its
// snapshot echo guard — because every property here is about the ORDER two
// writes reach Firestore in and which `updatedAt` each carries, and neither
// survives a mocked seam. `recipeAmend.test.ts` keeps the seam-level suite; this
// one is the pin on the collision itself.
//
// What used to happen, both directions, both silent:
//   - Order A: the amendment wrote, then the typist's pending coalesced entry
//     fired its OWN older snapshot over it. The chef's changes vanished.
//   - Order B: the pending entry flushed first, then the amendment's document —
//     frozen with the `updatedAt` of the moment the AI call STARTED — landed on
//     top. The typing was gone from the server, and `applySnapshot` rejected the
//     amendment's own echo as stale, so the device that applied it saw neither.
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
vi.mock('../src/lib/guidedPlanService.js', () => ({
  discardGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  recipes,
  initRecipeSync,
  queueRecipeEdit,
  discardPendingRecipeWrites,
} from '../src/lib/recipeService.js';
import {
  applyRecipeAmendment,
  mergeAmendedRecipe,
  type RecipeAmendment,
} from '../src/lib/recipeAmend.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

/** When the librarian was called — before any of the typing below. */
const PROPOSE_AT = '2026-08-11T12:00:00.000Z';
/** When the user is typing and pressing Apply. Strictly later, as in life. */
const APPLY_AT = '2026-08-11T12:00:30.000Z';

let ns = 0;
function seeded(overrides: Partial<Recipe> = {}): Recipe {
  ns += 1;
  return {
    ...emptyRecipe(`amend-clobber-${ns}`, PROPOSE_AT),
    title: 'Chorizo & Red Pepper Pilaf',
    metadata: { servings: 4, tags: ['midweek'] },
    ...overrides,
  };
}

/** The recipe as the in-memory store currently holds it. */
function fromStore(id: string): Recipe | undefined {
  return get(recipes).find((r) => r.id === id);
}

/**
 * A proposal exactly as `proposeRecipeAmendment` builds one: the librarian's
 * draft, merged onto the recipe AS IT WAS when the call started, stamped with
 * the time the call started.
 */
function proposalAgainst(
  existing: Recipe,
  draftOverrides: Partial<RecipeDoc> = {},
): RecipeAmendment {
  const draft = {
    ...existing,
    id: 'draft-id',
    description: 'A one-pan supper, with chilli.',
    source: { type: 'manual' as const },
    image: null,
    // What the librarian returns for metadata it was not asked about.
    metadata: { servings: null, tags: [] },
    createdAt: PROPOSE_AT,
    updatedAt: PROPOSE_AT,
    ...draftOverrides,
  } as RecipeDoc;
  const updated = mergeAmendedRecipe(existing, draft, PROPOSE_AT);
  return { existing, draft, updated, diff: diffRecipe(existing, updated) };
}

/** Every document handed to `saveRecipe`, oldest call first. */
function savedDocs(): Recipe[] {
  return fs.saveRecipe.mock.calls.map((call) => call[0] as Recipe);
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(APPLY_AT));
});

afterEach(() => {
  discardPendingRecipeWrites();
  vi.useRealTimers();
});

/** Seed the store through the subscription seam and keep the snapshot callback. */
function seedStore(list: Recipe[]): (incoming: Recipe[]) => void {
  let onNext!: (incoming: Recipe[]) => void;
  fs.subscribeRecipes.mockImplementation(((next: (r: Recipe[]) => void) => {
    onNext = next;
    next(list);
    return () => {};
  }) as never);
  initRecipeSync();
  return onNext;
}

describe('applyRecipeAmendment — against a pending in-place edit (issue #1330)', () => {
  it('flushes the pending edit first and writes the amendment last, and nothing fires afterwards', async () => {
    const base = seeded();
    seedStore([base]);
    const proposal = proposalAgainst(base);

    // Still typing when Apply is pressed: an entry is pending and its 400 ms
    // timer has not elapsed.
    queueRecipeEdit({ ...fromStore(base.id)!, notes: 'Use the smoked one.' });
    expect(fs.saveRecipe).not.toHaveBeenCalled();

    await applyRecipeAmendment(proposal);

    // Both writes have gone out, typing first and the amendment last.
    expect(savedDocs().map((d) => d.notes)).toEqual(['Use the smoked one.', null]);

    // And the pending entry is GONE, not merely outrun: running the clock out
    // issues nothing more. This is the assertion that goes red on the old code,
    // where the queued snapshot fired here and replaced the amendment.
    await vi.runAllTimersAsync();
    expect(savedDocs()).toHaveLength(2);
    expect(savedDocs()[1]!.description).toBe('A one-pan supper, with chilli.');
  });

  it('stamps the amendment at write time, so the device that applied it keeps it when its own echo arrives', async () => {
    const base = seeded();
    const onSnapshot = seedStore([base]);
    const proposal = proposalAgainst(base);

    queueRecipeEdit({ ...fromStore(base.id)!, notes: 'Use the smoked one.' });
    await applyRecipeAmendment(proposal);

    const written = savedDocs()[1]!;
    expect(written.updatedAt > PROPOSE_AT).toBe(true);

    // Firestore echoes back exactly what was written. Under the old code this
    // carried the propose-time stamp, lost to the typist's newer
    // `latestLocalEdit`, and `applySnapshot` threw it away — so the amendment
    // was invisible on this device until a reload.
    onSnapshot([written]);

    expect(fromStore(base.id)?.description).toBe('A one-pan supper, with chilli.');
  });

  it('carries a metadata edit typed during the review, rather than reverting it', async () => {
    const base = seeded();
    seedStore([base]);
    const proposal = proposalAgainst(base);

    // Serves 4 → 6, typed into the editor while the review sheet was open. The
    // librarian returned no servings, so the merge carries the base's — and the
    // base must be the recipe as it is NOW, not as the AI call found it.
    queueRecipeEdit({ ...fromStore(base.id)!, metadata: { servings: 6, tags: ['midweek'] } });
    await applyRecipeAmendment(proposal);

    expect(savedDocs()[1]!.metadata.servings).toBe(6);
  });

  it('still writes the draft’s steps when it re-bases, never the store copy’s', async () => {
    // The claim the guided-plan decision rests on: re-basing changes only the
    // fields the merge CARRIES, so `amendment.updated.steps` and the steps
    // actually written cannot come apart. Break that and the plan is decided
    // against a document that was never saved.
    const base = seeded({ steps: [{ id: 's1', text: 'Chop.', timer: null, note: null }] });
    seedStore([base]);
    const proposal = proposalAgainst(base, {
      steps: [{ id: 's1', text: 'Chop finely.', timer: null, note: null }],
    });

    queueRecipeEdit({
      ...fromStore(base.id)!,
      steps: [{ id: 's1', text: 'Chop, typed by hand.', timer: null, note: null }],
    });
    await applyRecipeAmendment(proposal);

    expect(savedDocs()[1]!.steps.map((s) => s.text)).toEqual(['Chop finely.']);
    expect(savedDocs()[1]!.steps).toEqual(proposal.updated.steps);
  });

  it('applies the amendment even when the flushed edit’s own write failed', async () => {
    // The flush's `ReadResult` belongs to the editor that queued it — it holds
    // the promise and raises the toast. Blocking the amendment on it would lose
    // the amendment for a failure that costs it nothing: its own write carries
    // the same text, because the compose re-bases on the store.
    const base = seeded();
    seedStore([base]);
    const proposal = proposalAgainst(base);

    fs.saveRecipe.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    } as never);

    queueRecipeEdit({ ...fromStore(base.id)!, metadata: { servings: 6, tags: ['midweek'] } });
    const result = await applyRecipeAmendment(proposal);

    expect(result.kind).toBe('ok');
    expect(savedDocs()).toHaveLength(2);
    expect(savedDocs()[1]!.metadata.servings).toBe(6);
  });

  it('leaves the amendment unchanged when nothing is pending', async () => {
    // The overwhelmingly common case, and the one that must not have moved: no
    // in-place edit open, so the flush is a no-op and the store copy is the
    // recipe the proposal was built against.
    const base = seeded();
    seedStore([base]);
    const proposal = proposalAgainst(base);

    const result = await applyRecipeAmendment(proposal);

    expect(result.kind).toBe('ok');
    expect(savedDocs()).toHaveLength(1);
    expect(savedDocs()[0]!.description).toBe('A one-pan supper, with chilli.');
    expect(savedDocs()[0]!.metadata.servings).toBe(4);
  });
});
