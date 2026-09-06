import type { ChatSessionDoc } from '../../schemas/chatSession.js';

// The two-day quiet clock (issue #1270). A named constant rather than a literal
// in the predicate below, so the one number this feature turns on has one place
// to change it.
export const CHAT_READ_ONLY_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

// Read-only iff more than two days have passed since the clock's anchor —
// `reopenedAt` once a chat has been manually reopened, `createdAt` otherwise
// (issue #1270, Q2). `createdAt` never changes, so a chat that has gone quiet
// stays that way until the explicit reopen action sets `reopenedAt`, which
// restarts the clock from that moment.
//
// Takes `now` as a parameter rather than reading the clock itself (Hard rule 1:
// domain is pure, no I/O) — callers pass `new Date()`.
export function isChatReadOnly(session: ChatSessionDoc, now: Date): boolean {
  const anchor = new Date(session.reopenedAt ?? session.createdAt).getTime();
  return now.getTime() - anchor > CHAT_READ_ONLY_AFTER_MS;
}
