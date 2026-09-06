// Canon module — re-export the canon module's published surface so that
// adapters and apps can reach it via @salt/domain. Cross-module access
// inside the domain itself goes through './canon' (the module index).
export type {
  CanonItem,
  ShoppingBehavior,
  CanonItemUnit,
  Aisle,
  CanonLocalStorePort,
  AisleLocalStorePort,
  MergeAislesInput,
  MatchLogEntry,
  MatchLoggingPort,
  EmbeddingPort,
  CanonArbitrationPort,
  ArbitrationRequest,
  ArbitrationResult,
} from './canon/index.js';
export {
  normaliseName,
  summarizeMatchLog,
  createCanonItem,
  MatchLogBuilder,
  MATCH_THRESHOLDS,
  findClosestMatch,
  findExactCanonMatch,
  matchOrCreate,
  matchOrCreateBatch,
  ARBITRATION_FAILED_REASONING,
  ARBITRATION_NO_MATCH_REASONING,
  appendCanonSynonym,
  describePendingCanonChange,
  createAisle,
  createAislesBulk,
  renameAisle,
  reorderAisles,
  deleteAisles,
  mergeAisles,
  CANON_ICON_HIDDEN,
  isCanonIconRenderable,
  hasLiveCanonMatch,
  isResolvedMatchState,
} from './canon/index.js';
export type { MatchOrCreateInput, MatchOrCreatePorts, MatchOrCreateResult } from './canon/index.js';
export {
  approveCanonItem,
  renameCanonItem,
  setCanonItemAisle,
  setCanonItemSynonyms,
  setCanonItemShoppingBehavior,
  setCanonItemThreshold,
  setCanonItemThumbnail,
  // The one description of an icon-regeneration write (issue #1054) — the admin
  // screens and the canon/product-form callables are different apps and cannot
  // import each other, so the field set they must agree on lives here.
  iconRegenerationFields,
} from './canon/index.js';
export type { ApproveCanonItemOverrides, IconRegenerationFields } from './canon/index.js';

// ProductForm module — published surface.
export type {
  ProductForm,
  CreateProductFormInput,
  UpdateProductFormInput,
  FormDemand,
  CanonNaming,
  FormNaming,
} from './productForm/index.js';
export {
  createProductForm,
  updateProductForm,
  confirmProductForm,
  setProductFormThumbnail,
  resolveProductForm,
  resolveIngredientProductForm,
  findFormWithSameLabel,
  convertYield,
  formParentCount,
  maxCountWinners,
  aggregateParentCount,
  decideProductFormProposal,
  proposalRejectionReason,
} from './productForm/index.js';

// Auth module — published surface.
export type { User, AuthProvider } from './auth/index.js';

// Equipment module — published surface.
export type {
  Accessory,
  EquipmentItem,
  EquipmentManifest,
  EquipmentManifestPort,
} from './equipment/index.js';
export {
  addEquipment,
  removeEquipment,
  renameEquipment,
  addAccessory,
  removeAccessory,
  setAccessoryOwned,
  addRule,
  removeRule,
  editRule,
  equipmentIconAwaitingApproval,
  // The display-time join from a free-text kit label to the item this household
  // actually owns (issue #954) — the specific half of the question
  // `resolveKitchenTool` answers generically. Tried FIRST by the callers of both:
  // a branded name contains generic tokens ("…Slow Cook Pot"), so the tool
  // vocabulary would otherwise claim it.
  resolveEquipmentItem,
} from './equipment/index.js';

// Shopping list module — published surface.
export type {
  ShoppingList,
  ShoppingListItem,
  MatchState,
  SourceRef,
  ShoppingListsConfig,
  AmountSubtotal,
  AisleRow,
  AisleGroup,
  ParsedEntry,
  EntryParsePort,
} from './shoppingList/index.js';
export {
  createList,
  renameList,
  deleteList,
  setDefaultList,
  addItem,
  editItemRawText,
  editItemNotes,
  editItemAmountUnit,
  setItemChecked,
  confirmItemNeeded,
  setItemNeedsCheck,
  deleteItem,
  clearCheckedItems,
  moveItems,
  groupItemsByAisle,
  groupItemsByRecipe,
  resolveItemDisplayName,
  isRecipeSourced,
  recipeItemAddDefault,
  parseShoppingListEntry,
} from './shoppingList/index.js';

// Members module — published surface (issue #155).
export type { Member, CookMode, UpdateMemberPatch } from './members/index.js';
export {
  normaliseMemberEmail,
  createMember,
  updateMember,
  memberInitials,
  memberFirstName,
  sortMembers,
} from './members/index.js';

// Meal planning module — published surface (issue #169).
export type {
  Weekday,
  Attendee,
  Day,
  MealPlanConfig,
  MealPlanTemplate,
  MealPlanWeek,
} from './mealPlan/index.js';
export {
  WEEKDAYS,
  weekStartFor,
  weekDates,
  weekdayOf,
  dayIndexInWeek,
  weekExtendsIntoNext,
  WEEK_EXTENSION_DAYS,
  templateWeekStarts,
  emptyDay,
  emptyWeek,
  emptyTemplate,
  instantiateWeek,
  setDayNote,
  setDayChefs,
  setDayRecipes,
  setDayGuests,
  addAttendee,
  removeAttendee,
  setAttendeeHomeTime,
  setAttendeeNote,
  latestHomeTimeFor,
} from './mealPlan/index.js';

// Recipe module — published surface (issue #179).
export type {
  Quantity,
  ParsedIngredient,
  Ingredient,
  IngredientGroup,
  Step,
  Recipe,
  RecipeKind,
  RecipeMetadata,
  RecipePhase,
  RecipePhaseStrip,
  AuthorableRecipeKind,
} from './recipe/index.js';
export {
  emptyRecipe,
  duplicateRecipe,
  emptyIngredientGroup,
  newIngredient,
  newStep,
  clearIngredientMatch,
  // The one tag normalisation (issue #1054) — the recipe editor and the
  // authoring flows are different apps and cannot import each other.
  normaliseTags,
  // The one `total >= prep + cook` reconciliation (issue #1116) — the authoring
  // flows and the re-estimate trigger had a copy each, and they disagreed.
  // The one merge of a fresh phase strip against a stored one (issue #1122
  // review) — the strip and its summary move together, or not at all.
  reconcileRecipePhases,
  flattenIngredients,
  quantityToNumber,
  usableServings,
  ingredientMatchIssue,
  recipeMatchIssueCount,
  takesIngredients,
  isCookable,
  isPlannable,
  isAuthorable,
  takesComponents,
  // The kinds the librarian may write (issue #765) — read off the capability
  // table, and what bounds the `kind` the AI authoring schemas accept.
  AUTHORABLE_RECIPE_KINDS,
  // The one place a recipe's phases are added up (issue #1122). Every timing
  // figure in the app is this sum at the point of use; none is stored.
  recipePhaseTotals,
  phaseElapsedMinutes,
  hasComponents,
  resolveComponents,
  componentDisplayLines,
  canBeComponentOf,
  insertComponentByElapsedTime,
  expandForPlanner,
  mergePlannerRecipeIds,
  kitByStep,
  groupKitByEquipment,
  findProducingRecipes,
  // Keyword search over the library (issue #840) — what the chef's findRecipes
  // tool ranks with, once the CF has done the projected read.
  searchRecipes,
  RECIPE_SEARCH_DEFAULT_MAX_RESULTS,
  RECIPE_SEARCH_RESULT_CEILING,
  diffRecipe,
  diffWords,
  unchangedRatio,
  hasRecipeChanged,
  pickPlaceholder,
  PLACEHOLDER_MOODS,
  PLACEHOLDER_CONDITION_TAGS,
} from './recipe/index.js';
export type { RecipeSearchCandidate, RecipeSearchFilters } from './recipe/index.js';
export type { RecipePhaseTotals } from './recipe/index.js';
export type { KitEquipmentGroup } from './recipe/index.js';
export type { PlaceholderMood, PlaceholderCondition } from './recipe/index.js';
export type { DiffPart } from './recipe/index.js';
export type { NullableStringChange, StepChange, RecipeDiff } from './recipe/index.js';
export { parseImportUrl, isHttpsScheme, hostnameAsIpLiteral, isPublicIp } from './recipe/index.js';

// Weather module — pure forecast aggregation + staleness logic (Phase 2) and
// pure render-policy classifiers (Phase 3) (issue #382).
export { aggregateForecastWindow, isForecastStale } from './weather/index.js';
export { temperatureBand, classifyEatingMood } from './weather/index.js';
export type { TemperatureBand, EatingMood } from './weather/index.js';
export { weatherIcon } from './weather/index.js';
export type { WeatherIconId } from './weather/index.js';

// Cook-session module — pure cook-mode session state: mise ticking, step
// completion, timers, clock formatting (issue #556). Immutable producers, and
// every timestamp is injected (never read from a clock). The recipe-drift
// comparison it used to own now lives in the recipe module (`hasRecipeChanged`),
// which the guided plan (#751) shares. The four container/amount queries below
// are what keeps guided mode from ever showing less than plain cook mode (#761),
// and `guidedContainerProblems` is that same join read backwards, so the editor
// can warn about a name that will not resolve before anyone cooks from it.
// `guidedPrepBoard` reads it a third way — as the shape of the prep screen itself
// (issue #767), where the container leads a card and the ingredients under it are
// what the cook ticks. `nextStepLookahead` is what the plan says about the step
// BELOW the one on screen (issue #769), in place of plain cook mode's faded first
// clause.
export {
  makeFreshSession,
  cookSessionId,
  withStepDone,
  withIngredientChecked,
  withPrepChecked,
  withAllIngredientsChecked,
  withGroupChecked,
  withTimerStarted,
  withTimerDismissed,
  checkInTimerId,
  isCheckInTimerId,
  isCheckInOf,
  firstUseByStep,
  firstIncompleteStepId,
  miseProgress,
  progressOver,
  guidedPrepBoard,
  guidedMiseProgress,
  guidedPrepCardProgress,
  prepEntryForContainer,
  prepEntryIngredients,
  looseIngredientsForStep,
  guidedContainerProblems,
  nextStepLookahead,
  formatClock,
  timerProgress,
  timerHeat,
  heatWantsAttention,
  scheduleFor,
} from './cookSession/index.js';
export type { TimerHeat, GuidedPrepTickRow } from './cookSession/index.js';

// Kitchen-timer module (issue #842) — a timer that belongs to nobody's cook.
// Its own two-line module rather than more surface on the cook-session one:
// nothing here reads a session, and a standalone timer's whole point is that
// there is no cook to hang it on.
export { withKitchenTimerStarted, withKitchenTimerDismissed } from './kitchenTimer/index.js';

// Push-subscription id (issue #1145) — `${uid}_${deviceHash}`, composed in one
// place so the enable/disable call sites in web-pwa cannot drift apart.
export { pushSubscriptionId } from './pushSubscription/index.js';

// Kitchen-tool module (issue #882) — the curated pictogram vocabulary, and the
// pure lookup that turns a cook's own words ("Magmix bowl", "large frying pan")
// into a tool at DISPLAY time. Nothing persists that answer, so the commands here
// curate the VOCABULARY and never touch a recipe or a plan; `unresolvedKitLabels`
// is the read that says which words our content already uses and nothing draws,
// and `suggestKitchenToolParent` is the advisory hint that keeps curating that
// list from minting a second drawing of an object the vocabulary already has.
//
// `instanceNamedKitchenTools` and `kitchenToolSlug` are here for the offline
// curation tools rather than the app (issue #956): the seed table's test asserts
// the first returns nothing and that every row's id is the second of its label,
// and `scripts/prune-instance-named-kitchen-tools.ts` runs the first over the
// live collection. Both are pure, and neither is a second way to identify a tool
// — `kitchenToolSlug` is the one `createKitchenTool` already mints with.
export {
  resolveKitchenTool,
  unresolvedKitLabels,
  suggestKitchenToolParent,
  instanceNamedKitchenTools,
  createKitchenTool,
  updateKitchenTool,
  kitchenToolSlug,
} from './kitchenTool/index.js';
export type {
  CreateKitchenToolInput,
  UpdateKitchenToolInput,
  InstanceNamedKitchenTool,
} from './kitchenTool/index.js';

// Shopping-day module (issue #629) — pure helpers over `shoppingDays/{date}`:
// the planner's pre-shop shading predicate, the reminder's "tomorrow in zone"
// projection, and the one-shop-per-week reducer. No I/O, no clock.
//
// `dateInZone` was the one of the four the module barrel exported and this one
// did not, and that omission had a cost: five call sites in `web-pwa` wrote
// `new Date().toLocaleDateString('en-CA')` out again rather than import the rule
// (issue #933). It is the same projection with the zone named rather than
// implied, so the caller supplies both the instant and the zone — Rule 1 keeps
// the clock out of here.
export {
  dateInZone,
  addCalendarDays,
  daysBetween,
  tomorrowInZone,
  shopDayForWeek,
  // The one rendering of "Shopping today AM" (issue #1054) — the shopping list
  // and the daily push reminder are different apps and cannot import each
  // other, so the sentence they must agree on lives here.
  shopDayHeadline,
} from './shoppingDay/index.js';
export type { ShopDayHeadlineInput } from './shoppingDay/index.js';

// Personal-view module (issues #634, #682, #755) — the projections behind
// "Kitchen": which nights from today onward are yours to cook, across however
// many week documents the caller is holding. Pure, no per-user storage and no
// clock.
export { upcomingChefDays, dayForDate } from './personalView/index.js';
// Kitchen-memory module (issue #816) — reading a composer line as the one chat
// command the app has. Pure string work by design: capture involves no AI at all.
export { parseChatCommand } from './memory/index.js';
// Chat module (issue #1270) — the one place a chat's read-only state is decided.
export { isChatReadOnly, CHAT_READ_ONLY_AFTER_MS } from './chat/index.js';
// Formula module (issue #782, epic #778) — composition as ratios against a
// declared basis, and the bidirectional yield solve. Headless: nothing renders it
// and nothing stores it yet, but the surface is what phase 01 is built against.
export {
  roundGrams,
  roundPercent,
  gramsFromParsed,
  deriveFormula,
  guessBasisIngredientIds,
  looksScalable,
  solveFormula,
  UNIT_SHAPE_PRESETS,
  DEFAULT_BAKE_LOSS_PERCENT,
  unitShapePreset,
  unitShapeFromPreset,
  bakedUnitGrams,
  targetYield,
  withComponentPercentScaled,
  LEAVENING_PERCENT_BOUNDS,
} from './formula/index.js';
export type { BoundViolation, FormulaFailure, UnitShapePreset } from './formula/index.js';

// Process module (issues #806, #812) — ordering, total duration, the bidirectional
// schedule that places an ordered process on a clock from either end, and the diff
// that makes a proposed restructure reviewable, plus which stages earn a reminder.
// Still no clock of its own: the anchor is injected, `diffProcess` takes both sides
// as arguments, and `remindableStages` reads only the shape of the process.
export {
  withStageAdded,
  withStageRemoved,
  withStageUpdated,
  withStageMoved,
  totalDurationMinutes,
  resolveSchedule,
  diffProcess,
  remindableStages,
} from './process/index.js';
export type {
  ScheduleAnchor,
  ProcessStageDiffEntry,
  ProcessStageChange,
  ProcessDiff,
} from './process/index.js';

// Batch module (issue #812, epic #778) — one run of a formula: the freeze that
// starts it, and the producers that move it along. Pure; every instant injected.
export { freezeBatch, currentStage, withStageAdvanced, withBatchAbandoned } from './batch/index.js';
export type { FreezeBatchFailure } from './batch/index.js';

// URL module — pure display-time cache-buster for regenerated image URLs (#460).
export { appendCacheBuster, recipeHeroUrl, type HeroImageSource } from './url/index.js';

// Cross-cutting ports.
export type { ErrorReportingPort } from './ErrorReportingPort.js';
