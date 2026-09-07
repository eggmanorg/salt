import { z } from 'zod';

// Wire shape of a `members/{email}` Firestore document (issue #155).
// Validated on read in firebase-sync (subscribeMembers skips corrupt docs).
// `id` equals the normalised email and the doc key; see Member entity.
export const MemberSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  name: z.string(),
  email: z.string(),
  admin: z.boolean(),
  sortOrder: z.number(),
  // Reserved for richer avatars later; null = initials. Tolerate a missing
  // field on read by defaulting to null.
  icon: z.string().nullable().default(null),
  // Which cook mode this person's Cook button opens (issue #776). A PREFERENCE,
  // never a permission: whichever way it is set, the other mode stays one tap
  // away on the same control.
  //
  // It lives here rather than in a per-user collection of its own because a
  // member doc IS the per-person record — adding a field to it is not the fourth
  // owner-scoped collection, and the family-shared rule is untouched.
  //
  // `.default()` for the usual reason (back-compat on read: every member doc in
  // production predates the field), and 'standard' specifically because that is
  // what everyone gets today. Absent must mean "nothing changed for you".
  cookMode: z.enum(['standard', 'guided']).default('standard'),
  // Whether this account is a system account rather than a person (issue #1300)
  // — the kitchen screen's own sign-in, for instance, which is a full member so
  // it can be left signed in.
  //
  // It records WHAT THE ACCOUNT IS and gates NOTHING. Not a permission, not a
  // uid, not per-user scoping: a system account signs in, adds recipes, ticks the
  // shopping list and talks to the chef exactly as before, and a recipe it adds
  // still carries its name. What reads it is `isPerson` / `onlyPeople` in the
  // members module, which the people-pickers call — the same shape `recipes.kind`
  // consumers use, so "a system account is never offered as a person" is stated
  // once rather than copied into every picker. Nothing outside packages/domain
  // reads this field directly.
  //
  // `.default(false)` for the same reason `cookMode` has one: every member doc in
  // production predates the field, and absent must read back as "an ordinary
  // person". No migration — the one real system account is ticked by hand in
  // Admin → Members after the deploy.
  system: z.boolean().default(false),
  updatedAt: z.string(),
});

export type CookMode = z.infer<typeof MemberSchema>['cookMode'];

export type MemberDoc = z.infer<typeof MemberSchema>;
