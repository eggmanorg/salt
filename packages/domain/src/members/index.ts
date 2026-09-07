// Members module — published surface (issue #155).
// This file is the ONLY thing other domain modules and adapters are allowed to
// import from members. Anything not re-exported here is private.

export type { Member } from './entities/Member.js';
// The cook-mode preference (issue #776) is defined with the wire schema and
// re-exported here, so a consumer of the members module never has to reach into
// `@salt/domain/schemas` for the type of a field on `Member`.
export type { CookMode } from '../schemas/member.js';

export { normaliseMemberEmail } from './commands/normaliseMemberEmail.js';
export { createMember } from './commands/createMember.js';
export type { CreateMemberInput } from './commands/createMember.js';
export { updateMember } from './commands/updateMember.js';
export type { UpdateMemberPatch } from './commands/updateMember.js';

export { memberInitials } from './queries/memberInitials.js';
export { memberFirstName } from './queries/memberFirstName.js';
export { sortMembers } from './queries/sortMembers.js';
// Issue #1300 — the one reader of `Member.system`. Consumers ask these rather
// than the field, so "a system account is never offered as a person" lives in
// one place.
export { isPerson, onlyPeople } from './queries/isPerson.js';
