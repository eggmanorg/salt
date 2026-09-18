import { z } from 'zod';
import { ProcessSchema } from './process.js';

// Formula document shape (issue #782, epic #778) — composition as ratios against
// a declared basis. Baker's percentage is the general case: the basis is the set
// of ingredients whose combined weight is 100% (the flours, the vegetables, the
// green weight of the meat) and everything else is a percentage of that total.
//
// PERCENT IS THE SOURCE OF TRUTH; GRAMS ARE DERIVED. Nothing here stores a gram
// figure — the recipe's `ingredients[]` remains "the resolved projection at the
// formula's reference yield" (docs/formulas-schedules-batches.md). Storing both
// would let them drift.
//
// Stored at `formulas/{recipeId}` since issue #806 (family-shared, deterministic
// id, no ownerUid), written by exactly one path — `formulaService.saveFormula` in
// the PWA. The SHAPE is unchanged from #782, which landed it headless because the
// pure functions in `packages/domain/src/formula/` are typed against it.
//
// Deliberately no `createdAt`/`updatedAt`: there is no ordering token here and
// nothing needs one. Document-level LWW is the whole conflict story, exactly as
// it is for `mealPlans/{startDate}`.

// How an ml figure became grams, recorded on the component that needed the
// conversion rather than looked up per environment. Named classes (not a raw
// number) so the provenance survives re-derivation, and not a canon-id table
// because canon ids are minted per environment and would be empty everywhere but
// one. Values live in `formula/density.ts`.
export const DensityClassSchema = z.enum(['waterLike', 'oil', 'syrup']);

// WHICH SALT-BEARING PRODUCT THIS COMPONENT IS (issue #1402, phase 04 of epic
// #778). A named class on the component, following `DensityClassSchema` above for
// the same two reasons its header gives: not a raw figure, because the figure that
// matters is a fact about the PRODUCT and would then need re-deriving wherever it
// was read; and not a canon id, because canon ids are minted per environment and a
// table keyed by them is empty everywhere but one.
//
// IT EXISTS BECAUSE "CURING SALT" NAMES TWO DIFFERENT THINGS. The concentrated
// products — cure #1, cure #2 — go in at about 0.25% of the meat alongside ordinary
// salt. The dilute European ones ARE the salt and go in at about 3%. Twelve times
// the difference, both right, and no way to tell which is in the jar from the
// percentage being checked. So the product is stored and the window is read off it;
// `formula/cureSalt.ts` holds the table and states its limits.
//
// NAMED FOR THE PRODUCT, NOT FOR "CURE SALT", and that is deliberate: `plain` is a
// member, because a substitution has to be able to find the ordinary salt it moves
// mass into (issue #1402, phase 3). A second field for that would be one field too
// many.
//
// `plain` CARRIES NO WINDOW, and that is not an omission awaiting a figure. A window
// is a fact about a product's nitrite content (`formula/cureSalt.ts`), and ordinary
// salt has none — too much of it is a dish nobody eats, which is a taste failure and
// not this rail's business. So naming a component `plain` bounds it by nothing at
// all, exactly as naming no product does.
//
// OPTIONAL, and `schemaVersion` stays at 1 — an added optional field is
// read-compatible and production's bread formulas carry none, exactly as `process`
// and `target` below did. Adding a MEMBER is read-compatible for the mirror-image
// reason: no document already written carries the new member, so nothing stored
// fails to parse against the wider enum.
export const SaltProductSchema = z.enum([
  'cure1',
  'cure2',
  'nitritedCuringSalt',
  'salvianda',
  'plain',
]);

export const FormulaComponentSchema = z.object({
  // FK into the recipe's `ingredients[].id`.
  ingredientId: z.string(),
  // Of the BASIS total, not of the whole. Basis members' own percentages sum to
  // 100 by definition, so a 176.4% grand total is normal and correct.
  percent: z.number().nonnegative(),
  inBasis: z.boolean(),
  density: DensityClassSchema.optional(),
  // WHICH SALT-BEARING PRODUCT THIS IS, or nothing at all (issue #1402). See
  // `SaltProductSchema` above. Absent is the ordinary answer and means exactly one
  // thing: no window is read for this component, so the solve has nothing to refuse
  // it against.
  saltProduct: SaltProductSchema.optional(),
  // The bound seam. Declared per component and enforced generically by the
  // solve, which REFUSES rather than extrapolates — the nitrite limits #1402
  // stamps here are the load-bearing customer, and that must not be a decision a
  // screen can be talked out of.
  //
  // STAMPED AT DERIVE, NEVER HAND-EDITED AND NEVER CARRIED. `deriveFormula` reads
  // the window off `saltProduct` on every pass, so a stored bound cannot drift from
  // the table, cannot be lost on a re-save, and cannot be widened except by naming
  // a different product — which changes what the ingredient IS.
  minPercent: z.number().nonnegative().optional(),
  maxPercent: z.number().positive().optional(),
});

// HOW MANY, AND HOW MANY GRAMS EACH — the whole of what a formula declares it
// makes (issue #1274). Always DOUGH weight: "8 × 120 g" is what you scale onto the
// bench, never what comes out of the oven.
//
// It carries no NAME and no LOSS, and that is the point of the rework. A single
// "900 g tin loaf" answered three questions at once — how much dough, what the
// thing is, what it is baked in — so 900 g could be read as the pan, the dough or
// the cooked loaf. The recipe already says it is a ciabatta; the yield does not
// say it again. The baked figure is gone with it: the UK tin convention already
// absorbs oven loss, which is exactly why a 900 g tin yields Warburtons' 800 g
// loaf, so modelling it separately was the same arithmetic twice.
//
// THE WIRE KEYS ARE DELIBERATELY STALE. Documents still say `referenceYield.shape`
// and `unitDoughGrams`, and they stay spelled that way. Zod object schemas strip
// unknown keys, so DELETING `label` and `bakeLossPercent` here parses a stored
// document that still carries them; RENAMING a surviving key would not. The
// TypeScript name moved to `DoughAmount` because a type is not wire.
export const DoughAmountSchema = z.object({
  count: z.number().int().positive(),
  unitDoughGrams: z.number().positive(),
});

// The yield the formula's percentages were derived at — and, passed to
// `solveFormula`, any yield you want them resolved at instead. Both directions of
// the same equation, deliberately one type so neither is privileged:
//   - `target` (bread): "12 × 120 g" of dough — the output is known, solve for basis.
//   - `basis` (ferments, cures): you unwrap the meat, it weighs 2.4 kg.
export const ReferenceYieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('target'), shape: DoughAmountSchema }),
  z.object({ kind: z.literal('basis'), grams: z.number().positive() }),
]);

// WHAT A RUN OF THIS IS AIMING AT (issue #1407, phase 04 of epic #778) — a cure is
// finished when it has lost enough weight, or when it has dropped to a low enough
// pH. Both OPTIONAL and independent: a dry-cured coppa names a weight loss and no
// pH, a fermented salami names both, and bacon — like every cooked thing — names
// neither, which is an ordinary answer rather than a gap.
//
// A NAMING COLLISION, NOTED SO NOBODY TRIPS ON IT. `ReferenceYieldSchema` above
// already carries `kind: \'target\'`, and it means something else entirely — the
// SOLVE DIRECTION, output known, solve for the basis. That one is a nested literal
// inside a discriminated union; this is a sibling field on the formula. They never
// appear in the same position and neither reads the other.
//
// A SINGLE PERCENTAGE, not a 30–40% band. A band renders as two thresholds and a
// "correct window", which is a verdict wearing a range\'s clothes; and "nearing"
// needs one number to be near. Whoever wants 35% types 35. Deliberately unlike
// `StageDurationSchema`\'s range: that range is a claim the RECIPE made about a
// duration the schedule must commit to, where this is a decision the cook makes on
// the day and Salt must not pre-empt it.
//
// IT GATES NOTHING, at any layer. Nothing here or downstream blocks, warns,
// confirms, or decides that a run is finished — see `targetProgress` in the batch
// module, which computes the figure and nothing else.
export const FormulaTargetSchema = z.object({
  // Percent of the STARTING weight lost — 35 for a coppa. Bounded to what is
  // physically possible: a run cannot lose all of itself, so a figure at or past
  // 100 is a typo rather than an intention.
  weightLossPercent: z.number().positive().lt(100).nullable(),
  // "Below pH 5.3". Bounded to the scale that exists, exactly as
  // `BatchObservationSchema.ph` is: a strip or a probe cannot read outside 0–14.
  phAtMost: z.number().min(0).max(14).nullable(),
});

export const FormulaSchema = z.object({
  // Equal to the doc id at `formulas/{recipeId}` when this is eventually stored,
  // the same way `ShoppingDaySchema.date` is.
  recipeId: z.string(),
  components: z.array(FormulaComponentSchema),
  referenceYield: ReferenceYieldSchema,
  // The REFERENCE process (issue #806, phase 2) — the ordered stages this dough
  // goes through, each with a temperature and a duration. OPTIONAL: a formula with
  // no process (a fresh sausage, a cocktail) carries no empty scaffolding, and the
  // same argument that keeps `formulas` out of `recipes` applies one level down.
  //
  // `schemaVersion` STAYS AT 1. `formulas` is greenfield — the collection shipped
  // in phase 1 of this same issue and holds no production data — so an added
  // optional field needs no version bump and no migration. Documents written
  // before it parse unchanged either way.
  //
  // A REFERENCE, not a template: a phase-02 schedule may restructure it (ninety
  // minutes on the counter becoming twenty on the counter and eight in the fridge),
  // and what lands on the batch is the resolved schedule, never this.
  process: ProcessSchema.optional(),
  // WHAT A RUN OF THIS IS AIMING AT, or nothing at all (issue #1407). See
  // `FormulaTargetSchema` above for what it is and what it deliberately is not.
  //
  // `schemaVersion` STAYS AT 1, for the reason `process` above states: `formulas`
  // is greenfield, and an added field with a read default needs no version bump and
  // no migration. A document written before this field parses as a formula that
  // named no target — which is what it meant.
  //
  // THERE IS EXACTLY ONE SPELLING OF "NO TARGET": `null` on this field, never an
  // object of two nulls. Two spellings would mean every reader handling both, and
  // the second one would arrive the first time a screen wrote an object out of
  // habit. The write path is what has to hold that line, so it is pinned there —
  // `apps/web-pwa/tests/FormulaPageTarget.test.ts` (CLAUDE.md rule 12).
  target: FormulaTargetSchema.nullable().default(null),
  schemaVersion: z.literal(1).default(1),
});

export type DensityClass = z.infer<typeof DensityClassSchema>;
export type SaltProduct = z.infer<typeof SaltProductSchema>;
export type FormulaComponent = z.infer<typeof FormulaComponentSchema>;
export type DoughAmount = z.infer<typeof DoughAmountSchema>;
export type ReferenceYield = z.infer<typeof ReferenceYieldSchema>;
export type FormulaTarget = z.infer<typeof FormulaTargetSchema>;
export type Formula = z.infer<typeof FormulaSchema>;
