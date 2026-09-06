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

export const FormulaComponentSchema = z.object({
  // FK into the recipe's `ingredients[].id`.
  ingredientId: z.string(),
  // Of the BASIS total, not of the whole. Basis members' own percentages sum to
  // 100 by definition, so a 176.4% grand total is normal and correct.
  percent: z.number().nonnegative(),
  inBasis: z.boolean(),
  density: DensityClassSchema.optional(),
  // The bound seam. Declared per component and enforced generically by the
  // solve, which REFUSES rather than extrapolates — phase 04's nitrite limits are
  // the load-bearing customer, and that must not be a decision a screen can be
  // talked out of. No bound VALUE is set anywhere in this phase.
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
  schemaVersion: z.literal(1).default(1),
});

export type DensityClass = z.infer<typeof DensityClassSchema>;
export type FormulaComponent = z.infer<typeof FormulaComponentSchema>;
export type DoughAmount = z.infer<typeof DoughAmountSchema>;
export type ReferenceYield = z.infer<typeof ReferenceYieldSchema>;
export type Formula = z.infer<typeof FormulaSchema>;
