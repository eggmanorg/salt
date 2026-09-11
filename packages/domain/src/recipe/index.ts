// Recipe module — published surface (issue #179).
// This file is the ONLY thing other domain modules and adapters import from
// recipe. Anything not re-exported here is private. See docs/recipe-module.md.

export type { Quantity } from './entities/Quantity.js';
export type {
  MatchState,
  ParsedIngredient,
  Ingredient,
  IngredientGroup,
} from './entities/Ingredient.js';
export type { Step, StepTimer } from './entities/Step.js';
export type { Recipe, RecipeKind, RecipeMetadata, RecipePhase } from './entities/Recipe.js';

export {
  emptyRecipe,
  duplicateRecipe,
  emptyIngredientGroup,
  newIngredient,
  newStep,
} from './commands/builders.js';
export { clearIngredientMatch } from './commands/clearIngredientMatch.js';
// The one tag normalisation (issue #1054) — the recipe editor and the authoring
// flows are different apps that cannot import each other, so the rule that
// decides what a typed or generated tag becomes lives here.
export { normaliseTags } from './commands/normaliseTags.js';
// The one merge of a fresh phase strip against a stored one (issue #1122
// review) — the strip and its one-line summary move together, or not at all.
export { reconcileRecipePhases } from './commands/reconcileRecipePhases.js';
export type { RecipePhaseStrip } from './commands/reconcileRecipePhases.js';
export { flattenIngredients } from './queries/ingredients.js';
// The ONE numeric reduction of a `Quantity` (issue #917) — shared by the shopping
// list and the formula mapping screen so a range cannot mean two amounts. The
// choice of which end a range collapses to is argued in the file, once.
export { quantityToNumber } from './queries/quantity.js';
// The DRAWING half of scaling an amount (issue #1314) — rounds a scaled quantity
// to a figure somebody can weigh or count. Deliberately separate from the BUYING
// half in `buildRecipeAddPlan`, which stays at full float precision; the file
// header argues why routing one through the other rounds twice.
export { scaleQuantity } from './queries/scaleQuantity.js';
// The ONE rule for whether a recipe's own servings count can be a scaling base
// (issue #1123) — the plan builder and the review sheet both read it, and a 0
// that reached either divided a shopping list by zero.
export { usableServings } from './queries/servings.js';
// Silent match problems — a line that reads as matched and buys the wrong thing
// (or nothing). Shared by the recipe list's pip and the ingredient match sheet so
// the two can never disagree about what counts as wrong.
export { ingredientMatchIssue, recipeMatchIssueCount } from './queries/matchIssues.js';
export type { IngredientMatchIssue } from './queries/matchIssues.js';
export {
  takesIngredients,
  isCookable,
  isPlannable,
  isAuthorable,
  takesComponents,
  // The kinds the librarian may WRITE, derived from the capability table (issue
  // #765). Exported as a value because the AI output schemas bound their `kind`
  // field to it — the one place that decides what a model may mint.
  AUTHORABLE_RECIPE_KINDS,
} from './queries/capabilities.js';
export type { AuthorableRecipeKind } from './queries/capabilities.js';
export { recipePhaseTotals, phaseElapsedMinutes } from './queries/recipePhaseTotals.js';
export type { RecipePhaseTotals } from './queries/recipePhaseTotals.js';
// Meals — a recipe built from several other recipes (issue #752). One level deep,
// nothing aggregated; see the module header.
export {
  hasComponents,
  resolveComponents,
  componentDisplayLines,
  canBeComponentOf,
  insertComponentByElapsedTime,
  expandForPlanner,
  mergePlannerRecipeIds,
} from './queries/components.js';
// Recipe-drift comparison, shared by everything that snapshots a recipe's
// `updatedAt`: the cook session (#556) and the guided plan (#751).
export { hasRecipeChanged } from './queries/hasRecipeChanged.js';
// The same question asked of a BATCH, which stores no snapshot stamp and so needs
// an ordering rather than an inequality (issue #1327).
export { recipeChangedSince } from './queries/recipeChangedSince.js';
// Which step each piece of kit should be DRAWN at (issue #882) — the
// contiguous-run rule, shared by the method column, the cook deck and the guided
// step screen so the three cannot disagree about when the pan comes out.
export { kitByStep } from './queries/kitByStep.js';
// Which pieces of kit belong UNDER another one (issue #1140) — the Equipment
// tab's display order, with an accessory folded under the appliance it came in
// the box with, and never under one this recipe did not ask for.
export { groupKitByEquipment } from './queries/groupKitByEquipment.js';
export type { KitEquipmentGroup } from './queries/groupKitByEquipment.js';
export { findProducingRecipes } from './queries/producers.js';
// Keyword search over the library (issue #840) — the ranking half of the chef's
// findRecipes tool. Pure; the Cloud Function does the projected Firestore read
// and nothing else.
export {
  searchRecipes,
  RECIPE_SEARCH_DEFAULT_MAX_RESULTS,
  RECIPE_SEARCH_RESULT_CEILING,
} from './queries/searchRecipes.js';
export type { RecipeSearchCandidate, RecipeSearchFilters } from './queries/searchRecipes.js';
export { diffRecipe } from './queries/diffRecipe.js';
// The diff's own contract, beside the function that produces it since #973 (it
// was zod in `schemas/` until then, and validated nothing). Only the three names
// with importers are re-exported; the rest of the shape stays internal to the
// file, exactly as `schemas/index.ts` exposed three of thirteen before.
export type { NullableStringChange, StepChange, RecipeDiff } from './queries/recipeDiff.js';
// One level below diffRecipe: what moved INSIDE a changed field, so the review
// gate can show a reword as the words that differ (issue #825).
export { diffWords, unchangedRatio } from './queries/diffWords.js';
export type { DiffPart } from './queries/diffWords.js';
export {
  pickPlaceholder,
  PLACEHOLDER_MOODS,
  PLACEHOLDER_CONDITION_TAGS,
} from './queries/pickPlaceholder.js';
export type { PlaceholderMood, PlaceholderCondition } from './queries/pickPlaceholder.js';

// URL import — pure SSRF/URL classification helpers (no I/O). The live fetch +
// DNS resolution lives in cloud-functions; this module only holds the policy.
export type { ParsedImportUrl, IpClass } from './urlImport/index.js';
export {
  parseImportUrl,
  isHttpsScheme,
  hostnameAsIpLiteral,
  classifyIp,
  isPublicIp,
  isIpv4,
  isIpv6,
} from './urlImport/index.js';
