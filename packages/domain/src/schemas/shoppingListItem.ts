import { z } from 'zod';

const ManualSourceRefSchema = z.object({
  kind: z.literal('manual'),
  // First name of the member who added the item. Optional: omitted on items
  // added before this field existed, and when the adder can't be resolved.
  addedBy: z.string().optional(),
});

const RecipeSourceRefSchema = z.object({
  kind: z.literal('recipe'),
  recipeId: z.string(),
  servings: z.number(),
  label: z.string().optional(),
});

export const SourceRefSchema = z.discriminatedUnion('kind', [
  ManualSourceRefSchema,
  RecipeSourceRefSchema,
]);

// Per-product-form demand carried by a product-form shopping row (issue #501).
// `parentCount` is the UNROUNDED parent-count this form's raw amount converts to,
// so demands can be summed raw and rounded once at display time. Storing the
// fractional parent-count (not raw amount + yield) keeps the yield out of the doc.
export const FormDemandSchema = z.object({
  formId: z.string(),
  parentCount: z.number(),
});

export type SourceRefDoc = z.infer<typeof SourceRefSchema>;
export type FormDemandDoc = z.infer<typeof FormDemandSchema>;

// One Firestore document at `shoppingLists/{listId}/items/{itemId}`.
//
// THE ELEVEN NON-ADDITIVE FIELDS BELOW ARE REQUIRED, and that is a decision
// (issue #1114). Ten of them carried a `.default()` and `matchState` carried a
// `.catch()`, so a document missing pieces did not FAIL validation — it was
// filled in with blanks and delivered to the shopping list as a real row: a row
// with no name on it, or one pinned "still matching" forever. The list read's
// contract is to SKIP an invalid document and log it (docs/data-model.md), and a
// schema that cannot fail is a contract that cannot run.
//
// Removing a default is a NARROWING over a collection holding real production
// data, so it was measured rather than argued from symmetry:
// scripts/audit-shopping-list-fields.mjs, run 2026-09-03, found 0 of 62 item
// documents across prod, staging and dev lacking any of these eleven, and 0
// carrying a value that would fail — including `needsCheck`, whose default was
// the one this issue expected to be load-bearing (it was added by #185, and the
// pre-#185 rows that lacked it have long since been shopped and deleted).
//
// The honest limit of that measurement: it saw the documents that EXIST, not
// every document that ever has. That is the right basis for this change — what
// a required field can skip is what is in the collection when the code ships —
// but it is not a claim that no row ever lacked a field. Re-run the audit before
// making a twelfth field required.
//
// The ADDITIVE FIELDS below (`traceContext`, `formDemand`, `originalText`,
// `measureNote`, `weightGrams`) plus `amount`/`unit` stay `.optional()`:
// their absence is the contract, not a defect, and each carries its own reason.
export const ShoppingListItemSchema = z.object({
  id: z.string(),
  rawText: z.string(),
  notes: z.string(),
  sources: z.array(SourceRefSchema),
  canonId: z.string().nullable(),
  // NO `.catch()`, deliberately, and this was the one field the audit could not
  // have vetoed. `.catch()` is strictly stronger than a default: it swallowed an
  // absent field, a null, a wrong type and an unknown enum member alike, so this
  // was the single field on either collection that could not be rejected for any
  // reason. (#1114 described it as the only `.catch()` in the repository, which
  // was true when that was written; `AuthoredRecipePhasesSchema` in `recipe.ts`
  // has since grown a deliberate one, on an AI OUTPUT rather than a stored
  // document, for the reason set out at its declaration.)
  //
  // What that produced was not cosmetic but a live contradiction with the
  // server. `onShoppingListItemWrite` reads this field OFF THE RAW DOCUMENT
  // (`storedMatchState`, and the comment there says why), falling back to `''`;
  // the browser fell back to `'pending'`. So a document carrying a value the
  // enum does not recognise showed the family a row waiting to be matched while
  // the trigger declined to match it — pinned in a state nothing could advance.
  // A row nobody can match must be visible as broken, not disguised as busy.
  matchState: z.enum(['pending', 'matched', 'needs_approval', 'failed']),
  amount: z.number().optional(),
  unit: z.string().optional(),
  checked: z.boolean(),
  needsCheck: z.boolean(),
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Distributed-trace correlation field (issue #362, Phase 5). A W3C
  // `traceparent` string the browser stamps onto the item at "add to shopping
  // list" so the onShoppingListItemWrite trigger can continue the browser-rooted
  // trace (it has no inbound HTTP headers to extract from). TRANSPORT ONLY —
  // domain logic must never branch on it; it just rides on the doc. Optional and
  // additive: old docs lack it and stay valid (back-compat on read).
  traceContext: z.string().optional(),
  // Product-form demand breakdown (issue #501). Present only on a product-form
  // parent row (one written with the `'count'` unit sentinel): one entry per form
  // of this parent the source recipe demanded, each carrying that form's own
  // unrounded parent-count. Without it the display layer can only MAX the
  // already-collapsed per-recipe counts, which under-counts two recipes wanting
  // the SAME form (zest 10 g + 15 g must buy 5 limes, not 3).
  //
  // Optional and additive: items written before this field (and every non-form
  // item) lack it and stay valid on read — they degrade to the old MAX-across-
  // recipes rule and keep their existing number (back-compat; no migration).
  formDemand: z.array(FormDemandSchema).optional(),
  // The recipe's OWN wording for the ingredient line(s) behind a product-form row
  // (issue #528). Present only on a product-form parent row, alongside
  // `formDemand`: the row is labelled with the PARENT product ("Lime ×3"), which
  // by design reads nothing like the recipe's line ("juice of 2 limes"), so
  // without this the shopper in the aisle can't tell what the three limes are
  // for. One entry per contributing line (winner first, then source order,
  // de-duplicated). DISPLAY ONLY — no logic may branch on it.
  //
  // Optional and additive: items written before this field (and every non-form
  // item) lack it and stay valid on read — they degrade to today's display, which
  // labels the sub-line with the cleaned item name (back-compat; no migration).
  originalText: z.array(z.string()).optional(),
  // The recipe's ORIGINAL non-metric measure for this line, verbatim — "6 cloves",
  // "1½ cups", "2–3 tbsp". The recipe's own `parsed.displayText`, carried onto the
  // list so a row the parser flattened to grams still says what to reach for in
  // the shop: "18g Garlic (6 cloves)" rather than a weight nobody can eyeball.
  //
  // Written ONLY when the recipe was added at its own servings. The string is a
  // frozen parse-time rendering with no structure to scale — you cannot multiply
  // "1½ cups" or "2–3 tbsp" — so at any other serving count it would contradict
  // the scaled amount beside it and have the shopper buy the wrong quantity. It is
  // therefore absent rather than wrong; see `buildRecipeAddPlan`.
  //
  // DISPLAY ONLY — no logic may branch on it. Optional and additive: items written
  // before this field, manual adds, and every scaled add lack it and stay valid on
  // read (back-compat; no migration).
  measureNote: z.string().optional(),
  // The weight a COUNTED recipe row stands for, in grams, at the servings it was
  // added at (issue #1643) — the parser's estimate behind "3 large onions", so a
  // combined counted row can write ONE bracketed weight ("Red onion ×6 (900g)")
  // without re-reading any recipe. Absent on a metric row (its `amount` is its
  // weight), on a product-form parent row (its weight is the parent's), on manual
  // adds, and on every item written before the field.
  //
  // DISPLAY ONLY — no logic may branch on it. Optional and additive: back-compat
  // on read, no migration; items already on a list keep what they were added with.
  weightGrams: z.number().optional(),
});

export type ShoppingListItemDoc = z.infer<typeof ShoppingListItemSchema>;
