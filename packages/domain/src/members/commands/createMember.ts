import type { Member } from '../entities/Member.js';
import { normaliseMemberEmail } from './normaliseMemberEmail.js';

export interface CreateMemberInput {
  readonly name: string;
  readonly email: string;
  readonly admin: boolean;
  readonly sortOrder: number;
  readonly icon?: string | null;
  // Issue #1300. Optional and false by default, so every existing caller keeps
  // creating people; the admin screen is the only thing that passes it.
  readonly system?: boolean;
  readonly now: string; // ISO-8601
}

// Build a new Member from admin-screen input (issue #155). The normalised email
// is both the entity id and the Firestore doc key, so creating a member with an
// email that already exists is an upsert of that key — callers decide whether
// that is allowed. Name is trimmed; icon defaults to null (initials avatar).
export function createMember(input: CreateMemberInput): Member {
  const email = normaliseMemberEmail(input.email);
  return {
    id: email,
    schemaVersion: 1,
    name: input.name.trim(),
    email,
    admin: input.admin,
    sortOrder: input.sortOrder,
    icon: input.icon ?? null,
    // Not an input: a new member starts where everyone already is (issue #776),
    // and changes it themselves in Settings. The admin screen that calls this has
    // no business choosing how someone likes to cook.
    cookMode: 'standard',
    system: input.system ?? false,
    updatedAt: input.now,
  };
}
