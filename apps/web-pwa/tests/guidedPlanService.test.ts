import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { GuidedPlanDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import { emptyRecipe } from '@salt/domain';
import type { DomainError } from '@salt/shared-types';

// ─── Shared report() spy ────────────────────────────────────────────────────────
// The service caches getErrorReporter() in module scope, so the adapter mock must
// hand back a STABLE report(). It delegates to the REAL category gate so the
// report/suppress boundary under test is the actual one.
const { reportSpy } = vi.hoisted(() => ({ reportSpy: vi.fn() }));

vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    isReportableCategory: actual.isReportableCategory,
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        reportSpy(error, category);
      },
    })),
  };
});

vi.mock('@salt/firebase-sync', () => ({
  subscribeGuidedPlan: vi.fn(() => vi.fn()),
  saveGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callGenerateGuidedPlan: vi.fn(),
  isAuthTransitioning: vi.fn(() => false),
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  guidedPlan,
  getGuidedPlanSnapshot,
  initGuidedPlanSync,
  generateGuidedPlan,
  saveGuidedPlan,
  discardGuidedPlan,
} from '../src/lib/guidedPlanService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const RECIPE_ID = 'recipe-1';
// Old enough that any real wall-clock stamp the service writes is newer.
const OLD = '2020-01-01T00:00:00.000Z';

function makeRecipe(updatedAt: string): Recipe {
  return { ...emptyRecipe(RECIPE_ID, OLD), title: 'Ragù', updatedAt };
}

function makePlan(overrides: Partial<GuidedPlanDoc> = {}): GuidedPlanDoc {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtSave: OLD,
    prep: [],
    stepNotes: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

// Drive the subscription callbacks the adapter would have called.
function emit(plan: GuidedPlanDoc | null): void {
  const onPlan = fs.subscribeGuidedPlan.mock.calls[0]?.[1];
  onPlan?.(plan);
}
function emitError(err: DomainError, raw?: unknown): void {
  const onError = fs.subscribeGuidedPlan.mock.calls[0]?.[2];
  onError?.(err, raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveGuidedPlan.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.deleteGuidedPlan.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('initGuidedPlanSync — the three-state store', () => {
  it('starts NOT-LOADED (undefined), not empty (null)', () => {
    // Load-bearing: the editor's whole empty state is a "Write the plan" prompt,
    // and without a distinct not-loaded state it flashes over every plan that
    // exists, one frame before the plan arrives.
    initGuidedPlanSync(RECIPE_ID);
    expect(get(guidedPlan)).toBeUndefined();
  });

  it('resolves to null when no plan has been written', () => {
    initGuidedPlanSync(RECIPE_ID);
    emit(null);
    expect(get(guidedPlan)).toBeNull();
  });

  it('resolves to the plan and exposes it synchronously', () => {
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan();
    emit(plan);
    expect(get(guidedPlan)).toEqual(plan);
    expect(getGuidedPlanSnapshot()).toEqual(plan);
  });

  it('resets to not-loaded when re-subscribed, so another recipe never shows this plan', () => {
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());
    initGuidedPlanSync('recipe-2');
    expect(get(guidedPlan)).toBeUndefined();
  });

  it('leaves the store alone on a corrupt/failed read, and reports it', () => {
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan();
    emit(plan);
    emitError({ kind: 'StorageError', reason: 'corruption' });
    expect(get(guidedPlan)).toEqual(plan);
    expect(reportSpy).toHaveBeenCalled();
  });

  it('ignores a stale snapshot echo older than the local edit', async () => {
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());
    await saveGuidedPlan(makePlan({ prep: [] }), makeRecipe('2026-08-02T00:00:00.000Z'));
    const saved = get(guidedPlan) as GuidedPlanDoc;
    emit(makePlan({ updatedAt: OLD }));
    expect(get(guidedPlan)).toEqual(saved);
  });
});

// The CLIENT half of issue #1416's fix. The flow assembles and persists the
// document and hands back what it wrote, so every control-field assertion that
// used to live here now lives where the fields are set — `needs_approval`, the
// minted prep ids, `recipeUpdatedAtAtSave` and the `createdAt` carry-across are
// all pinned in `apps/cloud-functions/tests/flows/generateGuidedPlan.test.ts`.
// What is left to prove here is that the browser is no longer load-bearing.
describe('generateGuidedPlan', () => {
  // The plan as the flow wrote it: ids minted, flag set, stamps done.
  const WRITTEN: GuidedPlanDoc = makePlan({
    needs_approval: true,
    recipeUpdatedAtAtSave: '2026-08-02T00:00:00.000Z',
    prep: [{ id: 'prep-1', text: 'Dice the onion', container: 'small bowl', ingredientIds: [] }],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:01.000Z',
  });

  it('WRITES NOTHING — the flow has already persisted the plan', async () => {
    // The regression. Everything the client used to do after the `await` was lost
    // with a page that did not survive the one-to-three-minute call, which on a
    // phone is the ordinary case rather than a race.
    fs.callGenerateGuidedPlan.mockResolvedValue({ kind: 'ok', value: WRITTEN });
    initGuidedPlanSync(RECIPE_ID);
    emit(null);

    const result = await generateGuidedPlan(makeRecipe('2026-08-02T00:00:00.000Z'));

    expect(result.kind).toBe('ok');
    expect(fs.saveGuidedPlan).not.toHaveBeenCalled();
  });

  it('shows the plan the flow returned, unchanged', async () => {
    // Taken from the response rather than waited for on the subscription: the
    // editor's empty state is a "Write the plan" button, and painting it at the end
    // of a three-minute wait, over a plan that exists, is not a frame anyone sees.
    fs.callGenerateGuidedPlan.mockResolvedValue({ kind: 'ok', value: WRITTEN });
    initGuidedPlanSync(RECIPE_ID);
    emit(null);

    const result = await generateGuidedPlan(makeRecipe('2026-08-02T00:00:00.000Z'));

    expect(result).toEqual({ kind: 'ok', value: WRITTEN });
    expect(get(guidedPlan)).toEqual(WRITTEN);
    // Stamped by the flow against the recipe IT read, and passed through here
    // rather than re-decided; the flow's own test is what pins the value.
    expect((get(guidedPlan) as GuidedPlanDoc).needs_approval).toBe(true);
  });

  it('does not let a late absence blank the plan the flow just wrote', async () => {
    // A generation is not a local write, so it never reaches the local cache and an
    // absence queued before the server's write is superseded by nothing. It simply
    // lands after the callable returned — and would put a "Write the plan" button
    // over a plan that is in Firestore.
    fs.callGenerateGuidedPlan.mockResolvedValue({ kind: 'ok', value: WRITTEN });
    initGuidedPlanSync(RECIPE_ID);
    emit(null);
    await generateGuidedPlan(makeRecipe('2026-08-02T00:00:00.000Z'));

    emit(null);

    expect(get(guidedPlan)).toEqual(WRITTEN);
  });

  it('accepts the plan again once the listener catches up, then trusts absence', async () => {
    // The guard is not permanent: it lifts the moment the subscription has shown us
    // the document, so a genuine later deletion still empties the editor.
    fs.callGenerateGuidedPlan.mockResolvedValue({ kind: 'ok', value: WRITTEN });
    initGuidedPlanSync(RECIPE_ID);
    emit(null);
    await generateGuidedPlan(makeRecipe('2026-08-02T00:00:00.000Z'));

    emit(WRITTEN);
    emit(null);

    expect(get(guidedPlan)).toBeNull();
  });

  it('writes nothing when the callable fails, and reports it', async () => {
    fs.callGenerateGuidedPlan.mockResolvedValue({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' },
    });
    initGuidedPlanSync(RECIPE_ID);
    emit(null);

    const result = await generateGuidedPlan(makeRecipe('2026-08-02T00:00:00.000Z'));

    expect(result.kind).toBe('err');
    expect(fs.saveGuidedPlan).not.toHaveBeenCalled();
    expect(get(guidedPlan)).toBeNull();
    expect(reportSpy).toHaveBeenCalled();
  });
});

describe('saveGuidedPlan — the save IS the review', () => {
  it('DROPS needs_approval entirely rather than writing false', async () => {
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan({ needs_approval: true });
    emit(plan);

    await saveGuidedPlan(plan, makeRecipe(OLD));

    const written = fs.saveGuidedPlan.mock.calls[0]![0];
    expect('needs_approval' in written).toBe(false);
  });

  it('re-stamps recipeUpdatedAtAtSave, so hand-reconciling clears the stale banner', async () => {
    // Without this the only way out of "the recipe has changed" would be a re-run,
    // which destroys every hand-corrected line.
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan({ recipeUpdatedAtAtSave: OLD });
    emit(plan);

    await saveGuidedPlan(plan, makeRecipe('2026-08-05T00:00:00.000Z'));

    expect(fs.saveGuidedPlan.mock.calls[0]![0].recipeUpdatedAtAtSave).toBe(
      '2026-08-05T00:00:00.000Z',
    );
  });

  it('stamps updatedAt and updates the store optimistically', async () => {
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan();
    emit(plan);

    await saveGuidedPlan(plan, makeRecipe(OLD));

    const written = fs.saveGuidedPlan.mock.calls[0]![0];
    expect(written.updatedAt > OLD).toBe(true);
    expect(get(guidedPlan)).toEqual(written);
  });

  it('keeps the optimistic copy when the write fails, and reports it', async () => {
    // A transient error must not cost the user their edits.
    fs.saveGuidedPlan.mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());

    const edited = makePlan({
      prep: [{ id: 'p1', text: 'Dice the onion', container: null, ingredientIds: [] }],
    });
    const result = await saveGuidedPlan(edited, makeRecipe(OLD));

    expect(result.kind).toBe('err');
    expect((get(guidedPlan) as GuidedPlanDoc).prep).toHaveLength(1);
    expect(reportSpy).toHaveBeenCalled();
  });

  it('does not let an absence blank the plan while a write is in flight', async () => {
    // An absence queued before the write reached the local cache would otherwise
    // present the editor's "Write the plan" button over work that exists.
    let resolveWrite: (v: { kind: 'ok'; value: undefined }) => void = () => {};
    fs.saveGuidedPlan.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());

    const pending = saveGuidedPlan(makePlan(), makeRecipe(OLD));
    emit(null);
    expect(get(guidedPlan)).not.toBeNull();

    resolveWrite({ kind: 'ok', value: undefined });
    await pending;
  });
});

// Discard (issue #784). Called when an applied Refresh re-mints the recipe's step
// ids and the plan's `stepNotes` stop resolving — a surviving plan would be
// silently WRONG rather than merely stale, and the stale-recipe banner cannot
// help with references that no longer exist.
describe('discardGuidedPlan', () => {
  it('deletes the document and leaves the store loaded-and-empty', async () => {
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());

    const result = await discardGuidedPlan(RECIPE_ID);

    expect(result.kind).toBe('ok');
    expect(fs.deleteGuidedPlan).toHaveBeenCalledWith(RECIPE_ID);
    // `null`, not `undefined`: the page must render the "Write the plan" empty
    // state rather than sit on a loading state waiting for a doc that is gone.
    expect(get(guidedPlan)).toBeNull();
  });

  it('clears the stale-echo guard, so the next plan written is not rejected as old', async () => {
    // The reason the discard touches `latestLocalEdit` at all. The guard holds the
    // newest `updatedAt` we applied locally; leaving a deleted plan's stamp behind
    // would make the FRESH plan the next visit writes — legitimately older than
    // that stamp if it lands out of order — look like a stale echo and be dropped,
    // putting the editor back on an empty state it can never leave.
    initGuidedPlanSync(RECIPE_ID);
    emit(makePlan());
    await saveGuidedPlan(makePlan(), makeRecipe('2026-08-02T00:00:00.000Z'));

    await discardGuidedPlan(RECIPE_ID);
    const replacement = makePlan({ updatedAt: OLD });
    emit(replacement);

    expect(get(guidedPlan)).toEqual(replacement);
  });

  it('keeps the plan on screen when the delete fails, and reports it', async () => {
    // Rule 10 all the way through: the failure crosses as a Failure, and the user
    // is left in the situation they were already in (a stale plan) rather than
    // looking at an empty editor for a document that still exists.
    fs.deleteGuidedPlan.mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    });
    initGuidedPlanSync(RECIPE_ID);
    const plan = makePlan();
    emit(plan);

    const result = await discardGuidedPlan(RECIPE_ID);

    expect(result.kind).toBe('err');
    expect(get(guidedPlan)).toEqual(plan);
    expect(reportSpy).toHaveBeenCalled();
  });
});
