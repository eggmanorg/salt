import type { DomainError, ReadResult } from '@salt/shared-types';
import type { AuthorRecipeInput, AuthoredRecipeEnvelope, RecipeDoc } from '@salt/domain/schemas';
import { readAuthoredAnswer, type AuthoredRecipe } from './authoredRecipeAnswer.js';
import { callFunction } from './callFunction.js';

// Calls the librarian flow: sends a conversation and receives a canon-matched
// RecipeDoc. In CREATE mode (no `recipeId`) the flow has already tried to WRITE
// that document to `recipes/{id}` before returning it — id, timestamps and
// attribution are all the server's, and the caller persists nothing (issue
// #1431) — and `persistence` says whether the write landed (issue #1601). In edit
// mode it is a proposal, nothing has been written (`'skipped'`), and the review
// gate decides.
//
// `traceparent` (issue #362) is forwarded on the payload; how and why is written
// once, at `withTraceparent` in callFunction.ts.
export async function callAuthorRecipe(
  input: Omit<AuthorRecipeInput, 'reportPersistence'>,
  traceparent?: string,
): Promise<ReadResult<AuthoredRecipe, DomainError>> {
  return callFunction<AuthorRecipeInput, RecipeDoc | AuthoredRecipeEnvelope, AuthoredRecipe>({
    name: 'authorRecipe',
    input: { ...input, reportPersistence: true },
    traceparent,
    // The function declares 120 s (`cloud-functions/src/index.ts:300`) against
    // the callable client's 70 s default, so a slow authoring run used to fail
    // in the browser while the flow was still writing (#928, B2-010).
    timeoutMs: 120_000,
    project: readAuthoredAnswer,
  });
}
