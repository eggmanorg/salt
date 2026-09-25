import type { AuthoredRecipeEnvelope, PersistenceOutcome, RecipeDoc } from '@salt/domain/schemas';

// What an authoring callable hands back once this adapter has read it (issue
// #1601). The three wrappers always send `reportPersistence: true`, so the
// function answers `{ recipe, persistence }` — except a function deployed before
// the flag existed, which ignores it and answers the bare recipe. That arm is
// still a working recipe, so it is read, not rejected: `persistence: null` means
// the function did not say whether its write landed, and a caller treats it as it
// treated every answer before #1601.
export interface AuthoredRecipe {
  readonly recipe: RecipeDoc;
  readonly persistence: PersistenceOutcome | null;
}

// A RecipeDoc has no `recipe` or `persistence` field, so either key settles the
// arm.
export function readAuthoredAnswer(data: RecipeDoc | AuthoredRecipeEnvelope): AuthoredRecipe {
  return 'persistence' in data ? data : { recipe: data, persistence: null };
}
