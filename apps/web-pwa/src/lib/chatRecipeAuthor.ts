import type { AuthorRecipeInput } from '@salt/domain/schemas';
import { trackUsageEvent } from '@salt/observability';
import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import {
  authorRecipeTraced,
  currentMemberName,
  stashImportedDraft,
  type AuthoredRecipe,
} from './recipeService.js';

// Authoring a NEW recipe out of a conversation — the create leg (issues #696,
// #763, #798).
//
// This is the ONE implementation, for the same reason `recipeAmend.ts` is the one
// implementation of the review gate (#791): the propose/apply pair was written
// twice, drifted, and had to be pulled back together. There are now three doors
// onto this leg — the full `/chat/:id` page's "Save as recipe", and "Save as new
// recipe" in the recipe page's docked chat column and its drawer — so the saved
// document must not depend on which one you came through.
//
// The division of labour moved in #1431, and this module ended up on the thin
// side of it: it decides what is ASKED FOR — always the create path, grounded on
// the base the caller names, attributed to whoever is signed in — and the
// `authorRecipe` flow decides what the document is and WRITES it. **Nothing here
// goes to Firestore.** It used to: the write was the statement after the `await`,
// which is exactly the statement a locked phone, a backgrounded PWA or a closed
// tab never runs, so a minute of librarian, parse and canon work was thrown away
// with no error and nothing on screen.
//
// A page still owns its own busy state, its toasts, where it navigates afterwards,
// and whether the conversation goes on to claim the recipe it produced.
// **Claiming is deliberately not in here.** A general chat claims (the
// conversation now belongs to the dish it invented); a chat attached to a recipe
// does not (it belongs to the dish it is attached to and stays listed there, and
// the new recipe has no origin chat).
//
// There is no failure `stage`. The flow's write is best-effort and deliberately
// does not fail the call (see `persistAuthoredRecipe`); whether it landed comes
// back as the answer's `persistence` (issue #1601), handed on for the page to put
// into words. It is not reported here — the flow already reported it.

export interface AuthorRecipeFromChatInput {
  /** The transcript. The base recipe of an attached chat is NOT in here — it is
   *  injected server-side by `chefChat` — which is what makes create mode's
   *  "extract only what is present in the conversation" a safe instruction. */
  messages: AuthorRecipeInput['messages'];
  /** The vocabulary already in use, so the librarian reuses tags rather than inventing near-misses. */
  existingTags: string[];
  /**
   * Variation mode (#763): the dish this conversation started from, grounding the
   * prose so the new recipe carries forward what was never discussed. A parameter
   * rather than something inferred here, because it is a decision about the
   * relationship and only the caller knows it — "Save as new recipe" on an
   * attached chat passes `null` on purpose: an accompaniment is not derived from
   * the dish it accompanies, and variation mode would drag that dish's
   * ingredients into it.
   */
  basedOnRecipeId?: string | null;
}

/**
 * Author a brand-new recipe from a conversation. The flow saves it.
 *
 * Always the CREATE path — no `recipeId` is ever sent, so the flow assembles with
 * no base recipe and the result is an independent dish with its own title, its
 * own hero (`image: null`, so the trigger generates one from the new content),
 * `source: manual` and no `producesCanonId`. Nothing existing is written to. That
 * is also what arms the flow's own write: `recipeId` is the gate it gets right or
 * wrong, and this leg never sends one.
 *
 * `createdAt`/`updatedAt` are the ASSEMBLER's (issue #1431). It stamps both to one
 * instant as it mints the document and that exact document is what is written, so
 * a second stamp here would hand the caller a copy disagreeing with Firestore. The
 * librarian still has no clock; it is simply no longer this module's to supply.
 */
export async function authorRecipeFromChat(
  input: AuthorRecipeFromChatInput,
): Promise<ReadResult<AuthoredRecipe, DomainError>> {
  // No title hint: the dish being authored has no name yet, and the only title in
  // reach on the recipe page is the WRONG dish's. The span stays 'Author recipe'.
  const result = await authorRecipeTraced({
    messages: input.messages,
    existingTags: input.existingTags,
    basedOnRecipeId: input.basedOnRecipeId ?? null,
    // Attribution rides with the call now, for the same reason the clock does not
    // (issue #845, moved by #1431): the librarian knows no more about who you are
    // than it does about what time it is, and the browser is no longer around
    // when the document is written. A chat-authored recipe is yours — you had the
    // conversation — so it is `createdBy` you, exactly as if you had typed it in.
    //
    // `undefined` when the roster has not loaded or the signed-in email is not on
    // it, and the flow then leaves both fields blank rather than inventing a name.
    // Same degradation as the browser's own stamp, which is the same function.
    authorName: currentMemberName() || undefined,
  });
  if (result.kind !== 'ok') return failure(result.error);

  const saved = result.value.recipe;

  // The write happened on the SERVER, so the local Firestore cache has no echo to
  // hand back synchronously and the page can arrive before the listener does. The
  // stash is what stops it painting "Recipe not found." — id-keyed, single-use,
  // and a fallback that the store beats the moment it has the document. The exact
  // arrangement the two imports have used since #616, reused rather than copied;
  // its recovery properties and their limits are written out once, at
  // `persistAuthoredRecipe`.
  stashImportedDraft(saved);

  // Fired here, once, so a fourth door cannot arrive without its telemetry.
  // `recipe_method: 'chat'` is what this is on every surface — the taxonomy is a
  // deliberately small closed set and does not grow a value per button.
  //
  // It follows the AUTHORING rather than a save, because there is no longer a save
  // on this side. It stays a browser usage event (issue #1431): a suspend now
  // loses the event and keeps the recipe, which is the right way round.
  trackUsageEvent('recipe.created', {
    recipe_id: saved.id,
    recipe_kind: saved.kind,
    recipe_method: 'chat',
  });

  return success(result.value);
}
