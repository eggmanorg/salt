// Has the recipe been written since a batch was frozen? (issue #1327)
//
// A SIBLING of `./hasRecipeChanged.ts`, not a caller of it, because the comparison
// is a different one. `hasRecipeChanged` is an INEQUALITY between two stamps of the
// recipe's own `updatedAt` — it works because a cook session and a guided plan each
// store the stamp they snapshotted (`recipeUpdatedAtAtStart`,
// `recipeUpdatedAtAtSave`). A batch stores no such stamp and deliberately gains
// none: the field would be null on every run already in production, so the banner
// would never fire for them.
//
// What a batch has instead is `createdAt`, so the question is an ORDERING — "was
// the recipe written after this run started?" — and ISO-8601 UTC strings order
// lexically, which is what makes that a string comparison rather than two
// `Date.parse` calls. LIMIT, STATED (CLAUDE.md rule 12): that holds for the
// timestamps Salt writes, which are always `new Date().toISOString()`. It is not a
// general-purpose instant comparator, and an offset-bearing timestamp from
// somewhere else would order wrongly.
//
// Absent inputs mean "nothing to compare yet" (still loading, or the recipe was
// deleted), which is NOT a change — the same rule its sibling keeps, and for the
// same reason: the banner must not flash while the stores resolve.
export function recipeChangedSince(
  batchCreatedAt: string | null | undefined,
  recipeUpdatedAt: string | null | undefined,
): boolean {
  // Presence, not truthiness, on BOTH sides — as in `hasRecipeChanged`.
  if (batchCreatedAt === null || batchCreatedAt === undefined) return false;
  if (recipeUpdatedAt === null || recipeUpdatedAt === undefined) return false;
  return recipeUpdatedAt > batchCreatedAt;
}
