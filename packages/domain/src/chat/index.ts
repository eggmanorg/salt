// Chat module — read-only-after-two-days (issue #1270) and the retention clock
// (issue #1430). Mirrors the capability-predicate pattern in
// `recipe/queries/capabilities.ts`: pure functions over the document, called
// from every surface that needs the answer, so no call site inspects
// `reopenedAt`/`createdAt`/`recipeId` itself.
export { isChatReadOnly, CHAT_READ_ONLY_AFTER_MS } from './queries/isChatReadOnly.js';
export { chatExpiresAt, CHAT_TTL_MS, CHAT_RECIPE_TTL_MS } from './queries/chatExpiry.js';
