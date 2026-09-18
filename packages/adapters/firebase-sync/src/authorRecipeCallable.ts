import type { DomainError, ReadResult } from '@salt/shared-types';
import type { AuthorRecipeInput } from '@salt/domain/schemas';
import type { RecipeDoc } from '@salt/domain/schemas';
import { callFunction } from './callFunction.js';

// Calls the librarian flow: sends a conversation and receives a canon-matched
// RecipeDoc. In CREATE mode (no `recipeId`) the flow has already WRITTEN that
// document to `recipes/{id}` before returning it — id, timestamps and attribution
// are all the server's, and the caller persists nothing (issue #1431). In edit
// mode it is a proposal and nothing has been written: the review gate decides.
//
// `traceparent` (issue #362) is forwarded on the payload; how and why is written
// once, at `withTraceparent` in callFunction.ts.
export async function callAuthorRecipe(
  input: AuthorRecipeInput,
  traceparent?: string,
): Promise<ReadResult<RecipeDoc, DomainError>> {
  return callFunction<AuthorRecipeInput, RecipeDoc>({
    name: 'authorRecipe',
    input,
    traceparent,
    // The function declares 120 s (`cloud-functions/src/index.ts:300`) against
    // the callable client's 70 s default, so a slow authoring run used to fail
    // in the browser while the flow was still writing (#928, B2-010).
    timeoutMs: 120_000,
  });
}
