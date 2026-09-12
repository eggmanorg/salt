import { diffRecipe, reconcileRecipePhases, type Recipe } from '@salt/domain';
import type { RecipeDiff } from '@salt/domain';
import type { AuthorRecipeInput, RecipeDoc } from '@salt/domain/schemas';
import { saveRecipe as saveRecipeDoc } from '@salt/firebase-sync';
import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import {
  applyRecipeOptimistically,
  authorRecipeTraced,
  flushRecipeWrites,
  getRecipeSnapshot,
} from './recipeService.js';
import { discardGuidedPlan } from './guidedPlanService.js';

// Amending a recipe by chat — propose, merge, diff, apply (issue #764).
//
// This is the ONE implementation of the review gate. It was two: the recipe
// page's sidebar/drawer and the full `/chat/:id` page each had their own copy,
// and they drifted — the older copy preserved metadata the librarian omitted,
// the newer one spread the draft straight through and so proposed to erase the
// user's servings, times and tags. Both surfaces now call in here, so the saved
// document cannot depend on which door you came through. A page owns its own
// busy/open state, its toasts and where it navigates afterwards; it owns nothing
// about what gets written.
//
// Refresh (⋮ → Refresh) is a third caller and needs nothing of its own here
// (issue #890): it sends the chef a canned turn asking for the dish to be
// written out again, and what comes back is an ordinary conversation. It reviews
// and applies through `proposeRecipeAmendment` like any other amendment, which
// is the point — a re-authored recipe and a hand-typed edit reach the document
// by exactly one path.

export interface RecipeAmendment {
  /** The merged recipe, ready to save. Nothing is written until `applyRecipeAmendment`. */
  updated: Recipe;
  /** What changed, for the review summary. Diffed POST-merge, so preserved fields show no row. */
  diff: RecipeDiff;
  /**
   * The recipe this was authored from. Carried on the proposal rather than
   * asked of the caller (issue #918) so that applying cannot be done without
   * the one fact that decides whether the guided plan survives the write — see
   * `applyRecipeAmendment`. A surface that holds a proposal necessarily holds
   * what it was proposed against, so nothing is asked of the page that it did
   * not already have.
   */
  existing: Recipe;
  /**
   * The librarian's raw answer, before `mergeAmendedRecipe` put it onto the
   * recipe. Carried so that `applyRecipeAmendment` can re-run that merge against
   * the recipe as it stands at WRITE time rather than as it stood when the AI
   * call started (issue #1330) — see there for what that does and does not save.
   *
   * Not a second source of truth: `updated` is still the document the review
   * sheet's diff was taken from, and re-merging the same draft cannot change the
   * fields the draft is authoritative on.
   */
  draft: RecipeDoc;
}

/**
 * Merge a librarian draft onto the recipe it was authored from.
 *
 * **A null metadata field means "the model forgot", not "the user wants this
 * cleared" — so the existing value is preserved.** The librarian is instructed
 * to return the complete recipe with only the discussed changes applied, and it
 * mostly does; when it drops `servings` or a time it was never asked about, that
 * is a lapse rather than an instruction. The asymmetry decides it: a wrongly
 * PRESERVED value shows no diff row and is harmless, because the value was
 * already correct — a wrongly CLEARED one forces the reviewer to discard the
 * whole proposal, good changes and all, and reads as though the chef decided to
 * delete their timings.
 *
 * The deliberate cost, which is intended behaviour and not a second bug:
 * **clearing a metadata field is an editor job.** You cannot empty servings, a
 * time, or the last remaining tag through chat. An empty tag list from the
 * librarian is read the same way as a null number — the model returned nothing,
 * so the recipe keeps what it had.
 *
 * Everything else in the draft is authoritative: title, description, notes,
 * ingredients and steps are what the conversation was about, and an empty one of
 * those is a real edit. `kind`, `producesCanonId` and `createdBy` need no
 * handling here — the CF already carries them across from the base recipe in
 * edit mode (`assembleRecipeDraft`), and `kind` is immutable anyway.
 * `lastEditedBy` is deliberately NOT stamped here either: this function is pure
 * and knows no user, and the amender is stamped at `applyRecipeAmendment` so the
 * name lands on the write rather than on a proposal that may be discarded.
 *
 * Pure: same inputs, same output, no clock and no I/O — `updatedAt` is supplied
 * by the caller so this stays directly testable.
 */
export function mergeAmendedRecipe(existing: Recipe, draft: RecipeDoc, updatedAt: string): Recipe {
  // The phase strip and the sentence written over it (issue #1122) are ONE fact,
  // so they are decided by the one shared pairing rule — the same call
  // `assembleRecipeDraft` and `onRecipeWritten`'s re-estimate branch make — and
  // never by two independent `?? existing` fallbacks like the scalars below
  // (issue #1203). Merged field by field they came apart exactly where it
  // mattered: `draft.metadata.phases` is always a defined array, so the fresh
  // strip always won, while a `timingSummary` the librarian was never asked about
  // came back `null` and silently restored the stored recipe's OLD sentence
  // underneath it — a one-block traybake described as taking 2¼ hours.
  //
  // `reconcileRecipePhases` keeps the no-loss floor the scalars have: a draft
  // carrying no strip at all falls back to the stored pair WHOLE. That IS the
  // boundary of the claim, and on today's amend path it does not clear it —
  // the librarian is always instructed to return 3–6 phases (`PHASE_RULES`,
  // `recipeFieldRules.ts`) and is never shown the stored strip to preserve
  // (`formatRecipeForPrompt`, `recipeText.ts`, not extended for #1122's two
  // fields), so `draft.metadata.phases` on an unrelated chat turn is a freshly
  // invented strip, not an absent one, and the "answered" branch takes it every
  // time. The floor is real for a caller whose draft omits phases; a chat
  // amend is not yet that caller, so a hand-corrected strip is NOT yet
  // protected from being overwritten by an unrelated turn. Closing that gap is
  // teaching the prompt to show the stored strip, which is out of scope here
  // (issue #1202 Phase 2 / #1203 Must-not-touch: the flows and prompts).
  const phaseStrip = reconcileRecipePhases(draft.metadata, existing.metadata);

  return {
    ...draft,
    // Identity stays the existing recipe's: this is an edit, not a new dish.
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt,
    // The librarian never returns either (always null / `{ type: 'manual' }`),
    // so carry them over or an amend would drop the hero image and provenance.
    image: existing.image,
    source: existing.source,
    metadata: {
      servings: draft.metadata.servings ?? existing.metadata.servings,
      // The phase strip and its summary (issue #1122), paired above rather than
      // merged here. This merge builds `metadata` field by field rather than
      // spreading, so a key omitted here is a key silently DELETED from the
      // document on every amend — which is what would have quietly thrown away a
      // strip a cook had corrected. Both keys are written on every amend, as `[]`
      // and `null` when neither side has a strip: that is what "no strip" is
      // stored as everywhere else, and Firestore has no `undefined` to write.
      phases: phaseStrip.phases,
      timingSummary: phaseStrip.timingSummary,
      tags: draft.metadata.tags.length > 0 ? draft.metadata.tags : existing.metadata.tags,
    },
  };
}

/**
 * Re-run the librarian over the conversation and return a PENDING proposal.
 * Writes nothing — the review gate's whole point is that the user sees the diff
 * first. The diff is taken after the merge, so preserved metadata doesn't
 * surface as a spurious "changed to null".
 */
export async function proposeRecipeAmendment(
  existing: Recipe,
  messages: AuthorRecipeInput['messages'],
  existingTags: string[],
): Promise<ReadResult<RecipeAmendment, DomainError>> {
  return propose(existing, { messages, existingTags, recipeId: existing.id });
}

/**
 * The shared half: call the librarian, merge its draft onto the recipe, diff
 * post-merge. Every propose in this module goes through here — which is the
 * whole reason #764 collapsed two copies into one.
 */
async function propose(
  existing: Recipe,
  input: AuthorRecipeInput,
): Promise<ReadResult<RecipeAmendment, DomainError>> {
  const result = await authorRecipeTraced(input, existing.title);
  if (result.kind !== 'ok') return result;

  const updated = mergeAmendedRecipe(existing, result.value, new Date().toISOString());
  return success({ existing, draft: result.value, updated, diff: diffRecipe(existing, updated) });
}

/**
 * Commit a proposal — the gate's confirm. It keeps the save on the same seam as
 * the propose, so the two surfaces cannot acquire different ideas about what
 * applying means the way they did about merging.
 *
 * It adds attribution (issue #845): confirming a proposal IS the human edit, so
 * the amender is stamped here — on the write, not on a proposal that may be
 * discarded. `createdBy` is untouched by that stamp when it already holds a
 * name, so amending someone else's recipe by chat credits you as the editor and
 * leaves them as the one who added it.
 *
 * And it decides the guided plan (issue #918). That check used to live in the
 * recipe page's apply handler and nowhere else, so the SAME amendment applied
 * from `/chat/:id` left the plan behind — one rule with two implementations,
 * only one of which knew the rule, which is the #764 shape exactly. It lives
 * here now because here is the one door both surfaces come through.
 *
 * Whether the plan survives is decided by what the amendment actually did to the
 * steps the plan annotates. It used to ask a different question — did the
 * proposal come from Refresh rather than from the chat (issue #784) — on the
 * belief that a chat amendment preserved the ids of steps it did not change. It
 * did not, so a chat amendment left the plan pointing at steps that no longer
 * existed, silently, and the stale-recipe banner cannot help with references
 * that do not resolve. Asking about the steps themselves covers every door and
 * cannot drift when a new one opens (issue #890).
 *
 * Asking about the IDS ALONE was enough only while every id was re-minted on
 * every amend: `assembleRecipeDraft` used to hand each step a fresh
 * `crypto.randomUUID()`, ingredients being the only things reused. Since issue
 * #1178 the librarian cites the step each rewrite came from and the assembler
 * honours it, so an id can now survive a step being rewritten from end to end —
 * and a plan whose notes still resolve, onto WORDS THEY WERE NOT WRITTEN
 * AGAINST, is worse than a plan that is gone, because nothing shows it. Hence
 * the second half of the condition below: text as well as identity.
 */
export async function applyRecipeAmendment(
  amendment: RecipeAmendment,
): Promise<ReadResult<void, DomainError>> {
  // Order the amendment against the in-place editor's coalesced writes, and take
  // the write path every other recipe write takes (issue #1330). This used to be
  // a bare `saveRecipeDoc` of a document frozen at PROPOSE time, which collided
  // with `queueRecipeEdit` two ways at once: a pending coalesced write fired
  // afterwards and replaced the amendment with its own older snapshot, and the
  // amendment's propose-time `updatedAt` lost to the typist's newer one at
  // `applySnapshot`'s echo guard — so whichever write lost, the device that
  // pressed Apply saw a success and no revert.
  //
  // This orders the amendment against a typing write in EITHER state, queued or
  // already on the wire (issue #1304 — it used to cover only the first). `flushKey`
  // (`writeCoalescer.ts`) deletes a key's pending entry BEFORE awaiting its
  // `setDoc`, so a keystroke whose own 400 ms timer had already fired was invisible
  // to this flush, which resolved immediately while that write was still
  // travelling; the amendment's `setDoc` below then went out alongside it and which
  // one Firestore kept rested on the SDK's per-document mutation ordering — a
  // property this function depended on but did not establish. `flushAll` now waits
  // for in-flight writes too, so the typing write is ACKED before the amendment is
  // composed and the ordering is this code's own rather than the SDK's.
  //
  // THE BOUNDARY (CLAUDE.md Rule 12): what is ordered is every recipe write
  // ISSUED BEFORE THIS LINE. A keystroke queued during the flush's own await, or
  // during the amendment's round trip below, is not — it is a genuinely later
  // edit, it flushes on its own timer, and LWW keeping it is the right answer.
  const flushed = await flushPendingRecipeEdits();
  if (flushed.kind !== 'ok') return flushed;

  // Re-merge the SAME draft onto the recipe as it stands now. The pending write
  // above has landed and the store holds every keystroke typed since the
  // librarian was called, so this is what lets the amendment carry them instead
  // of reverting them to the copy the AI call started from.
  //
  // WHAT THIS SAVES, exactly — it is not "your typing survives" (CLAUDE.md Rule
  // 12): re-basing only changes the fields `mergeAmendedRecipe` CARRIES from the
  // base — servings and tags the librarian omitted, `image`, `source`,
  // `createdAt`. The phase strip is NOT one of them on this path: the librarian
  // is always asked for a fresh 3–6 phase strip (`PHASE_RULES`) and
  // `reconcileRecipePhases`'s stored-pair fallback never fires for an amend (see
  // the boundary note on `mergeAmendedRecipe` above) — so a strip hand-corrected
  // in place during the review (#1319/#1332) is LOST, replaced by the fresh
  // strip, whether or not the base is re-run. The fields the draft is
  // authoritative on — title, description, notes, ingredients, steps — likewise
  // still replace whatever was typed into them, because replacing them is what
  // the reviewer approved. Re-basing therefore cannot change the diff the
  // reviewer was shown into something they did not agree to; it only declines to
  // undo whatever edit is already sitting in the store when this runs — which
  // may equally be another family member's device or a Cloud Function trigger's
  // write, not only one the user typed themselves.
  //
  // No merge or diff logic is added here to reconcile the two writes: this is
  // the one existing pure merge, re-run with a fresher base. A recipe the store
  // no longer holds (deleted on another device mid-review) falls back to the
  // proposal's own base, which is exactly what happened before.
  const base = getRecipeSnapshot(amendment.updated.id) ?? amendment.existing;
  const updated = mergeAmendedRecipe(base, amendment.draft, amendment.updated.updatedAt);

  // Both halves of the rule in one lookup: a step that is GONE has no entry, so
  // `get` returns undefined and never equals its old text; a step that survived
  // but was reworded returns the new wording, which does not equal it either.
  // Only a step still present AND still saying the same thing leaves the plan
  // standing.
  //
  // Unchanged by the re-base above, and deliberately still asked of
  // `amendment.updated`: `mergeAmendedRecipe` spreads the draft, so `steps` comes
  // from the draft whatever the base is, and the two documents cannot disagree
  // about them. Pinned rather than asserted — see the re-base test that writes a
  // store copy with different steps and checks the saved ones are still the
  // draft's.
  const survivingTextById = new Map(amendment.updated.steps.map((step) => [step.id, step.text]));
  const planStepsInvalidated = amendment.existing.steps.some(
    (step) => survivingTextById.get(step.id) !== step.text,
  );

  // `applyRecipeOptimistically` rather than a second stamping site: it is the one
  // place `updatedAt` and attribution are stamped and the only place
  // `latestLocalEdit` is registered, so the amendment lands on this screen
  // immediately AND its own echo is accepted instead of discarded as stale.
  //
  // THE WINDOW THIS LEAVES OPEN: a keystroke arriving during the round trip
  // below opens a fresh pending entry, stamped newer than this document, which
  // flushes afterwards and replaces it in the fields it holds. That is the same
  // window `persistRecipe`'s `cancel` guard deliberately leaves open, for the
  // same reason — nothing else has ever written those characters — and nothing
  // here narrows it. `cancel` is not called: with the flush above there is
  // nothing pending to cancel except an entry queued inside that window, which
  // must be left to flush.
  const saveResult = await saveRecipeDoc(applyRecipeOptimistically(updated));

  if (saveResult.kind !== 'ok') {
    // A failed write must not leave the store — or `latestLocalEdit` — holding a
    // document Firestore never has (issue #1330 review, finding 3). The user is
    // still in edit mode after the failure toast, and the next keystroke
    // composes from whatever the store holds; left as `updated`, that keystroke
    // would silently persist the whole amendment the toast just said did not
    // save. Re-applying `base` — the document exactly as it stood immediately
    // before the optimistic apply above — undoes only that apply: no second
    // write, and a fresh local timestamp so a genuine later echo of `base`
    // itself isn't rejected as stale by `applySnapshot`.
    applyRecipeOptimistically(base);
    return saveResult;
  }

  // Only after the save succeeds — throwing away the plan for a write that never
  // landed would be a plain loss. Best-effort: a failed delete leaves a stale
  // plan, which is the situation we were already in, so it must not turn a
  // successful save into an error the user has to interpret.
  if (planStepsInvalidated) {
    await discardGuidedPlan(amendment.updated.id);
  }

  return saveResult;
}

/**
 * Write out any pending in-place recipe edit before the amendment is composed.
 *
 * Rule 10: a coalesced write failure must not reach the caller as a THROW.
 * `flushRecipeWrites` resolves `void` — the write's own `ReadResult` goes to the
 * promise `queueRecipeEdit` handed the editor, which is what raises the typist's
 * toast — so a flush whose write merely returns `err` is invisible here and is
 * deliberately not allowed to block the amendment. That is not "the amendment's
 * own write carries the same text anyway" for every field: the compose above
 * re-bases on the store, but re-basing only carries the fields
 * `mergeAmendedRecipe` takes from the base (servings/tags the librarian
 * omitted, `image`, `source`, `createdAt` — see `applyRecipeAmendment`'s
 * comment). `notes`, `title`, `description`, `ingredients` and `steps` are the
 * draft's regardless of the base, so a flushed edit to one of THOSE fields is
 * genuinely replaced by the amendment — which is the reviewed behaviour, not a
 * gap this flush is covering. Only a flush that REJECTS crosses back, as a
 * `Failure`.
 *
 * It flushes every pending recipe edit, not only this recipe's. There is no
 * per-id seam on `recipeService` and no reason for one: any other pending recipe
 * write is one the next blur would have issued within the debounce window
 * regardless.
 */
async function flushPendingRecipeEdits(): Promise<ReadResult<void, DomainError>> {
  try {
    await flushRecipeWrites();
    return success(undefined);
  } catch {
    return failure({ kind: 'StorageError', reason: 'unavailable' });
  }
}
