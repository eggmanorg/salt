import type { Member } from '../entities/Member.js';

// Who counts as a person (issue #1300). These two are where `member.system` is
// meant to be inspected, so the rule "a system account is never offered as a
// person" is stated once and every people-picker inherits it — including the one
// built next year, which never has to be told.
//
// "Meant to be", not "can only be": nothing mechanical stops a component reading
// the field, exactly as nothing stops one comparing `recipe.kind` instead of
// calling `takesIngredients`. It is a convention held by review, and it holds
// today — the admin screen, which EDITS the flag, still asks through `isPerson`.
//
// The rule is about being OFFERED, never about being allowed. A system account
// signs in, adds recipes and uses the app exactly as it did; what changes is that
// nothing asks whether it is coming to dinner. Anything answering "who am I" —
// the current-member resolution, the admin roster, the kitchen label — keeps
// reading the whole roster and must not call these.
export function isPerson(member: Member): boolean {
  return !member.system;
}

// The roster minus its system accounts, in the order it came in. Pure — returns a
// new array.
export function onlyPeople(members: readonly Member[]): Member[] {
  return members.filter(isPerson);
}
