import type { Member } from '../entities/Member.js';
import type { CookMode } from '../../schemas/member.js';

// Editable fields of a member (issue #155). Email/id are intentionally NOT
// editable: the email is the doc key and the Auth-token join, so changing it is
// a delete-and-recreate, not an in-place edit. Any subset may be supplied.
export interface UpdateMemberPatch {
  readonly name?: string;
  readonly admin?: boolean;
  readonly sortOrder?: number;
  readonly icon?: string | null;
  // Issue #776. Patched by the person themselves from Settings, not by the admin
  // screen — but the command stays a plain field patch, because WHO may change
  // WHAT is a question for firestore.rules, not for a pure function.
  readonly cookMode?: CookMode;
  // Issue #1300. An administrative fact about the account, so unlike `cookMode`
  // it is the admin screen that patches it — but the command stays a plain field
  // patch for the same reason: WHO may change WHAT is firestore.rules' question.
  readonly system?: boolean;
}

// Apply an editable-field patch and re-stamp updatedAt. Pure — returns a new
// Member; the original is untouched.
export function updateMember(member: Member, patch: UpdateMemberPatch, now: string): Member {
  return {
    ...member,
    name: patch.name !== undefined ? patch.name.trim() : member.name,
    admin: patch.admin !== undefined ? patch.admin : member.admin,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : member.sortOrder,
    icon: patch.icon !== undefined ? patch.icon : member.icon,
    cookMode: patch.cookMode !== undefined ? patch.cookMode : member.cookMode,
    system: patch.system !== undefined ? patch.system : member.system,
    updatedAt: now,
  };
}
