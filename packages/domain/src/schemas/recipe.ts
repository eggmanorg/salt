import { z } from 'zod';

// Recipe document schema (issue #179). Validated on read in firebase-sync and on
// flow output in the parse CF (Phase 3). This is the single source of truth for
// the recipe shape: the recipe entity graph in packages/domain/src/recipe/entities
// aliases the inferred types below (issue #417), so entity and document can't drift.

// A plain numeric amount, e.g. "2", "0.5", "200".
export const SingleQuantitySchema = z.object({
  type: z.literal('single'),
  value: z.number(),
});

// A low–high amount, e.g. "2–3".
export const RangeQuantitySchema = z.object({
  type: z.literal('range'),
  min: z.number(),
  max: z.number(),
});

// A whole number plus an exact fraction, e.g. "1 ½" = { whole: 1, numerator: 1,
// denominator: 2 }; a bare "½" is whole 0. Stored as a fraction (not a decimal)
// so the original is preserved exactly. denominator is positive to stay a valid
// fraction.
export const MixedQuantitySchema = z.object({
  type: z.literal('mixed'),
  whole: z.number().int().nonnegative(),
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().positive(),
});

export const QuantitySchema = z.discriminatedUnion('type', [
  SingleQuantitySchema,
  RangeQuantitySchema,
  MixedQuantitySchema,
]);

export const ParsedIngredientSchema = z.object({
  quantity: QuantitySchema.nullable(),
  // Metric unit only. `null` means the amount is a COUNT, not a measure — and the
  // parse prompt decides which, so read it there rather than inferring from the
  // name of a thing. Most count/pack ingredients (onions, rashers, tins, bunches)
  // are deliberately FLATTENED to grams; `null` is reserved for the narrow set
  // where the shopper's own unit is the count: bought-whole discrete proteins
  // (eggs, poultry joints, whole fish), garlic cloves, and equipment-prep lines
  // that carry no dish amount at all. A stale version of this comment said the
  // opposite for cloves and cost an investigation — keep it in step with
  // `apps/cloud-functions/src/flows/parseRecipeIngredients.ts`.
  unit: z.enum(['g', 'ml']).nullable(),
  item: z.string(),
  preparation: z.array(z.string()),
  notes: z.string().nullable(),
  // Human-friendly display string for the original non-metric measure, e.g. "½ tsp"
  // or "1 cup". null when the source was already in g/ml or has no unit.
  // .default(null) so documents written before this field was added still parse.
  displayText: z.string().nullable().default(null),
});

export const IngredientSchema = z.object({
  id: z.string(),
  rawText: z.string(),
  parsed: ParsedIngredientSchema.nullable(),
  canonId: z.string().nullable(),
  matchState: z.enum(['pending', 'matched', 'failed']),
  isOptional: z.boolean(),
  firstUsedInStepId: z.string().nullable(),
});

export const IngredientGroupSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  items: z.array(IngredientSchema),
});

export const StepTimerSchema = z.object({
  durationMinutes: z.number(),
  description: z.string().nullable(),
});

export const StepSchema = z.object({
  id: z.string(),
  text: z.string(),
  timer: StepTimerSchema.nullable(),
  note: z.string().nullable(),
});

// One named block of a recipe's timing (issue #1122). Three to six of them, in
// the order you do them, are what a recipe's timing IS — the ordered strip the
// planning timeline draws.
//
// `label` is free text the model wrote ("First rise", "Roast cauliflower & make
// sauce"). NOTHING IN THE APP MAY BRANCH ON IT: it is displayed and nothing else,
// the same discipline CLAUDE.md applies to `recipes.kind`. The moment behaviour
// depends on the word we have built a fixed enum with extra steps, and a fixed
// enum cannot serve both a loaf and a traybake.
//
// TWO numbers, never three. A phase's elapsed time is `handsOnMinutes +
// handsOffMinutes`, derived at the point of use (`recipePhaseTotals`) and never
// stored: a third number is a third thing that can disagree with the other two,
// which is the split-definition defect this issue exists to close.
//
// Work that OVERLAPS folds into ONE phase whose hands-on is less than its
// elapsed — roasting the cauliflower while the bechamel comes together is one
// 20-minute phase with 15 minutes of you in it, not two tracks. There are
// deliberately no start offsets here; those would be a scheduling engine.
export const RecipePhaseSchema = z.object({
  label: z.string(),
  /** Minutes of the cook's attention. */
  handsOnMinutes: z.number(),
  /** Minutes the phase runs without the cook — heat, a prove, a chill, a rest. */
  handsOffMinutes: z.number(),
});

/**
 * How many phases a strip may carry.
 *
 * Six, and the argument is readability: a strip is read at a glance, and a
 * seventh block stops being a glance. A dish with eleven distinguishable stages
 * has eleven stages whether or not we draw them; what it does not have is eleven
 * things worth knowing before you start.
 */
export const MAX_RECIPE_PHASES = 6;

/**
 * The phase list as the three AUTHORING paths must emit it — the librarian, both
 * extractors and the re-estimator, which all ask the same question against the
 * same definition (`PHASE_RULES`).
 *
 * Tighter than `RecipeMetadataSchema.phases` on purpose, and the asymmetry is the
 * #1123 one restated: the gates are on the way IN. Whole non-negative minutes and
 * at most six blocks are what a model may return; a stored document that somehow
 * holds seven is still read and still drawn.
 *
 * `.catch([])` on a strip that FAILS this gate — a seventh block, a fractional or
 * negative minute — rather than letting that failure propagate (issue #1122
 * review, blocking 3). This is a decorative field on every call site that embeds
 * it (`.optional()` on top, always): the librarian has no retry, so a bad strip
 * failing the whole `LibrarianOutputSchema` parse used to lose the user's entire
 * chat-authored recipe over a field invisible to them, and on the estimator path
 * it discarded the three prep/cook/total numbers the model got right alongside
 * it. `[]` reads exactly like "the model omitted phases" to every consumer
 * (`reconcileRecipePhases`) — an over-cap or malformed strip degrades to no
 * strip, never to no recipe. `MAX_RECIPE_PHASES` stays the one stated bound; only
 * the failure mode changed.
 */
export const AuthoredRecipePhasesSchema = z
  .array(
    RecipePhaseSchema.extend({
      handsOnMinutes: z.number().int().nonnegative(),
      handsOffMinutes: z.number().int().nonnegative(),
    }),
  )
  .max(MAX_RECIPE_PHASES)
  .catch([]);

/** The one-line summary as the authoring paths emit it: a sentence, or null. */
export const AuthoredTimingSummarySchema = z.string().nullable();

export const RecipeMetadataSchema = z.object({
  // Deliberately permissive, and staying that way (issue #1123). This is the READ
  // boundary for a production collection: rejecting a bad `servings` here would
  // skip the whole recipe rather than fix one field, so a document written before
  // the authoring gates existed would silently vanish from the library. The gates
  // are on the way IN — the three flows' output schemas — and `buildRecipeAddPlan`
  // treats a non-positive stored value as unstated rather than dividing by it.
  servings: z.number().nullable(),
  // The recipe's timing (issue #1122). Additive and OPTIONAL, the same bargain
  // `timesRequestedAt` and `RecipeSourceSchema.book` make: every document stored
  // before this shipped lacks both keys, and a required field here would skip the
  // whole recipe rather than fix one field — the block above says why that is the
  // one thing this schema may never do.
  //
  // `undefined` is therefore a live state and means "never estimated". Read it
  // through `recipePhaseTotals`, which is the single funnel that turns absent, empty
  // and populated into one answer; do not reach for `.length` on it directly.
  //
  // NOT capped at six here, though the three authoring output schemas are. This is
  // the read side of a production collection: a document that somehow carries seven
  // phases is a document to render, not one to drop.
  phases: z.array(RecipePhaseSchema).optional(),
  /**
   * One short sentence over the strip ("About 40 minutes of you, spread over 2¼
   * hours — start it the night before"), or absent. `null` and `undefined` both
   * mean no sentence: null is what an estimate that produced none stores (Firestore
   * rejects `undefined`), undefined is a document written before this existed.
   */
  timingSummary: z.string().nullable().optional(),
  tags: z.array(z.string()),
});

export const RecipeSourceSchema = z.object({
  type: z.enum(['url', 'book', 'manual']),
  url: z.string().optional(),
  // Book provenance, filled from what a photographed page actually SHOWS (issue
  // #649): a running head, an author's name, a printed page number. Any of the
  // three can be absent from the crop the user took, and the model is told to
  // omit rather than invent — so each part is individually optional and the whole
  // object is dropped when nothing was legible.
  //
  // Relaxing these from required to optional is a widening: every document that
  // parsed before still parses, and nothing in the codebase has ever written a
  // `type: 'book'` source, so no production document is affected and no migration
  // is needed (salt-architecture.md §1.1).
  book: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      page: z.number().optional(),
    })
    .optional(),
});

export const RecipeImageSchema = z.object({
  url: z.string(),
  // `ai` — the photoreal hero generated by the onRecipeWritten trigger (issue
  // #148 Tier-2); `upload` — a user-supplied photo (reserved seam, not produced
  // yet). The trigger only ever writes/overwrites an `ai` image and never
  // touches an `upload` one, so a manual photo is never clobbered.
  source: z.enum(['ai', 'upload']),
});

// What kind of entry this is (issue #637). The `recipes` collection holds more
// than recipes: an `outing` is a takeaway / picnic / meal out — it fills a
// planner slot but has no ingredients and no method; a `cocktail` has both but
// is never a dinner; a `placeholder` (issue #652) is neither — it is a stock
// photograph of "a good dinner, no particular dish", attached to a planner day
// that was planned in a sentence so that night gets a card like any other.
// NOTHING outside packages/domain branches on this value — behaviour comes from
// the pure capability predicates in `recipe/queries/capabilities.ts`, so the
// fourth kind was, as promised, a one-file change there.
//
// Adding a member here is back-compatible on read by construction: `kind` carries
// `.default('recipe')` below, so every document already in production parses
// unchanged (salt-architecture.md §1.1 — no migration).
export const RecipeKindSchema = z.enum(['recipe', 'outing', 'cocktail', 'placeholder']);

// One piece of kit a recipe calls for (issue #882). A free-text LABEL and the
// steps that use it — never a `kitchenTools` id, and that is the load-bearing
// choice of the whole feature: the recipe keeps the words a cook would say, and
// the drawn vocabulary is resolved against those words at DISPLAY time. A label
// nothing in the vocabulary matches renders as words with no picture, which is a
// normal outcome rather than a fault, and it means the vocabulary can grow (or
// shrink) without a single recipe being rewritten.
export const RecipeKitEntrySchema = z.object({
  // What a cook would call it, and specific enough to reach for: "large frying
  // pan", not "pan"; "box grater", not "grater". The specificity is the feature —
  // "get out a pan" tells you nothing you did not already know.
  label: z.string(),
  // The steps this piece of kit is used in, and deliberately PLURAL rather than a
  // single `firstUsedInStepId`. A frying pan enters at step 3 and is still on the
  // hob at step 9; a mixing bowl is used at 1 and again at 6. Storing every step
  // is what lets a later surface say "have it ready by" (the first) and "it is
  // free after" (the last) without a second field, and what lets the method mark
  // a run of steps rather than a single moment.
  //
  // Ids are step ids from the SAME document, exactly as `firstUsedInStepId` is —
  // document-local, so a duplicate that copies steps verbatim keeps every link.
  stepIds: z.array(z.string()),
});

export const RecipeSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  // `.default('recipe')` (NOT `.optional()`) is load-bearing, not stylistic: the
  // realtime subscription skips documents that fail validation, so a required
  // `kind` would make every recipe already in production (#240) silently vanish
  // from the list. Defaulted, they read back as exactly what they are — recipes.
  kind: RecipeKindSchema.default('recipe'),
  title: z.string(),
  description: z.string().nullable(),
  ingredients: z.array(IngredientGroupSchema),
  steps: z.array(StepSchema),
  metadata: RecipeMetadataSchema,
  source: RecipeSourceSchema.nullable(),
  notes: z.string().nullable(),
  // The grocery item this recipe produces, if any ("buy or make", Phase 1). A
  // canon item id, or null when the recipe isn't linked to a grocery item.
  // `.default(null)` (NOT `.optional()`) so recipes written before this field
  // parse cleanly to `null` on read — back-compat on production data (#240) —
  // and every reader sees a concrete `string | null`, never `undefined`.
  producesCanonId: z.string().nullable().default(null),
  // Review state for AI-authored recipes (issue #616). Set by the URL-import
  // callable, which persists the extracted recipe itself so a share-sheet import
  // (#589) survives the PWA being killed mid-extraction. Same used-but-flagged
  // semantics as CanonItem/ProductForm `needs_approval`: the recipe is fully live
  // — cookable, plannable, searchable — the flag ONLY records that no human has
  // read it yet. It is never a gate on use, and it is never filtered out.
  // THREE things clear it, and no fourth semantic exists (#1319 Phase 8, which
  // removed a fourth — the retired editor's save): pressing Done on the recipe's
  // own page after editing it, tapping the banner's own button on that page
  // (both `handleMarkReviewed` in `RecipeViewPage.svelte`), and **Mark reviewed**
  // on the `/mine` review-queue row (`MinePage.svelte`). All three drop the field
  // rather than setting it false. `.optional()` (mirroring ProductFormSchema) so
  // the production recipes collection parses unchanged on read — absent means
  // reviewed (#240).
  needs_approval: z.boolean().optional(),
  // The dishes this entry is built from (issue #752). A Sunday roast is one
  // recipe document that points at roast chicken, roast potatoes and onion gravy;
  // "is this a meal?" is DERIVED from this array being non-empty, never declared,
  // so there is no fifth `kind` and no second collection. The recipe keeps its
  // own ingredients, steps and notes — nothing aggregates and nothing recurses:
  // components resolve exactly one level deep for display, which is what makes a
  // reference cycle inert and the whole feature O(1). A dangling id (component
  // deleted elsewhere) is skipped silently on read; there is no cascade and no
  // tombstone. `.default([])` (NOT `.optional()`) for both reasons that made
  // `producesCanonId` two fields above take the same shape: the realtime
  // subscription skips documents that fail validation, so a required field would
  // make every recipe already in production (#240) silently vanish from the list,
  // and defaulted, every reader sees a concrete `string[]` rather than `undefined`.
  componentRecipeIds: z.array(z.string()).default([]),
  // The kit this dish needs — the pans, bowls, boards and hand tools a cook gets
  // OUT before starting (issue #882). Inferred server-side from the WHOLE recipe
  // by the identifyRecipeKit flow, because the answer is usually not written down:
  // "mash the potatoes" needs a masher the recipe never names.
  //
  // `.default([])` (NOT `.optional()`) for both reasons that made
  // `componentRecipeIds` above take the same shape: the realtime subscription
  // skips documents that fail validation, so a required field would make every
  // recipe already in production (#240) silently vanish from the list, and
  // defaulted, every reader sees a concrete array rather than `undefined`.
  kit: z.array(RecipeKitEntrySchema).default([]),
  // ─── Kit-inference control fields (both optional + additive → back-compat on
  // read; documents written before #882 lack them and stay valid) ──────────────
  //
  // WHY TWO FIELDS, when `kit` is right there. Because `kit.length === 0` cannot
  // be the guard: `kit` defaults to `[]`, so an empty array is indistinguishable
  // between "never inferred", "inferred, and this dish genuinely needs nothing
  // worth listing", and "inference failed". Recipes are re-saved constantly —
  // canonicalise, per-row rematch, an edit, "apply changes", each a whole-document
  // `setDoc` (see the note above `imageNeedsGeneration` in onRecipeWritten) — so a
  // guard keyed on emptiness would fire a fresh AI call on EVERY unrelated save of
  // any recipe whose kit came back empty, forever.
  //
  // `kitInferredAt` (epoch ms) is the stamp that makes the trigger's branch
  // self-terminating: absent means never inferred, present means the question has
  // been asked and answered. Left unstamped when inference fails, so a redo can
  // retry.
  kitInferredAt: z.number().optional(),
  // The redo nonce (epoch ms), stamped by the redoRecipeKit callable, which bumps
  // it in the SAME write that deletes `kitInferredAt` above. Two fields because the
  // redo needs both halves, exactly as `regenerateCanonIcon` needs both of its:
  // clearing the stamp is what the guard reads, and the nonce is what guarantees
  // the write mutates the document at all — Firestore emits no write event for a
  // no-op update, so on a recipe whose inference FAILED (no stamp to delete) a
  // stamp-only redo would be silent and the retry would never happen. The trigger
  // deliberately leaves this field in place when it stamps: deleting it would read
  // as a nonce change on its own re-fire and buy a second inference every time.
  kitRequestedAt: z.number().optional(),
  // ─── Time re-estimate control fields (both optional + additive → back-compat
  // on read; every document written before #952 lacks them and stays valid) ────
  //
  // These are the BACKFILL's two halves, not a per-write feature. The three
  // authoring paths already produce honest times since #952 phase 1; what they
  // cannot do is revisit the ~59 recipes authored before it, whose prep times
  // assume the already-weighed counter the old one-line rule implied. So the
  // onRecipeWritten times branch is edge-triggered on `timesRequestedAt` ALONE —
  // deliberately unlike the kit branch, which also fires on create. A create
  // never needs it (the librarian or the extractor just answered the same
  // question against the same definition), and firing there would buy a second
  // AI call per recipe forever to second-guess a number that is already right.
  //
  // The nonce (epoch ms) is what guarantees the request mutates the document at
  // all: Firestore emits no write event for a no-op update, which is the same
  // reason `kitRequestedAt` and `iconRequestedAt` exist.
  timesRequestedAt: z.number().optional(),
  // The stamp (epoch ms) the trigger writes in the SAME update as the three
  // `metadata.*TimeMinutes` values. It is NOT what gates the branch — the nonce
  // is — and it exists for the script: a re-run skips a recipe that already
  // carries one, so an interrupted backfill resumes instead of paying for every
  // recipe twice, and "how far did it get" is answerable by a masked read of one
  // field rather than by reading the model's logs. A deliberate second pass is
  // still available: bumping the nonce re-fires the branch whatever the stamp
  // says, which is what makes a re-estimate after a prompt change possible.
  timesEstimatedAt: z.number().optional(),
  // The photoreal "arty" hero image (Tier-2, issue #148). `null` = none yet: the
  // onRecipeWritten trigger generates one from the title + description on create.
  // A non-null `{ url, source }` is rendered; the trigger skips it (already
  // generated, or a user upload). See the three transient control fields below.
  image: RecipeImageSchema.nullable(),
  // ─── Hero-image control fields (all optional + additive → back-compat on read;
  // documents written before Tier-2 lack them and stay valid) ──────────────────
  //
  // Transient one-shot steer for the next hero (re)generation. Written by the
  // regenerateRecipeImage callable alongside `image: null`; consumed and cleared
  // by the onRecipeWritten image branch. Mirrors CanonItem.iconHint.
  imageHint: z.string().optional(),
  // Regenerate nonce (epoch ms): the regenerateRecipeImage callable stamps this on
  // every request so the write always mutates the doc — even when `image` is
  // already null — which is what re-fires the onRecipeWritten image branch
  // (Firestore emits no write event for a no-op update). Mirrors iconRequestedAt.
  imageRequestedAt: z.number().optional(),
  // RETIRED and inert: kept on the schema only so production documents that still
  // carry it parse on read (#240). It has no readers anywhere — onRecipeWritten
  // stopped honouring it (auto-generation now runs regardless), and as of #648 no
  // web-pwa site reads it either: hero visibility is purely "does an image URL
  // exist". Its only remaining mention is the regenerateRecipeImage callable
  // deleting it, which is cleanup of legacy data, not a read. It formerly meant
  // "never auto-generate a hero, and hide any existing one" — do not resurrect
  // that behaviour without reinstating readers on both sides.
  imageHidden: z.boolean().optional(),
  // Art-direction brief for the hero: a prose paragraph describing what the
  // plated dish looks like and how it reads in mood/season/cuisine, authored by
  // the describeRecipeScene flow from the WHOLE recipe (ingredients and steps
  // included) and consumed by the onRecipeWritten image branch, which persists it
  // alongside the image it produced. Present on the doc → used verbatim; absent →
  // authored on the next generation. `.optional()` (NOT `.default(null)` — that
  // idiom is for content fields like producesCanonId): this is a hero-image
  // control field like its neighbours above, and recipes written before it
  // existed simply lack it and must keep parsing (back-compat, #240).
  imageBrief: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Attribution (issue #845): the display NAME of the member who added the
  // recipe, copied from their member document at write time. A name, not a uid
  // and not an email — there is no `uid → member` resolver anywhere in the repo
  // (members are keyed by normalised email), so a name is what renders with zero
  // joins, and it survives that member leaving the roster.
  //
  // AUDIT ONLY, exactly like `shoppingDays.setBy`: recorded and displayed, never
  // a gate. It is not per-user scoping and must never become one — never checked
  // on read, never pinned on update, never branched on for capability,
  // availability or ordering. `firestore.rules` stays untouched.
  //
  // `.default('')` (NOT required, NOT `.optional()`) is load-bearing for the same
  // reason as `kind` above: the realtime subscription skips documents that fail
  // validation, so a required field would make every recipe already in production
  // (#240) silently vanish from the list. Defaulted, `z.infer` still yields a
  // concrete `string`, so the compiler names every construction site rather than
  // letting `undefined` drift onto a document. `''` means "no attribution on
  // record" — it renders as nothing, and nothing branches on it beyond "is it
  // empty".
  createdBy: z.string().default(''),
  // The last HUMAN edit, same shape and same rules as `createdBy`. Cloud Function
  // triggers write back partially (`onRecipeWritten` stamps `image`/`imageBrief`)
  // and deliberately do NOT touch this: a generated hero is not an edit.
  lastEditedBy: z.string().default(''),
});

export type SingleQuantityDoc = z.infer<typeof SingleQuantitySchema>;
export type RangeQuantityDoc = z.infer<typeof RangeQuantitySchema>;
export type MixedQuantityDoc = z.infer<typeof MixedQuantitySchema>;
export type QuantityDoc = z.infer<typeof QuantitySchema>;
export type ParsedIngredientDoc = z.infer<typeof ParsedIngredientSchema>;
export type IngredientDoc = z.infer<typeof IngredientSchema>;
export type IngredientGroupDoc = z.infer<typeof IngredientGroupSchema>;
export type StepTimerDoc = z.infer<typeof StepTimerSchema>;
export type StepDoc = z.infer<typeof StepSchema>;
export type RecipePhaseDoc = z.infer<typeof RecipePhaseSchema>;
export type RecipeMetadataDoc = z.infer<typeof RecipeMetadataSchema>;
export type RecipeSourceDoc = z.infer<typeof RecipeSourceSchema>;
export type RecipeImageDoc = z.infer<typeof RecipeImageSchema>;
export type RecipeKindDoc = z.infer<typeof RecipeKindSchema>;
export type RecipeKitEntryDoc = z.infer<typeof RecipeKitEntrySchema>;
export type RecipeDoc = z.infer<typeof RecipeSchema>;
