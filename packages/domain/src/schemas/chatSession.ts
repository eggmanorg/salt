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

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
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
   */
  offered: z.array(ChefOfferSchema).default([]),
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
