import { z } from 'zod';

/**
 * What a chef's reply put on the table (issue #1299) — the chef's own account of
 * it, declared through the `declareOffer` tool, never inferred from the prose.
 *
 * Exactly two kinds, because two drive all three buttons:
 *
 * | declaration   | attached chat        | general chat    |
 * | ------------- | -------------------- | --------------- |
 * | `dish-change` | Review changes       | — (no dish)     |
 * | `new-dish`    | Save as new recipe   | Save as recipe  |
 * | (empty)       | nothing              | nothing         |
 *
 * It lives HERE rather than in `chefChat.ts` because that file imports
 * `MessageSchema` from this one: declaring it there and importing it back would
 * be a module cycle, which `pnpm depcruise` rejects (Rule 8).
 */
export const CHEF_OFFER_KINDS = ['dish-change', 'new-dish'] as const;
export const ChefOfferSchema = z.enum(CHEF_OFFER_KINDS);
export type ChefOffer = z.infer<typeof ChefOfferSchema>;

/**
 * The one non-string shape `text` is allowed to arrive in, unwrapped on read.
 *
 * DEPLOY SKEW, in the direction that does damage (issue #1299, PR #1303 review).
 * `chefChat` used to resolve to a bare string and now resolves to
 * `{ text, offered }`. A browser on the PRE-#1299 bundle did no parsing, so
 * against the NEW Cloud Function it writes that whole object into `message.text`;
 * nothing validates on the write side, and every later read then fails
 * `text: z.string()`, which makes `subscribeCollection` SKIP the document. The
 * conversation disappears from the chat list permanently, and a recipe-attached
 * chat carries an eighteen-month TTL so it never ages out either. Not a window of
 * minutes: `pwa.ts` defers a new service worker's reload by ~20 minutes and
 * prefers a route change, so the exposed user is the one sitting on a chat route.
 *
 * Here rather than in the adapter beside `normalizeExpiresAt`, so EVERY read path
 * gets it. The prose is recovered; the `offered` riding inside the wrapper
 * deliberately is not — no declaration is the fail-closed answer this design
 * already chose, and lifting one would trust a shape written by accident.
 */
function unwrapWrappedReply(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const inner = (value as { text?: unknown }).text;
  return typeof inner === 'string' ? inner : value;
}

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.preprocess(unwrapWrappedReply, z.string()),
  createdAt: z.string(),
  /**
   * What the chef declared this reply offered (issue #1299). Always `[]` on a
   * user turn, and on an assistant turn where the chef declared nothing — which
   * is the FAIL-CLOSED half of the design: absent means no buttons, never
   * "show them anyway".
   *
   * `.default([])` rather than `.optional()`, and it is load-bearing for the
   * same reason `basedOnRecipeId` below carries one: `chatSessions` holds live
   * documents and the realtime subscription SKIPS docs that fail validation, so
   * a required field would make every conversation written before this change
   * vanish from the list. The visible consequence is intended and stated in the
   * issue — an old conversation shows no buttons until its next reply.
   *
   * A LIST OF STRINGS, not a list of the two kinds, and that is the same
   * failure one deploy further on (PR #1303 review). A third `CHEF_OFFER_KIND`
   * reaches `chatSessions` the moment the Cloud Function deploys, which is
   * always before every browser has the bundle that knows the word; typed as
   * the enum, an older client fails the message, fails the session, and drops
   * the whole conversation from its list — for a field whose entire job is
   * choosing which buttons to draw. What a word MEANS is decided in
   * `latestChefOffers`, which ignores any it does not know.
   *
   * Deliberately NOT `.catch([])`, which would look like the same fix and is
   * worse: this is a stored document, `saveChatSession` writes it back whole
   * (LWW, no merge), so a client that laundered a word it did not understand
   * into `[]` would ERASE it from the document on the household's next message.
   * Keeping the string keeps the newer client right. `scripts/tests/
   * schemaCatchGuard.test.mjs` is the standing rule (#1114); this field is why
   * it does not need an exemption.
   */
  offered: z.array(z.string()).default([]),
});

export const ChatSessionSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  ownerUid: z.string(),
  recipeId: z.string().nullable(),
  // The recipe this conversation STARTED FROM (issue #763), as distinct from
  // `recipeId`, the recipe it belongs to. A "Make a variation" chat is seeded
  // with a dish it is not attached to: the flows read it server-side to ground
  // the chef and the librarian, and on "Save as recipe" the session claims the
  // NEW recipe, leaving this pointing at the original.
  //
  // `.default(null)` rather than a required field, and it is load-bearing:
  // `chatSessions` holds live documents and the realtime subscription SKIPS docs
  // that fail validation, so a required field would make every chat written
  // before this change vanish from the list. Same reason `RecipeSchema.kind`
  // carries `.default('recipe')`.
  basedOnRecipeId: z.string().nullable().default(null),
  title: z.string(),
  messages: z.array(MessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  // The read-only clock's anchor once a chat has been manually reopened (issue
  // #1270): read-only iff `now - (reopenedAt ?? createdAt)` exceeds the
  // threshold. `createdAt` is immutable, so this is the only field that can
  // record a reopen — hence a THIRD timestamp rather than repurposing
  // `updatedAt`, which is bumped by every ordinary message and would restart
  // the clock just by chatting.
  //
  // `.default(null)` for the same reason as `basedOnRecipeId` above: the
  // realtime subscription SKIPS a document that fails `safeParse`, so a
  // required field would empty the chat list of every session written before
  // this shipped.
  reopenedAt: z.string().nullable().default(null),
  // ISO-8601 here, but a Firestore `Timestamp` on the wire (issue #1008 — the
  // TTL machinery acts on nothing else). firebase-sync converts in both
  // directions at the boundary, so the domain stays Firebase-free (Hard rule 1).
  expiresAt: z.string(),
});

export type ChatSessionDoc = z.infer<typeof ChatSessionSchema>;
