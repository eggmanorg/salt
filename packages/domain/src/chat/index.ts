// Chat module — read-only-after-two-days (issue #1270). Mirrors the
// capability-predicate pattern in `recipe/queries/capabilities.ts`: a pure
// function over the document, called from every surface that needs the
// answer, so no call site inspects `reopenedAt`/`createdAt` itself.
export { isChatReadOnly, CHAT_READ_ONLY_AFTER_MS } from './queries/isChatReadOnly.js';
