import { z } from 'zod';
import { SHOPPING_BEHAVIORS, CANON_ITEM_UNITS } from '@salt/shared-types';

// What changed on this item since it was last approved — by the matching
// pipeline, or (Phase 2) by the user's own aisle admin (issue #193). Unlike
// RecipeDiff — which is a pure render contract, built on demand and never
// stored — this one IS PERSISTED, as an array on the canon doc, so it carries a
// real back-compat surface.
//
// Written by the pure domain set-sites (appendCanonSynonym records
// `synonym_added`; createCanonItem seeds `created` when the new item needs
// approval; mergeAisles/deleteAisles record `aisle_cleared` on the unassign
// path), by BOTH the client fast path and the CF pipeline, since both go
// through the same commands. Cleared by approveCanonItem, which OMITS the key
// rather than writing `[]` — the record is about the pending change, not a
// permanent history.
//
// NO TIMESTAMP on an entry, deliberately: the domain is pure (no clock port),
// array order records the sequence, and the doc's own `updatedAt` records when.
//
// `rawInput` is the entry the change came from, carried only when it differs
// from the value it produced (a literal compare — see the set-sites), so the UI
// can answer "why on earth is THAT a synonym for Tomatoes" without a trip to
// the shopping list.
export const PendingCanonChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('synonym_added'),
    // The normalised synonym that was appended.
    synonym: z.string(),
    rawInput: z.string().optional(),
  }),
  z.object({
    kind: z.literal('created'),
    rawInput: z.string().optional(),
  }),
  // The item lost its aisle because an aisle it lived in was merged away or
  // deleted, and the admin chose to unassign rather than move (issue #193,
  // Phase 2). NOT an AI decision — `origin` exists so the copy can say so.
  //
  // `fromAisleId` is PROVENANCE ONLY: the aisle it names has just been merged
  // away or deleted, so it will never resolve to a name. Do not add a lookup to
  // make it resolve — the rendered words stand on their own without the aisle.
  // Nullable to match `CanonItem.aisleId`, though both set-sites are guarded on
  // a non-null aisle and so always record a real id.
  z.object({
    kind: z.literal('aisle_cleared'),
    fromAisleId: z.string().nullable(),
    origin: z.enum(['aisle_merge', 'aisle_delete']),
  }),
]);

export type PendingCanonChangeDoc = z.infer<typeof PendingCanonChangeSchema>;

export const CanonItemSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(5),
  name: z.string(),
  synonyms: z.array(z.string()),
  aisleId: z.string().nullable(),
  thumbnail: z.string().nullable(),
  // Transient one-shot steer for the next icon (re)generation (issue #148).
  // Written by the regenerateCanonIcon callable alongside thumbnail: null;
  // consumed and cleared by the onCanonItemWritten icon branch.
  iconHint: z.string().optional(),
  // Regenerate nonce (epoch ms): the regenerateCanonIcon callable stamps this on
  // every request so the write always mutates the doc — even when thumbnail is
  // already null — which is what re-fires the onCanonItemWritten icon branch
  // (Firestore emits no write event for a no-op update). Number, not a Firestore
  // Timestamp, so both the trigger and the client subscription parse it cleanly.
  iconRequestedAt: z.number().optional(),
  // RELOCATED (issue #410): the name embedding now lives in the server-only
  // `canonEmbeddings/{id}` collection (see CanonEmbeddingSchema), not on this
  // client-subscribed doc. Kept OPTIONAL — not removed — purely for back-compat
  // on read: docs written before the migration still carry an inline vector and
  // must stay valid, and the firestoreCanonStore adapter reads it as a fallback
  // until the one-off migration relocates it. New writes never set it here (the
  // adapter strips it; the CF embedding branch writes canonEmbeddings). Do NOT
  // reintroduce writes to this field.
  embedding: z.array(z.number()).nullable().optional(),
  needs_approval: z.boolean(),
  shoppingBehavior: z.enum(SHOPPING_BEHAVIORS),
  largeQuantityThreshold: z.number().optional(),
  // The unit the household buys this in (issue #1643). Set by arbitration as the
  // unit of the pack threshold above, and read since #1643 as the item's
  // preferred unit too: `count` makes a recipe line of it read and shop as a
  // count (`chooseIngredientAmount`). Unset reads as metric, as before.
  unit: z.enum(CANON_ITEM_UNITS).optional(),
  // The weight of ONE of this item, in grams (issue #1643) — meaningful only when
  // `unit` is `count`. It lets a combined shopping row turn weight-only recipe
  // contributions into whole items once per row ("200 g onion" beside "2 onions"
  // → 4 onions at 150 g each) and write one bracketed weight for the row. Set by
  // arbitration when it mints a counted item, editable in admin. OPTIONAL and
  // additive: absent on every item written before it, and absent means "no
  // conversion" — such a row keeps its separate grams subtotal.
  gramsPerItem: z.number().positive().optional(),
  reasoning: z.string().optional(),
  updatedAt: z.string(),
  // Distributed-trace correlation field (issue #362, Phase 5). A W3C
  // `traceparent` string the onShoppingListItemWrite trigger stamps onto the
  // canon doc at match write-back, so the onCanonItemWritten icon/embedding
  // trigger can continue the same browser-rooted trace. TRANSPORT ONLY — domain
  // logic must never branch on it, and the pure domain CanonItem never carries
  // it: the firestoreCanonStore adapter adds the field at write time. Optional
  // and additive: old docs lack it and stay valid (back-compat on read). A bare
  // traceContext-only write is a no-op for the icon/embedding idempotency guards
  // (they key off thumbnail/iconRequestedAt/embedding, never this field), so
  // stamping it cannot loop the trigger.
  traceContext: z.string().optional(),
  // What the pipeline changed, pending review (issue #193). OPTIONAL and
  // additive — every canon doc in production predates it and must stay valid on
  // read, or canonSubscription would silently skip the whole collection. An
  // ABSENT field means "not recorded", NEVER "nothing changed": items flagged
  // before this shipped carry no record and must keep today's appearance.
  // Additive, so schemaVersion stays at 5.
  pendingChanges: z.array(PendingCanonChangeSchema).optional(),
});

export type CanonItemDoc = z.infer<typeof CanonItemSchema>;
