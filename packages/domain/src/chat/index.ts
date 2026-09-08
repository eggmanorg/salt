// Chat module — read-only-after-two-days (issue #1270). Mirrors the
// capability-predicate pattern in `recipe/queries/capabilities.ts`: a pure
// function over the document, called from every surface that needs the
// answer, so no call site inspects `reopenedAt`/`createdAt` itself.
export { isChatReadOnly, CHAT_READ_ONLY_AFTER_MS } from './queries/isChatReadOnly.js';

// What the chef's newest reply says it offered (issue #1299) — the gate every
// recipe action under that reply is decided by, in one place rather than at
// three call sites.
export { latestChefOffers, offersDishChange, offersNewDish } from './queries/latestChefOffers.js';
