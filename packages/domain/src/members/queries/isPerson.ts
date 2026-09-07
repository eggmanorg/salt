import type { Member } from '../entities/Member.js';

// Who counts as a person (issue #1300). These two are the ONLY place
// `member.system` is ever inspected: no call site outside packages/domain reads
// the field, so the rule "a system account is never offered as a person" is
// stated here once and every people-picker inherits it — including the one built
// next year, which never has to be told.
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
