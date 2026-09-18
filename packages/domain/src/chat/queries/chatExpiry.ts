import type { ChatSessionDoc } from '../../schemas/chatSession.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A general kitchen chat: a fortnight, unchanged since #206. */
export const CHAT_TTL_MS = 14 * DAY_MS;

// A chat attached to a recipe outlives a general one. It no longer outlives
// everything (issues #696, #939).
//
// The reason it lives longer is unchanged and still right: the recipe page lists
// every conversation you have had about a dish, including the one it was written
// from, and a fortnightly sweep would empty that list for exactly the recipes you
// have lived with longest. What was wrong was the WIDTH of the exemption. It was
// written as `9999-12-31`, and because a chat claims its recipe as soon as it
// produces one, the majority of sessions end up in the never-expiring class — 52
// of staging's 76 carry a `recipeId`. A collection whose dominant class is
// immortal has no bound at all, and it is read whole at auth, on every cold
// start, holding the fattest documents in the app.
//
// EIGHTEEN MONTHS, because the interval this has to survive is a year. A dish you
// cook once a Christmas is precisely the "recipe you have lived with longest" the
// exemption exists for, and a 365-day window is a coin flip on whether the sweep
// beats the next cook. Eighteen clears an annual cycle with six months to spare,
// and any turn of the conversation restamps it from today.
export const CHAT_RECIPE_TTL_MS = 540 * DAY_MS;

/**
 * When a chat written *now* should expire — a fortnight, or eighteen months once
 * it has a recipe.
 *
 * HERE, in the pure domain, because a chat document has more than one writer and
 * only one of them may name a Firebase type (issue #1430). `saveChatSession` in
 * `@salt/firebase-sync` writes from the browser; `chefChatFlow` in
 * `apps/cloud-functions` writes the turn it has just streamed, and cannot import
 * that adapter (Hard rule 2). A retention policy copied into a second file is how
 * the two drift, on a field whose failure mode is total silence (#1008) — so the
 * durations and the choice between them have one home and both writers call it.
 * Each converts the result to a Firestore `Timestamp` with its own SDK's; that
 * conversion is the part that cannot live here.
 *
 * Takes `now` rather than reading the clock (Hard rule 1: domain is pure, no
 * I/O) — callers pass `new Date()`, exactly as `isChatReadOnly` does.
 */
export function chatExpiresAt(session: Pick<ChatSessionDoc, 'recipeId'>, now: Date): Date {
  const ttl = session.recipeId !== null ? CHAT_RECIPE_TTL_MS : CHAT_TTL_MS;
  return new Date(now.getTime() + ttl);
}
