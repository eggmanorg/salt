import { z } from 'zod';

/**
 * The one non-string shape `text` is allowed to arrive in, unwrapped on read.
 *
 * A READ-SIDE REPAIR FOR DOCUMENTS THAT ALREADY EXIST, not a guard against
 * anything a current client can produce (issues #1299, #1310). For the life of
 * PR #1303 the `chefChat` callable resolved to `{ text, offered }` instead of a
 * bare string. A browser still on the pre-#1303 bundle did no parsing, so it
 * wrote that whole object into `message.text`; nothing validates on the write
 * side, and every later read then fails `text: z.string()`, which makes
 * `subscribeCollection` SKIP the document. The conversation disappears from the
 * chat list permanently, and a recipe-attached chat carries an eighteen-month
 * TTL so it never ages out either.
 *
 * #1310 returns the callable to a bare string, so no client can create another
 * one — but a document written during that window still has to be readable, and
 * documents outlive reverts. That is the whole and only claim: this repairs
 * `{ text: string, … }`; any other non-string `text` still fails, as it should.
 *
 * Here rather than in the adapter beside `normalizeExpiresAt`, so EVERY read
 * path gets it.
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
