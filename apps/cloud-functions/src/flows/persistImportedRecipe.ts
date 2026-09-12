import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { RecipeDoc } from '@salt/domain/schemas';

// Write a freshly-imported recipe to `recipes/{id}` (issue #616), shared by every
// import path (URL, photo). A full `.set()` on a server-generated id: the doc
// cannot already exist, so there is nothing to merge with and no LWW hazard.
//
// The client used to hold the only copy in memory until the user saved from the
// editor — so an import shared in from the Android share sheet (#589) was lost
// outright whenever Android killed the backgrounded PWA mid-extraction, along
// with the AI call that produced it. Writing it here means the recipe exists the
// moment the extraction finishes, whatever the client does next.
//
// A write failure does NOT fail the import. The callable still returns the
// recipe, the client stashes it and the page paints it, rather than throwing
// away a successful, already-paid-for extraction. Logged so the failure is
// visible; not reported as an unexpected error, since the user still gets a
// working import.
//
// HOW IT RECOVERS, now that #1319 Phase 8 has deleted the editor and its Save
// that used to be the answer. The recovery survives, narrowed: `RecipeViewPage`'s
// `recipe` falls back to the stashed copy while the store has no such document
// (`importedFallback`), and every in-place edit composes off `recipe` and goes
// out through `persistRecipe`, which is a whole-document `setDoc`. So the FIRST
// edit the cook makes on the page writes the document that failed to write here.
//
// The boundary, because "it recovers" unqualified would be too strong: it takes
// an edit. A cook who reads the recipe, changes nothing and navigates away loses
// it, and nothing on screen says so. Narrower than the pre-#616 fallback, where
// the recipe sat in an editor wearing a Save button — though that one equally
// lost it if they walked away without pressing it. Pinned by "rescues an import
// whose server-side write failed" in `apps/web-pwa/tests/RecipeViewPage.reviewFlag.test.ts`.
//
// `flowName` prefixes the log line so the failure is attributed to the import
// path that hit it.
export async function persistImportedRecipe(recipe: RecipeDoc, flowName: string): Promise<void> {
  try {
    await getFirestore().collection('recipes').doc(recipe.id).set(recipe);
  } catch (err) {
    logger.error(`${flowName}: failed to persist imported recipe`, {
      recipeId: recipe.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
