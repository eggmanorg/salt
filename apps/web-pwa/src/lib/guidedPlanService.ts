import {
  subscribeGuidedPlan,
  loadAllGuidedPlans as loadAllGuidedPlansDoc,
  saveGuidedPlan as saveGuidedPlanDoc,
  deleteGuidedPlan as deleteGuidedPlanDoc,
  callGenerateGuidedPlan,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import type { GuidedPlanDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { success, type DomainError, type ReadResult } from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';

// Guided-plan service (issue #751, Phase 1). An optimistic store over the
// firebase-sync single-doc subscription, and the CLIENT-SIDE write path for the
// document.
//
// TWO WRITERS, DELIBERATELY, and the split is by who is waiting (issue #1416):
//
//  - a GENERATION is written by the `generateGuidedPlan` flow, server-side. It
//    mints the prep-entry ids, sets `needs_approval`, stamps
//    `recipeUpdatedAtAtSave` from the recipe it read, and carries `createdAt`
//    across. Nothing on this path writes; `generateGuidedPlan` below only puts
//    what the flow wrote into the store. The call runs for one to three minutes,
//    so the browser cannot be relied on to be there when it returns — a locked
//    phone lost the plan outright while the browser owned the write.
//  - a HUMAN SAVE is written here, through `persist`, and so are the edits and the
//    discard. The person is on the page by definition, the write is instant, and
//    the optimistic store is what makes the editor feel immediate.
//
// The document is whole-document LWW, so two writers is no more hazardous than one
// — but the CONTROL FIELDS have to agree. `needs_approval` is set by the flow and
// dropped by `saveGuidedPlan`; `recipeUpdatedAtAtSave` is stamped by both, each
// against the recipe it actually read. Each of those is pinned by a test
// (`apps/cloud-functions/tests/flows/generateGuidedPlan.test.ts`,
// `apps/web-pwa/tests/guidedPlanService.test.ts`).
//
// What holds the pair EXCLUSIVE is structural rather than tested, so it is worth
// naming: `persist` below has exactly one caller, `saveGuidedPlan`, which strips
// the flag before it writes — so there is no client path that can set it. A second
// caller of `persist` is what would quietly break that, and it is the thing to
// look at before adding one.
//
// The plan editor owns the subscription lifecycle: it calls initGuidedPlanSync
// with the recipe id and disposes the returned unsub on teardown.

// ─── Reactive store ─────────────────────────────────────────────────────────────

// THREE STATES, the same split shoppingDayService's `upcomingShopDay` documents:
// `undefined` = not loaded yet, `null` = loaded and there is no plan, a doc = the
// plan. Load-bearing here: the editor's whole empty state is a "Write the plan"
// prompt, and without a distinct not-loaded state that prompt flashes on every
// visit to a recipe that HAS a plan, one frame before the plan arrives.
const _plan = writable<GuidedPlanDoc | null | undefined>(undefined);
export const guidedPlan: Readable<GuidedPlanDoc | null | undefined> = _plan;

/** Synchronous snapshot, for handlers that must read the freshest plan. */
export function getGuidedPlanSnapshot(): GuidedPlanDoc | null | undefined {
  return get(_plan);
}

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Snapshot guard ─────────────────────────────────────────────────────────────
// Newest `updatedAt` we have applied locally for the current plan (from an
// optimistic write or an accepted snapshot). Guards against an in-flight stale
// snapshot echo landing after a newer local edit and reverting it.
let latestLocalEdit: { id: string; updatedAt: string } | null = null;

// Count of our own writes Firestore has not yet acknowledged. An ABSENCE cannot be
// trusted while one is outstanding: it may have been queued before the write
// reached the local cache, and applying it would blank a plan that exists — which
// in this editor means replacing the user's work with a "Write the plan" button.
// The write supersedes the absence either way (on success Firestore re-emits the
// document; on failure the optimistic copy is deliberately kept so a transient
// error never costs the user their edits), so a swallowed absence is dropped
// rather than replayed.
let pendingWrites = 0;

// The id of a plan the FLOW wrote and this listener has not yet shown us (issue
// #1416). The same hazard as `pendingWrites` and a different mechanism: a
// generation is not a local write, so it never reaches the local cache and an
// absence queued before the server's write is not superseded by anything — it
// simply arrives on the listener after the callable has already returned the
// document, and blanks a plan that demonstrably exists.
//
// Cleared when the listener catches up: the moment a snapshot for that id is
// accepted, whatever wrote it. A write that failed server-side therefore leaves it
// set for the rest of the session, which is the intended posture — the store holds
// the plan the flow handed back, the editor paints it, and the cook's Save writes
// it (the same recovery `persistAuthoredRecipe` documents, and the same boundary:
// it takes a Save).
let awaitingServerWrite: string | null = null;

function applySnapshot(incoming: GuidedPlanDoc | null): void {
  if (incoming === null) {
    // Keep the copy we hold; see both comments above.
    if (pendingWrites > 0 || awaitingServerWrite !== null) return;
    _plan.set(null);
    return;
  }
  const local = latestLocalEdit;
  if (local && local.id === incoming.id && incoming.updatedAt < local.updatedAt) {
    // Stale echo: our local copy is newer — ignore it.
    return;
  }
  if (awaitingServerWrite === incoming.id) awaitingServerWrite = null;
  latestLocalEdit = { id: incoming.id, updatedAt: incoming.updatedAt };
  _plan.set(incoming);
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

/**
 * Subscribe to one recipe's guided plan. Resets the store to the not-loaded state
 * first so moving between recipes never shows the previous recipe's plan.
 */
export function initGuidedPlanSync(recipeId: string): () => void {
  _plan.set(undefined);
  latestLocalEdit = null;
  awaitingServerWrite = null;
  const errors = getErrorReporter();
  return subscribeGuidedPlan(
    recipeId,
    (incoming) => applySnapshot(incoming),
    (err, rawError) => {
      // Includes the corruption case the adapter reports rather than swallowing.
      // The store is left exactly as it was: on a first load that means the editor
      // stays on its loading state rather than offering to overwrite a document it
      // could not read.
      reportSubscriptionError(errors, err, rawError);
    },
  );
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// Stamp `updatedAt`, update the store optimistically, then persist the whole doc.
// Private: every public command below goes through here, which is what keeps the
// optimistic guard and the timestamp in one place.
async function persist(plan: GuidedPlanDoc): Promise<ReadResult<GuidedPlanDoc, DomainError>> {
  const stamped: GuidedPlanDoc = { ...plan, updatedAt: new Date().toISOString() };
  latestLocalEdit = { id: stamped.id, updatedAt: stamped.updatedAt };
  _plan.set(stamped);
  pendingWrites += 1;
  try {
    const result = reportIfFailed(getErrorReporter(), await saveGuidedPlanDoc(stamped));
    if (result.kind !== 'ok') return result;
    return success(stamped);
  } finally {
    pendingWrites -= 1;
  }
}

/**
 * Ask the flow to write (or re-write) the plan for a recipe.
 *
 * WRITES NOTHING ITSELF (issue #1416). The flow assembles and persists the
 * document and returns exactly what it wrote; this is the client putting that on
 * screen. A re-run REPLACES the previous plan outright — whole-document LWW, no
 * merge — and every control field on it, `needs_approval` and `createdAt`
 * included, is decided server-side.
 *
 * Why the returned document is used rather than waiting for the subscription to
 * deliver it: the person has just waited one to three minutes, and the editor's
 * empty state is a "Write the plan" button. Painting that button for however long
 * the snapshot takes to arrive — at the end of that wait, over a plan that exists —
 * is not a frame anyone should see. It is not a second source of truth either: the
 * flow wrote first, so this IS the document.
 */
export async function generateGuidedPlan(
  recipe: Recipe,
): Promise<ReadResult<GuidedPlanDoc, DomainError>> {
  const written = await callGenerateGuidedPlan({ recipeId: recipe.id });
  if (written.kind !== 'ok') return reportIfFailed(getErrorReporter(), written);

  const plan = written.value;
  awaitingServerWrite = plan.id;
  latestLocalEdit = { id: plan.id, updatedAt: plan.updatedAt };
  _plan.set(plan);
  return success(plan);
}

/**
 * Save a human's edits. THE SAVE IS THE REVIEW, and it does two things beyond
 * writing the text:
 *
 *  1. Drops `needs_approval` — dropped, never written `false`; absent means
 *     reviewed (the same contract, and the same idiom, as the recipe page's
 *     "Mark reviewed").
 *  2. Re-stamps `recipeUpdatedAtAtSave` to the recipe as it stands NOW. A save is
 *     a review of the plan against the current recipe, so reconciling a plan by
 *     hand after the recipe changed clears the stale banner. Without this the only
 *     way out of that banner would be a re-run, which destroys every corrected line.
 */
export async function saveGuidedPlan(
  plan: GuidedPlanDoc,
  recipe: Recipe,
): Promise<ReadResult<GuidedPlanDoc, DomainError>> {
  const { needs_approval: _wasUnreviewed, ...reviewed } = plan;
  return persist({ ...reviewed, recipeUpdatedAtAtSave: recipe.updatedAt });
}

/**
 * Discard a recipe's plan entirely (issue #784).
 *
 * Called when an applied Refresh re-mints the recipe's step ids: the plan's
 * `stepNotes` point at `stepId`s that no longer exist, which makes a surviving
 * plan silently WRONG rather than merely stale — the stale-recipe banner cannot
 * help with references that no longer resolve. Deleting is cheap (a plan is one
 * flow call to rewrite, and guided plans are greenfield), and the next visit to
 * guided mode writes a fresh one against the refreshed method.
 *
 * Clears the local store optimistically so the page does not keep rendering a
 * plan whose steps are gone, and clears `latestLocalEdit` with it — otherwise
 * the guard would treat the delete's own absence snapshot as stale and put the
 * deleted plan straight back.
 */
export async function discardGuidedPlan(recipeId: string): Promise<ReadResult<void, DomainError>> {
  const result = await deleteGuidedPlanDoc(recipeId);
  if (result.kind !== 'ok') {
    reportIfFailed(getErrorReporter(), result, 'guidedPlanService.discardGuidedPlan');
    return result;
  }
  latestLocalEdit = null;
  awaitingServerWrite = null;
  _plan.set(null);
  return success(undefined);
}

/**
 * Every plan, once, for the kitchen-tool curation queue (issue #882, Phase 4).
 *
 * The odd one out in this file, and deliberately so: everything above it is the
 * ONE plan a page is standing on, held in `_plan` and kept live. This read touches
 * neither the store nor the subscription — it hands the caller a detached array
 * and forgets it. The admin queue wants a tally of the container words the plans
 * have already used, not a live view of any of them, and a whole-collection
 * listener behind a screen almost nobody opens would cost every session the sync.
 *
 * Read-only in the strongest sense the feature has: the queue exists so that
 * adding a tool lights up plans that already say the word, with nothing written
 * back to any of them.
 */
export async function loadAllGuidedPlansForCuration(): Promise<
  ReadResult<GuidedPlanDoc[], DomainError>
> {
  return reportIfFailed(
    getErrorReporter(),
    await loadAllGuidedPlansDoc(),
    'guidedPlanService.loadAllGuidedPlansForCuration',
  );
}
