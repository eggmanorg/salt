import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { AuthoredRecipeEnvelope, PersistenceOutcome, RecipeDoc } from '@salt/domain/schemas';
import { reportServerError } from '../observability/reportServerError.js';

// Write a freshly-authored recipe to `recipes/{id}` (issue #616), shared by all
// THREE authoring paths: the URL import, the photo import, and the chat librarian
// (`authorRecipe`, create mode only — issue #1431). A full `.set()` on a
// server-generated id: the doc cannot already exist, so there is nothing to merge
// with and no LWW hazard. That justification is also why the librarian's write is
// gated on create mode — an edit-mode amend names an id that DOES exist, and
// `authorRecipe` writes nothing at all on that path.
//
// It was `persistImportedRecipe` until #1431. Nothing import-specific was ever in
// here: `needs_approval` is `assembleRecipeDraft`'s option, passed by the two
// importers and not by the librarian, so a chat-authored recipe goes through this
// function WITHOUT being flagged for review and must not start to be. Only the
// name and this header were import-shaped, and a second copy of three lines is
// how one rule becomes two that disagree (#764).
//
// The client used to hold the only copy in memory until the user saved — from the
// editor for an import, from the statement after the `await` for a chat. So an
// import shared in from the Android share sheet (#589) was lost outright whenever
// Android killed the backgrounded PWA mid-extraction, and a chat-authored recipe
// was lost whenever the phone locked during the minute the librarian took (#1431),
// in both cases along with the AI call that produced it. Writing it here means the
// recipe exists the moment the flow finishes, whatever the client does next.
//
// A write failure does NOT fail the call. The callable still returns the recipe,
// the client stashes it and the page paints it, rather than throwing away a
// successful, already-paid-for generation. Logged and reported as `StorageError`
// here, once (issue #1431 review) — the client does not report it again — and
// returned as `'failed'` so a caller that asked (`reportPersistence`, issue
// #1601) can tell the cook the recipe is not saved yet.
//
// HOW IT RECOVERS, now that #1319 Phase 8 has deleted the editor and its Save
// that used to be the answer. The recovery survives, narrowed: `RecipeViewPage`'s
// `recipe` falls back to the stashed copy while the store has no such document
// (`importedFallback`), and every in-place edit composes off `recipe` and goes
// out through `persistRecipe`, which is a whole-document `setDoc`. So the FIRST
// edit the cook makes on the page writes the document that failed to write here.
// The fallback is keyed on the recipe id alone, so the chat leg inherits it
// unchanged — it stashes the same way (`stashImportedDraft`, called from
// `chatRecipeAuthor`) and lands on the same page.
//
// The boundary, because "it recovers" unqualified would be too strong. Three
// limits, all real:
//   * it takes an EDIT. A cook who reads the recipe, changes nothing and
//     navigates away loses it. Since #1601 a door that lands on the page warns
//     that the recipe is not saved yet and that any change keeps it; a tab on an
//     older bundle does not ask for the outcome and still shows nothing.
//   * the stash is module state, single-use and id-keyed, so it does not survive
//     a reload and cannot bleed into another recipe's page.
//   * two doors never land on the page, so the stash is never claimed and the
//     recipe is lost: `ChatSessionPage`'s `returnToMeal` (it navigates to the
//     MEAL) and the share target's navigation fallback. Both say the recipe
//     could not be saved (#1601).
// Pinned by "rescues an import whose server-side write failed" in
// `apps/web-pwa/tests/RecipeViewPage.reviewFlag.test.ts` — one path, exercising
// the id-keyed fallback all three share.
//
// `flowName` prefixes the log line so the failure is attributed to the authoring
// path that hit it.
export async function persistAuthoredRecipe(
  recipe: RecipeDoc,
  flowName: string,
): Promise<Extract<PersistenceOutcome, 'written' | 'failed'>> {
  try {
    await getFirestore().collection('recipes').doc(recipe.id).set(recipe);
    return 'written';
  } catch (err) {
    logger.error(`${flowName}: failed to persist authored recipe`, {
      recipeId: recipe.id,
      error: err instanceof Error ? err.message : String(err),
    });
    reportServerError(err, 'StorageError');
    return 'failed';
  }
}

// The authoring callables' answer, shaped by the caller's `reportPersistence`
// (issue #1601): the envelope when it asked, the bare recipe otherwise — which is
// what every tab on an older bundle reads.
export function authoredAnswer(
  recipe: RecipeDoc,
  persistence: PersistenceOutcome,
  reportPersistence: true | undefined,
): RecipeDoc | AuthoredRecipeEnvelope {
  return reportPersistence ? { recipe, persistence } : recipe;
}
