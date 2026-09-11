import {
  subscribeRecipes,
  saveRecipe as saveRecipeDoc,
  deleteRecipe as deleteRecipeDoc,
  callParseRecipeIngredients,
  callCanonicaliseRecipeIngredients,
  callExtractRecipeFromUrl,
  callExtractRecipeFromPhoto,
  callAuthorRecipe,
  callDescribeRecipeScene,
  callRegenerateRecipeImage,
  callRedoRecipeKit,
  callSetRecipeImageUpload,
  saveShoppingListItem,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter, startUserActionSpan } from '@salt/observability';
import type { AuthorRecipeInput, DescribeRecipeSceneInput, RecipeDoc } from '@salt/domain/schemas';
import { reportIfFailed, reportSubscriptionError, reportWriteError } from './errorReporting.js';
import {
  addItem,
  recipeItemAddDefault,
  findProducingRecipes,
  insertComponentByElapsedTime,
  resolveComponents,
  componentDisplayLines,
  resolveProductForm,
  formParentCount,
  convertYield,
  maxCountWinners,
  aggregateParentCount,
  quantityToNumber,
  usableServings,
} from '@salt/domain';
import type {
  Recipe,
  Ingredient,
  IngredientGroup,
  SourceRef,
  ProductForm,
  CanonItemUnit,
  FormDemand,
  CanonNaming,
} from '@salt/domain';
import type {
  UrlImportFailureCode,
  PhotoImportFailureCode,
  UrlImportFailure,
  PhotoImportFailure,
  RecipePagePhoto,
} from '@salt/domain/schemas';
import { isImportError } from '@salt/domain/schemas';
import { hasLiveCanonMatch } from '@salt/domain';
import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { currentMember } from './membersService.js';
import { getCanonItemsSnapshot } from './canonService.js';
import { canonIndex } from './canonIndex.js';
import { getProductFormsSnapshot } from './productFormService.js';
import { createWriteCoalescer } from './writeCoalescer.js';
import { writable, derived, get } from 'svelte/store';
import type { Readable } from 'svelte/store';

// Recipe service (issue #179, Phase 2). An optimistic store over the Phase 1
// firebase-sync adapter: the whole `recipes` collection is subscribed once and
// held in memory; saves/deletes update the store immediately and persist the
// whole document (whole-document LWW on `updatedAt`). See docs/recipe-module.md.

// ─── Reactive stores ──────────────────────────────────────────────────────────

const _recipes = writable<readonly Recipe[]>([]);
export const recipes: Readable<readonly Recipe[]> = _recipes;

/**
 * The same recipes, indexed by id (issue #940, Phase 3).
 *
 * Resolving a plan's `recipeIds` used to be `recipes.find(...)` per id, per row,
 * re-run on every week snapshot — O(rows × ids × |recipes|) over a store that
 * holds the whole house's recipes. The index is derived, so it is rebuilt once
 * per change to `recipes` and shared by every consumer, rather than per
 * component.
 *
 * ADDED beside the array, never replacing it: `recipes` has consumers outside
 * the planner that genuinely want a list — the pickers, the recipe list page.
 * Mirrors `membersService`'s `byId` construction, which exists for this reason.
 */
export const recipesById: Readable<ReadonlyMap<string, Recipe>> = derived(
  _recipes,
  (list) => new Map(list.map((r) => [r.id, r])),
);

// Synchronous snapshot of the recipes store. Used by the e2e bridge to assert
// the parsed/canonical ingredient structure that lives in the store but is only
// partially surfaced in the DOM. Mirrors getShoppingListItems / getCanonItem.
export function getRecipesSnapshot(): readonly Recipe[] {
  return get(_recipes);
}

const _isLoadingRecipes = writable(true);
export const isLoadingRecipes: Readable<boolean> = _isLoadingRecipes;

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Snapshot guard ─────────────────────────────────────────────────────────────
// Newest `updatedAt` we've applied locally per recipe id (from an optimistic
// write or an accepted snapshot). Guards against an in-flight stale snapshot
// echo landing after a newer local edit and reverting it — same pattern as the
// other optimistic stores. A local delete records `now` so a stale echo that
// still contains the doc can't resurrect it.
const latestLocalEdit = new Map<string, string>();

function applySnapshot(incoming: Recipe[]): void {
  const currentById = new Map(get(_recipes).map((r) => [r.id, r]));
  const result: Recipe[] = [];
  const seen = new Set<string>();
  for (const r of incoming) {
    seen.add(r.id);
    const local = latestLocalEdit.get(r.id);
    if (local !== undefined && r.updatedAt < local) {
      // Stale echo: prefer our newer optimistic copy; if we deleted it locally
      // (no current copy), drop it rather than resurrecting the old doc.
      const ours = currentById.get(r.id);
      if (ours) result.push(ours);
      continue;
    }
    if (r.updatedAt) latestLocalEdit.set(r.id, r.updatedAt);
    result.push(r);
  }
  // Keep optimistic creates not yet echoed by the snapshot.
  for (const [id, r] of currentById) {
    if (!seen.has(id) && latestLocalEdit.has(id)) result.push(r);
  }
  _recipes.set(result);
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

export function initRecipeSync(): () => void {
  _isLoadingRecipes.set(true);
  const errors = getErrorReporter();
  const unsub = subscribeRecipes(
    (incoming) => {
      applySnapshot(incoming);
      _isLoadingRecipes.set(false);
    },
    (err, rawError) => {
      reportSubscriptionError(errors, err, rawError);
      _isLoadingRecipes.set(false);
    },
  );
  return unsub;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// Stamp attribution (issue #845). The ONE implementation, and exported because
// the two chat write paths (`chatRecipeAuthor`, `recipeAmend`) go to
// `saveRecipeDoc` directly rather than through `persistRecipe` — three surfaces
// stamping their own would be three chances to forget one, exactly as
// `createdAt`/`updatedAt` are stamped once per path and no more.
//
// `lastEditedBy` on every write, `createdBy` only when it is still blank: a
// recipe is added once and edited forever, so `createdBy` is fill-once and is
// never re-pointed at a later editor. This is the service layer's job because
// `packages/domain` knows no user, and the name is a snapshot of
// `Member.name` taken at write time — audit only, never a gate.
//
// No name available — the roster hasn't loaded, or the signed-in email isn't on
// it — leaves BOTH fields exactly as they were. A placeholder ("Unknown",
// "Someone") would be a value people read as a person; `''` already means "no
// attribution on record", and clobbering a real creator with a placeholder
// because a store hadn't settled is worse than recording nothing.
export function stampRecipeAttribution(recipe: Recipe): Recipe {
  const name = get(currentMember)?.name ?? '';
  if (!name) return recipe;
  return { ...recipe, createdBy: recipe.createdBy || name, lastEditedBy: name };
}

// Stamp updatedAt + attribution and update the store optimistically —
// SYNCHRONOUSLY. Split out of `persistRecipe` by issue #1319 so the coalesced
// path below can share it: only the `setDoc` is ever deferred, never the apply.
// Every in-place editor rebuilds the whole recipe from the store copy it is
// rendering, so a deferred apply would let two edits to different fields both
// build on the same stale document and the second silently discard the first.
//
// The edited recipe keeps its POSITION in the store rather than being moved to
// the end, which is what the filter-and-append this replaced used to do. That
// never mattered while a save was one deliberate tap; with a keystroke-rate
// writer in front of it, a list re-ordering under the reader on every character
// would be the visible cost of a detail that carries nothing.
function applyRecipeOptimistically(recipe: Recipe): Recipe {
  const stamped: Recipe = stampRecipeAttribution({
    ...recipe,
    updatedAt: new Date().toISOString(),
  });
  latestLocalEdit.set(stamped.id, stamped.updatedAt);
  const all = get(_recipes);
  const known = all.some((r) => r.id === stamped.id);
  _recipes.set(known ? all.map((r) => (r.id === stamped.id ? stamped : r)) : [...all, stamped]);
  return stamped;
}

// Stamp, apply optimistically, then persist the whole doc — immediately.
export async function persistRecipe(recipe: Recipe): Promise<ReadResult<void, DomainError>> {
  const stamped = applyRecipeOptimistically(recipe);
  return reportIfFailed(getErrorReporter(), await saveRecipeDoc(stamped));
}

// ─── Coalesced edits (issue #1319) ──────────────────────────────────────────
// Editing a recipe in place writes at KEYSTROKE rate, so the recipe write gets
// the same debounced writer the meal planner already uses (`./writeCoalescer.ts`,
// promoted out of `mealPlanService.ts` for this): a burst of typing becomes one
// full-document `setDoc`, which is the granularity document-level LWW already
// works at.
//
// `persistRecipe` is unchanged and stays IMMEDIATE. Every existing caller is one
// deliberate tap — a match saved, a dish attached to a meal, a review flag
// cleared — so there is no burst to merge, and deferring one would mean a reload
// inside the window silently discards a finished act. Only `queueRecipeEdit`
// coalesces, and only the in-place editors call it. That is the same split the
// planner drew, for the same reason.
//
// This SHRINKS the window the old editor opened rather than widening it: that
// page cloned the recipe once on load and wrote it back minutes later over
// anything a trigger or another phone had written meanwhile. Sub-second is
// strictly better than open-ended, and `applySnapshot`'s echo guard above is
// unchanged and still rejects a snapshot older than the local optimistic write.
const recipeWrites = createWriteCoalescer(async (recipe: Recipe) =>
  reportIfFailed(getErrorReporter(), await saveRecipeDoc(recipe)),
);

/**
 * Queue an in-place recipe edit. The store is updated synchronously; the write
 * lands at the end of the debounce window, or sooner if something flushes it.
 *
 * The returned promise is the write that will carry this edit, so a caller keeps
 * the `ReadResult` its failure toast needs (Rule 10) — and every edit in one
 * window shares one promise, so a burst raises at most one toast.
 */
export function queueRecipeEdit(recipe: Recipe): Promise<ReadResult<void, DomainError>> {
  const stamped = applyRecipeOptimistically(recipe);
  return recipeWrites.queue(stamped.id, stamped);
}

/**
 * Write out every pending recipe edit now.
 *
 * Called when a field is left and when edit mode ends: the debounce alone would
 * lose the last edit when the page is navigated away from inside its window, and
 * blur alone never fires for `page.fill()` in the e2e. Both, not either. The tab
 * going away is covered by `writeCoalescer`'s own `pagehide`/`visibilitychange`.
 */
export function flushRecipeWrites(): Promise<void> {
  return recipeWrites.flushAll();
}

/** Drop pending recipe writes without issuing them — test teardown only. */
export function discardPendingRecipeWrites(): void {
  recipeWrites.discardAll();
}

// Hang a dish off a meal (issue #752, Phase 3). The one write behind "start a
// recipe FROM a meal": whichever of the four create paths produced `componentId`,
// this is what makes it part of the dinner.
//
// The meal is read from the IN-MEMORY store — it is subscribed app-wide, so this
// costs no extra Firestore read and needs no `getDoc`. A miss is the honest
// outcome, not an assertion failure: the meal can have been deleted on another
// device while the user was off writing the dish. It crosses as `NotFound` rather
// than throwing (Rule 10), and the caller's job is to keep the saved recipe —
// which is already safe on the server — rather than to strand it.
//
// Ordering and the self/duplicate guards belong to the domain, so the new array
// comes from `insertComponentByElapsedTime` rather than a push: the dish lands where
// the cook would start it (longest-cooking first), attaching a meal to itself is
// refused, and a second attach of the same dish is a no-op. That last property is
// what makes this IDEMPOTENT BY CONSTRUCTION — re-saving an editor that still
// carries `?meal=` attaches once, so the save path needs no "have I already done
// this" flag.
//
// Persisted through `persistRecipe`, i.e. a whole-document write under LWW —
// the established contract for every recipe write in the app.
export async function attachComponentToMeal(
  mealId: string,
  componentId: string,
): Promise<ReadResult<void, DomainError>> {
  const all = get(_recipes);
  const meal = all.find((r) => r.id === mealId);
  if (meal === undefined) return failure({ kind: 'NotFound', resource: 'recipe', id: mealId });
  return persistRecipe({
    ...meal,
    componentRecipeIds: insertComponentByElapsedTime(
      mealId,
      meal.componentRecipeIds,
      componentId,
      all,
    ),
  });
}

export async function parseIngredients(
  rawText: string,
): Promise<ReadResult<IngredientGroup[], DomainError>> {
  return callParseRecipeIngredients(rawText);
}

// ─── Hero image (issue #148, Tier-2) ────────────────────────────────────────────
// The photoreal hero is generated server-side by the onRecipeWritten trigger on
// create. These two commands are the manual controls.

// Regenerate (or first-time generate) the hero via the auth-gated callable. The
// callable clears `image` and bumps the nonce, re-firing the trigger; the new URL
// arrives via the recipe subscription. Deliberately a
// callable, not an optimistic store write — a client whole-document write would
// risk clobbering the trigger's image write (whole-document LWW).
//
// `brief` is the art direction the next image is generated from: the caller (the
// RecipeViewPage regenerate dialog) pre-fills it from the recipe's saved
// `imageBrief` and hands back whatever the user edited it to. The callable stamps
// it onto `imageBrief`, the trigger uses it verbatim and re-saves it on success —
// so each regenerate starts where the last one ended. Omitted means "no brief",
// and the trigger authors one.
export async function regenerateRecipeImage(
  recipeId: string,
  brief?: string,
): Promise<ReadResult<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await callRegenerateRecipeImage(recipeId, brief));
}

// Re-ask what kit this dish needs (issue #882). The callable clears the inference
// stamp and bumps the nonce, and the onRecipeWritten kit branch does the work, so the
// new list arrives on the recipe subscription like any other server write —
// nothing here is optimistic, and the old list stays on screen until it does.
export async function redoRecipeKit(recipeId: string): Promise<ReadResult<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await callRedoRecipeKit(recipeId));
}

// ─── Scene brief (issue #522, Phase 3) ─────────────────────────────────────────
// Ask the text model for the art-direction brief WITHOUT committing to an image.
// Nothing is persisted: the brief comes back to the dialog for the user to read
// and edit, and only reaches Firestore if they then press Regenerate. That split
// is the whole economics of the feature — a brief costs a fraction of a cent, an
// image costs orders of magnitude more, so you fix the art direction first and pay
// for one render instead of three.

// Flatten a Recipe to the flow's input. Mirrors the trigger's own flattening
// (onRecipeWritten.describeSceneOrNothing) so a brief authored from the dialog and
// a brief authored by the trigger read the SAME recipe — the ingredient groups
// collapse to their display lines because the flow wants the dish's content, not
// its grouping.
//
// A meal's components (issue #838) are the one part the two sides resolve
// DIFFERENTLY and must still render identically: the trigger has no in-memory
// store and reads them from Firestore, this resolves them against the store the
// app already subscribes to (zero extra reads). Both then hand the resolved
// recipes to the SAME `componentDisplayLines`, which is why that helper lives in
// `@salt/domain` rather than being written out at either call site — the
// identical-flattening property is structural, not a comment either side can
// drift away from.
function sceneInputFor(recipe: Recipe): DescribeRecipeSceneInput {
  return {
    title: recipe.title.trim(),
    description: recipe.description,
    // The kind selects the art director's brief entirely (issue #637): without
    // it a hand-revised outing brief would be revised with the RECIPE revision
    // prompt — asked for the blistered top and the torn basil of a dish that has
    // no method and no ingredients. Carried on both brief actions, so the
    // Regenerate dialog and the write trigger reason about the same entry.
    kind: recipe.kind,
    // Carried for the same reason the trigger carries them: a placeholder's mood
    // is an ordinary tags entry, and without it the art director is asked to read
    // a mood it was never given. Sending them here too keeps a brief authored
    // from the dialog identical to one authored by the write trigger.
    tags: recipe.metadata.tags,
    ingredients: recipe.ingredients.flatMap((g) => g.items.map((i) => i.rawText)),
    steps: recipe.steps.map((s) => s.text),
    // One level, dangling ids skipped — `resolveComponents` semantics, which the
    // trigger's Firestore reader deliberately reproduces. A recipe that is not a
    // meal yields [] and the flow sends exactly the prompt it always sent.
    components: componentDisplayLines(resolveComponents(recipe, get(_recipes))),
  };
}

// Shared span + call plumbing for both brief actions. Browser-ROOT span (issue
// #362, Phase 4) exactly as importRecipeFromUrl/authorRecipeTraced: the trace
// originates at the click and the CF + AI sub-tree nests under the same trace id.
// Best-effort — an inert tracer yields a no-op span and an empty traceparent, so
// the call behaves as a bare callable. Returns the brief itself: the wrapper
// object exists only for Genkit's structured output, and no caller wants it.
async function describeScene(
  input: DescribeRecipeSceneInput,
  spanName: string,
): Promise<ReadResult<string, DomainError>> {
  const span = startUserActionSpan(spanName);
  const child = span.child('callDescribeRecipeScene');
  try {
    const result = await callDescribeRecipeScene(input, span.traceparent || undefined);
    child.end();
    if (result.kind !== 'ok') {
      span.setAttribute('brief.outcome', result.error.kind);
      span.setError();
      return reportIfFailed(getErrorReporter(), result);
    }
    span.setAttribute('brief.outcome', 'ok');
    return success(result.value.brief);
  } finally {
    span.end();
  }
}

// Revise an existing brief by a one-line steer ("make it summery"). The recipe
// goes along with the brief and the hint — a revision stays anchored to the actual
// dish rather than drifting while the model edits prose about it.
export async function reviseRecipeSceneBrief(
  recipe: Recipe,
  currentBrief: string,
  hint: string,
): Promise<ReadResult<string, DomainError>> {
  return describeScene(
    { ...sceneInputFor(recipe), currentBrief: currentBrief.trim(), hint: hint.trim() },
    `Revise scene brief: ${recipe.title.trim()}`,
  );
}

// Start over: author a brief from a fresh reading of the CURRENT recipe, sending
// neither the accumulated brief nor any steer. This is the escape hatch for a
// sticky brief — a recipe you have since substantially rewritten would otherwise
// keep art direction describing the dish it used to be, forever.
export async function startOverRecipeSceneBrief(
  recipe: Recipe,
): Promise<ReadResult<string, DomainError>> {
  return describeScene(sceneInputFor(recipe), `Author scene brief: ${recipe.title.trim()}`);
}

// Upload a user-supplied hero photo (issue #455, Phase 2). The caller (the
// RecipeViewPage upload dialog) crops a local image to 3:2 in the ImageCropper
// primitive and passes the cropped bytes as base64. The auth-gated callable
// re-encodes them, overwrites the recipe's Storage hero, and stamps
// `image = { url, source: 'upload' }`; the new URL arrives via the recipe
// subscription. Deliberately a callable, not an optimistic store write — a client
// whole-document write would risk clobbering a concurrent trigger write, and
// storage.rules forbid a direct client Storage write.
export async function setRecipeImageUpload(
  recipeId: string,
  imageBase64: string,
  contentType?: string,
): Promise<ReadResult<void, DomainError>> {
  return reportIfFailed(
    getErrorReporter(),
    await callSetRecipeImageUpload(recipeId, imageBase64, contentType),
  );
}

// ─── URL import ────────────────────────────────────────────────────────────────
// SSRF-hardened import: paste a recipe URL, get back a fully-converted (metric +
// British) draft. The draft is NOT persisted here — the caller hydrates the
// editor with it so the user reviews/saves. On failure we return a specific,
// friendly message keyed off the import failure code; the UI shows it and lets
// the user fall back to manual/chat.

// User-facing copy per failure code. Mirrors the CF entrypoint's HttpsError
// messages but lives client-side so we never depend on the server message text.
const URL_IMPORT_COPY: Record<UrlImportFailureCode, string> = {
  'invalid-url': "That doesn't look like a valid web address.",
  'blocked-url': "That link can't be imported.",
  'fetch-failed': "We couldn't reach that page — it may be down, paywalled, or blocking us.",
  'not-a-recipe': "We couldn't find a recipe on that page.",
  'ai-failed': 'The recipe reader had trouble with that page — try again, or add it manually.',
};

// Copy for the failures that are NOT about the recipe site (issue #740). Shared
// by both import paths: "you are signed out" and "something went wrong" read the
// same whether the input was a URL or a photograph, and having one spelling is
// the point — the old bug was two bespoke vocabularies each inventing their own
// story for the same 401.
const SIGNED_OUT_COPY = "You've been signed out — sign in and try again.";
const UNKNOWN_IMPORT_COPY = 'Something went wrong — please try again.';

// Message for a URL-import failure. An import-specific code keeps its existing,
// correct copy; anything else is answered honestly rather than blamed on the
// recipe site. NOTE the deliberate asymmetry: NetworkError does NOT get
// "we couldn't reach that page" — the request never reached the page, so we do
// not know that, and saying so is the exact defect #740 exists to remove.
export function urlImportMessage(outcome: UrlImportFailure): string {
  if (isImportError(outcome)) return URL_IMPORT_COPY[outcome.code];
  if (outcome.kind === 'AuthError') return SIGNED_OUT_COPY;
  return UNKNOWN_IMPORT_COPY;
}

// Whether a failure means "your session has died", and so whether the UI should
// offer a route back to sign-in rather than a retry. One predicate for both
// import paths so the two sheets cannot drift on what "signed out" means.
export function isSignedOutFailure(outcome: UrlImportFailure | PhotoImportFailure): boolean {
  return outcome.kind === 'AuthError';
}

// Span/telemetry label for an import outcome. Bespoke code where there is one,
// else the DomainError category — never raw error text.
function importOutcomeLabel(outcome: UrlImportFailure | PhotoImportFailure): string {
  return outcome.kind === 'ImportError' ? outcome.code : outcome.kind;
}

// Route an import failure to the reporting port (issue #740). This is NOT a
// bespoke "report this import failure" call: it hands the DomainError to the
// SAME reportWriteError path every other write site uses, and the category gate
// inside the port decides — AuthError reports, NetworkError/ValidationError
// suppress (§7.6). A bespoke ImportError code is a user-facing verdict the
// friendly-message path already handles, so it is not reportable and has no
// category to gate on; it stops here.
//
// Import is a user-INITIATED callable, not an in-flight listener, so it
// deliberately uses the write path (no isAuthTransitioning() suppression): the
// sign-out teardown race cannot produce this failure.
function reportImportFailure(outcome: UrlImportFailure | PhotoImportFailure): void {
  if (outcome.kind === 'ImportError') return;
  reportWriteError(getErrorReporter(), outcome);
}

// Best-effort, bounded host extraction for the human-readable span name. Never
// throws — a malformed URL just yields 'url' so the trace still names the action.
function hostForSpan(url: string): string {
  try {
    return new URL(url.trim()).hostname || 'url';
  } catch {
    return 'url';
  }
}

/**
 * One traced user action: a root browser span, a named child span around the
 * callable, an outcome attribute, and an `end()` that survives a rejection.
 *
 * Distributed tracing (issue #362, Phase 4): the trace ORIGINATES here in the
 * browser so it starts at the click rather than at the server, and the W3C
 * traceparent is handed to the callable (2nd arg) so the CF + canon + AI sub-tree
 * nests under it instead of re-rooting. `web-pwa` owns the observability
 * dependency and bridges the traceparent into `firebase-sync`, which never
 * imports observability itself (Rule 4).
 *
 * Best-effort, always (Rule 10): `startUserActionSpan` is synchronous, returns an
 * inert handle when tracing is not ready, and never throws — so an untraced run
 * behaves exactly as a bare callable call, traceparent and all (`'' || undefined`
 * omits the header).
 *
 * ── Two parameters that exist for a reason ──────────────────────────────────
 *
 * `outcomeKey` because the import paths report `import.outcome` and authoring
 * reports `author.outcome`. Hard-coding one would silently relabel the other's
 * spans, and a dashboard cannot tell a renamed attribute from a missing one.
 *
 * `onFailure` because `reportImportFailure` runs INSIDE the span's lifetime
 * today. Hoisting it to the caller would end the span before reporting and
 * quietly shorten every failed import's recorded duration — a change to the
 * numbers, dressed as a refactor. Passing it in keeps the ordering bit-for-bit.
 *
 * Module-local on purpose: all three call sites are in this file. There are four
 * more `startUserActionSpan` callers elsewhere in `lib/` and `routes/`; sweeping
 * them is a different change with a different blast radius, and this promotes to
 * `lib/` on the day a caller in another file wants it.
 *
 * `sharedHelperGuard.test.ts` asserts this file holds exactly TWO
 * `startUserActionSpan(` call sites — this helper and `describeScene`, which is
 * named there with the reason it was left out. A third fails.
 */
// `E` is unconstrained deliberately: the helper never inspects the error, it
// hands it to `outcomeLabel` and `onFailure`. Constraining it to `DomainError`
// would exclude the import unions, which carry an `ImportError` variant of their
// own — and widening those to their union is exactly what must not happen.
async function tracedUserAction<T, E>(
  spanName: string,
  childName: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
  outcomeKey: string,
  outcomeLabel: (error: E) => string,
  call: (traceparent: string | undefined) => Promise<ReadResult<T, E>>,
  onFailure?: (error: E) => void,
): Promise<ReadResult<T, E>> {
  const span = startUserActionSpan(spanName);
  // Set before the child opens, as all three call sites did by hand.
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
  const child = span.child(childName);
  try {
    const result = await call(span.traceparent || undefined);
    child.end();
    if (result.kind !== 'ok') {
      span.setAttribute(outcomeKey, outcomeLabel(result.error));
      span.setError();
      onFailure?.(result.error);
      return result;
    }
    span.setAttribute(outcomeKey, 'ok');
    return result;
  } finally {
    span.end();
  }
}

// Import a recipe from a URL. Returns the assembled draft as a Recipe entity
// (RecipeDoc is structurally identical), with source.type='url' already set.
// `updatedAt` is left as the server stamp; the editor re-stamps on save.
//
// Distributed tracing (issue #362, Phase 4): start a ROOT span at this user action
// so the trace ORIGINATES here in the browser. Its W3C traceparent is handed to
// the callable (2nd arg), and Phase 3's server side nests the CF + canon + AI
// sub-tree under that same trace id. The callable round-trip is captured as a
// child span so the client-side latency is visible. web-pwa OWNS the observability
// dependency and bridges the traceparent to firebase-sync (Rule 4: firebase-sync
// never imports observability). Tracing is best-effort: when it's inert the span
// is a no-op and the traceparent is '' (omitted by the wrapper), so import works
// exactly as before.
//
// `source` distinguishes the Web Share Target hand-off (issue #589) from the
// "Import from URL" button on the recipe list — the only way to tell whether
// share-to-Salt is actually used, and free to carry as a span attribute.
export async function importRecipeFromUrl(
  url: string,
  source: 'button' | 'share' = 'button',
): Promise<ReadResult<Recipe, UrlImportFailure>> {
  const trimmed = url.trim();
  // `Recipe` is an alias of `RecipeDoc` (issue #417), so the draft that comes
  // back is already a Recipe — no cast needed.
  return tracedUserAction<Recipe, UrlImportFailure>(
    `Import recipe from ${hostForSpan(trimmed)}`,
    'callExtractRecipeFromUrl',
    { 'import.source': source },
    'import.outcome',
    importOutcomeLabel,
    (traceparent) => callExtractRecipeFromUrl({ url: trimmed }, traceparent),
    reportImportFailure,
  );
}

// ─── Photo import (issue #649, Phase 3) ────────────────────────────────────────
// Photograph a cookbook page (1–MAX_RECIPE_PAGE_PHOTOS pages of ONE recipe, since
// a recipe routinely runs across a spread) and get back the same fully-converted
// (metric + British) draft the URL path produces, with the book's title/author/
// page recorded on `source` where the photographs show them. Unlike the URL path
// there is nothing to validate client-side beyond the page count, which the
// capture UI enforces by construction.
//
// The page images are REQUEST-SCOPED end to end: cropped in the browser, sent as
// base64, read by the model, discarded. Nothing is written to Storage on either
// side, so there is no object to clean up if the import fails.

// User-facing copy per failure code. Its own map, NOT a widening of
// URL_IMPORT_COPY: `PhotoImportFailureCode` is a separate closed set (an invalid
// URL means nothing here), and the two vocabularies must not be able to drift
// into each other. Lives client-side for the same reason the URL copy does — the
// app never depends on the server's message text.
const PHOTO_IMPORT_COPY: Record<PhotoImportFailureCode, string> = {
  // Unreachable while the capture UI respects the 1–MAX_RECIPE_PAGE_PHOTOS bound;
  // kept honest rather than clever in case some other entry point ever sends a
  // payload the wire schema refuses.
  'invalid-photos': 'Those photos couldn’t be sent — take one to four shots of the page and retry.',
  // ONE message for two indistinguishable server-side outcomes: a page too blurry
  // or dark to read, and a page with no recipe on it. The model's output carries
  // no signal separating them, so the copy has to cover both without guessing.
  'unreadable-photos':
    'We couldn’t read a recipe from those photos — try a sharper, brighter shot of the whole page.',
  'import-failed':
    'The recipe reader had trouble with those photos — try again, or add it manually.',
};

// Same split as urlImportMessage (issue #740): a photo-specific verdict keeps its
// copy, while being signed out or an unknown transport failure no longer arrives
// as "the recipe reader had trouble with those photos" — which was untrue in
// exactly the way the URL message was.
export function photoImportMessage(outcome: PhotoImportFailure): string {
  if (isImportError(outcome)) return PHOTO_IMPORT_COPY[outcome.code];
  if (outcome.kind === 'AuthError') return SIGNED_OUT_COPY;
  return UNKNOWN_IMPORT_COPY;
}

// Import a recipe from page photographs. Returns the assembled draft as a Recipe
// entity (RecipeDoc is structurally identical) which the server has ALREADY
// persisted with `needs_approval` — so the caller routes to that recipe's editor,
// exactly as importRecipeFromUrl's caller does since #616.
//
// Distributed tracing (issue #362, Phase 4) is identical in shape to the URL
// path: a ROOT span at the user action so the trace ORIGINATES in the browser,
// its W3C traceparent handed to the callable, and the round-trip captured as a
// child span so client-side latency is visible. web-pwa OWNS the observability
// dependency and bridges the traceparent to firebase-sync (Rule 4). Best-effort:
// an inert tracer yields a no-op span and an empty traceparent, and import then
// behaves as a bare callable call.
//
// The page count rides as a span attribute — it is the one dimension that
// materially predicts extraction latency, and it is a number, not user content.
// The callable's own long timeout is the adapter's business; no timeout is
// passed from here.
export async function importRecipeFromPhoto(
  images: readonly RecipePagePhoto[],
): Promise<ReadResult<Recipe, PhotoImportFailure>> {
  // `Recipe` is an alias of `RecipeDoc` (issue #417), so the draft that comes
  // back is already a Recipe — no cast needed.
  return tracedUserAction<Recipe, PhotoImportFailure>(
    'Import recipe from photo',
    'callExtractRecipeFromPhoto',
    { 'import.source': 'photo', 'import.pageCount': images.length },
    'import.outcome',
    importOutcomeLabel,
    (traceparent) => callExtractRecipeFromPhoto({ images: [...images] }, traceparent),
    reportImportFailure,
  );
}

// Author/apply a recipe via the librarian flow, wrapped in a browser-ROOT span
// (issue #362, Phase 4) so the "Author recipe" action originates a distributed
// trace at the click and the CF + canon + AI sub-tree nests under the same trace
// id. Centralises the span + traceparent plumbing so the three Svelte call sites
// (chat "Save as recipe", chat "Apply changes", recipe-view "Apply changes") don't
// duplicate it. A bounded recipe title (when known) is appended to the span name —
// family-shared content is allowed per the naming/privacy decision, but bounded.
// Best-effort tracing: an inert tracer just yields a no-op span and an empty
// traceparent, so authoring behaves exactly as a bare callAuthorRecipe call.
export async function authorRecipeTraced(
  input: AuthorRecipeInput,
  titleHint?: string,
): Promise<ReadResult<RecipeDoc, DomainError>> {
  const name =
    titleHint && titleHint.trim() ? `Author recipe: ${titleHint.trim()}` : 'Author recipe';
  // No `onFailure`: authoring has no import copy to choose and no second surface
  // to keep in agreement, so nothing is reported from here. The outcome label is
  // the error's own `kind` rather than `importOutcomeLabel` — there are no import
  // codes to prefer.
  return tracedUserAction<RecipeDoc, DomainError>(
    name,
    'callAuthorRecipe',
    {},
    'author.outcome',
    (error) => error.kind,
    (traceparent) => callAuthorRecipe(input, traceparent),
  );
}

// Hand-off slot for the imported draft. The list page imports, stashes the
// draft here, then routes to /recipes/new; the edit page consumes it once on
// mount (single-use — taking it clears it so a later blank "New recipe" doesn't
// pick up a stale import). Kept in module state (not the route) because the
// draft is a rich object that doesn't belong in a URL.
// Hand-off slot for the URL a signed-out import was carrying (issue #740).
// Signing back in tears down and remounts the app tree — AuthGate swaps its
// children — so the list page's local `importUrl` is gone by the time the user
// returns. Without this they would have to go and re-copy the link, which is the
// same "work it out yourself" tax the wrong error message already charged.
//
// Module state, NOT browser storage: Rule 3 forbids localStorage/sessionStorage
// outside the two named pre-auth sign-in keys, and this does not qualify. The
// consequence is honest and bounded — it survives the OTP round trip (same tab)
// and is lost if the user signs in via a magic link that opens a NEW tab, which
// degrades to exactly today's behaviour rather than to something worse.
//
// Single-use, like takeImportedDraft: reading it clears it, so a later visit to
// the recipe list does not resurrect a URL the user has moved on from.
let _pendingImportUrl: string | null = null;

export function stashPendingImportUrl(url: string): void {
  const trimmed = url.trim();
  _pendingImportUrl = trimmed === '' ? null : trimmed;
}

export function takePendingImportUrl(): string | null {
  const url = _pendingImportUrl;
  _pendingImportUrl = null;
  return url;
}

let _pendingImportDraft: Recipe | null = null;

export function stashImportedDraft(draft: Recipe): void {
  _pendingImportDraft = draft;
}

// Single-use read. Since #616 an import is persisted server-side and opens as
// /recipes/{id}/edit, so the editor asks for a SPECIFIC id: passing `expectedId`
// leaves a non-matching stash in place, so opening some other recipe's editor
// can't silently swallow a pending import. Called with no argument (from
// /recipes/new) it takes whatever is stashed, as before.
export function takeImportedDraft(expectedId?: string): Recipe | null {
  const d = _pendingImportDraft;
  if (d === null) return null;
  if (expectedId !== undefined && d.id !== expectedId) return null;
  _pendingImportDraft = null;
  return d;
}

// Canonicalise all parsed-but-unmatched ingredients in a recipe via a single
// batch CF call. Only processes ingredients with parsed !== null and matchState
// 'pending' or 'failed'. Results are applied wholesale via persistRecipe.
export async function canonicaliseIngredients(
  recipe: Recipe,
): Promise<ReadResult<void, DomainError>> {
  // Collect ingredients that need canonicalisation: parsed and without a live match
  // (pending, failed, or matched-but-canon-item-deleted).
  const canonIds = new Set(getCanonItemsSnapshot().map((c) => c.id));
  const toProcess: Array<{ ingredientId: string; rawName: string; rawText: string }> = [];
  for (const group of recipe.ingredients) {
    for (const ing of group.items) {
      if (ing.parsed !== null && !hasLiveCanonMatch(ing, canonIds)) {
        toProcess.push({ ingredientId: ing.id, rawName: ing.parsed.item, rawText: ing.rawText });
      }
    }
  }

  if (toProcess.length === 0) return success(undefined);

  const batchResult = await callCanonicaliseRecipeIngredients({
    items: toProcess.map(({ rawName, rawText }) => ({ rawName, rawText })),
  });
  // Report the batch CF transport failure (the whole canonicalise call failed).
  // Per-row `settled[i]` slots below are per-ingredient match OUTCOMES folded
  // into matchState:'failed' — expected results, not I/O failures — so they are
  // intentionally not reported.
  if (batchResult.kind === 'err') return reportIfFailed(getErrorReporter(), batchResult);
  const settled = batchResult.value;

  // Map ingredientId → matchOrCreate result for O(1) lookup.
  const resultById = new Map(
    toProcess.map((p, i) => {
      const r = settled[i];
      return [p.ingredientId, r] as const;
    }),
  );

  const updatedGroups = recipe.ingredients.map((group) => ({
    ...group,
    items: group.items.map((ing) => {
      const result = resultById.get(ing.id);
      if (result === undefined) return ing;
      if (result.kind === 'err') {
        return { ...ing, matchState: 'failed' as const, canonId: null };
      }
      return {
        ...ing,
        canonId: result.value.item.id,
        matchState: 'matched' as const,
      };
    }),
  }));

  return persistRecipe({ ...recipe, ingredients: updatedGroups });
}

// Parse and canon-match a single ingredient line. Chains callParseRecipeIngredients
// → callCanonicaliseRecipeIngredients (batch-of-one) and folds the result into the
// ingredient. Operates on the in-memory draft; the caller must persist the result.
export async function matchIngredient(
  ing: Ingredient,
): Promise<ReadResult<Ingredient, DomainError>> {
  const parseResult = await callParseRecipeIngredients(ing.rawText);
  if (parseResult.kind === 'err') return reportIfFailed(getErrorReporter(), parseResult);

  const firstItem = parseResult.value[0]?.items[0];
  if (!firstItem?.parsed) {
    return success({ ...ing, parsed: null, canonId: null, matchState: 'failed' as const });
  }
  const parsed = firstItem.parsed;

  const canonResult = await callCanonicaliseRecipeIngredients({
    items: [{ rawName: parsed.item, rawText: ing.rawText }],
  });
  if (canonResult.kind === 'err') return reportIfFailed(getErrorReporter(), canonResult);

  const slot = canonResult.value[0]!;
  if (slot.kind === 'err') {
    return success({ ...ing, parsed, canonId: null, matchState: 'failed' as const });
  }
  return success({
    ...ing,
    parsed,
    canonId: slot.value.item.id,
    matchState: 'matched' as const,
  });
}

export async function removeRecipe(id: string): Promise<ReadResult<void, DomainError>> {
  // Record the delete as a local edit so a stale echo can't resurrect the doc.
  latestLocalEdit.set(id, new Date().toISOString());
  _recipes.set(get(_recipes).filter((r) => r.id !== id));
  return reportIfFailed(getErrorReporter(), await deleteRecipeDoc(id));
}

// ─── Shopping-list extraction ─────────────────────────────────────────────────

// `quantityToNumber` is imported from `@salt/domain` (issue #917). This file used
// to carry its own copy that took a range's `min`, so "2–3 tbsp" bought less than
// the same line baked; the rule and the argument for it live in the domain
// helper and are not restated here.

const _itemIds = { newListId: () => crypto.randomUUID(), newItemId: () => crypto.randomUUID() };

// One ingredient row in the recipe-add review step (issue #185). Carries the
// scaled amount/unit and resolved canon match, the default Add/Check toggles
// (from the canon item's shoppingBehavior), and the current user-chosen toggles
// (seeded from the defaults, mutated by the review sheet). `commitRecipeAddPlan`
// writes only the rows the user left as `add: true`.
export interface RecipeAddRow {
  readonly ingredientId: string;
  readonly rawText: string;
  /** Parser's clean item name (parsed.item), raw line as fallback — written as the shopping item's rawText. */
  readonly itemText: string;
  /** Parenthetical notes (parsed.notes) carried to the shopping item's notes field. '' when none. */
  readonly notes: string;
  /** Canon name when live-matched, else the clean item text — the label the sheet shows. */
  readonly name: string;
  readonly fromCanon: boolean;
  readonly isOptional: boolean;
  readonly canonId: string | null;
  readonly matched: boolean;
  readonly amount?: number;
  readonly unit?: string;
  // Per-form demand on this row's product-form parent (issue #501). Set only on a
  // surviving form-count row, and carries the demand of EVERY form of that parent
  // in this recipe (including the collapsed losers), each as an unrounded
  // parent-count. Written straight through to the shopping item so the list can
  // sum a form's demand across recipes. Absent on every ordinary row.
  readonly formDemand?: readonly FormDemand[];
  // The recipe's OWN wording for every ingredient line that contributed to this
  // row (issue #528). Set only on a surviving form-count row, where the label is
  // the PARENT product ("Lime (3 count)") and the lines that justified the count
  // ("juice of 2 limes", "zest of 1 lime") would otherwise be discarded by the
  // collapse. Winner first, then source order, de-duplicated. Written straight
  // through to the shopping item so the list can show the same wording under its
  // "Lime ×3" headline. DISPLAY ONLY — nothing branches on it. Absent on every
  // ordinary row.
  readonly originalText?: readonly string[];
  // The recipe's ORIGINAL non-metric measure for this line, verbatim ("6 cloves",
  // "1½ cups") — `parsed.displayText`, carried onto the shopping item so a line
  // the parser flattened to grams still says what to reach for in the shop.
  // Present only on an UNSCALED add; see the gate in buildRecipeAddPlan. Display
  // only — nothing branches on it.
  readonly measureNote?: string;
  add: boolean;
  check: boolean;
  // ─── Buy-or-make (Phase 2) ───────────────────────────────────────────────────
  // Recipes that PRODUCE this row's ingredient (its `canonId` == their
  // `producesCanonId`), resolved against the recipe snapshot. Empty when none —
  // the review sheet then shows NO buy/make control for the row. The recipe being
  // added is excluded (self-reference guard), so a recipe can't "make" its own
  // ingredient from itself.
  readonly producers: readonly Recipe[];
  // The user's choice for an eligible row. `false` = buy the single item (default,
  // identical to pre-Phase-2 behaviour); `true` = make it by fanning out the
  // chosen producer's ingredients. Meaningless (and ignored) when `producers` is
  // empty.
  make: boolean;
  // Which producer to make when there's more than one candidate. Seeded to the
  // first producer's id; `null` when there are no producers.
  producerId: string | null;
  // ─── Made-header servings (buy-or-make, nested sheet — Phase 2) ──────────────
  // The chosen batch size for the currently-selected producer when this row is
  // Made. FULLY INDEPENDENT of the master recipe's chosen servings and of this
  // row's own required ingredient quantity — it DEFAULTS to the selected
  // producer's own base (`metadata.servings ?? 1`, or 1 when there are no
  // producers) and is only ever moved by the per-header stepper. Stepping it
  // live-rescales `subRows` (rebuilt via `buildMadeSubRows` → `buildRecipeAddPlan`
  // with this value) and is mirrored into every committed sub-entry's
  // `SourceRef.servings`, so the written amounts and the stamped servings agree.
  // Min 1 (enforced by the stepper). Meaningless (and ignored) when `producers`
  // is empty or the row is Buy.
  madeServings: number;
  // ─── Made sub-entries (buy-or-make, nested sheet — Phase 1) ──────────────────
  // When the user selects Make, the chosen producer's own ingredients are built
  // EAGERLY here as nested rows — each a full `RecipeAddRow` with its own
  // `add`/`check` seeded by `recipeItemAddDefault`, rendered as an indented,
  // individually-toggleable sub-entry beneath the (label-only) made header.
  // `null` in the Buy state, where the row is a single ordinary addable line.
  // Rebuilt when Make is toggled or the producer selection changes.
  //
  // ONE LEVEL DEEP: sub-rows carry no producers (`producers: []`, `make: false`,
  // `subRows: null`), so a sub-entry can never itself be "made"/expanded — it is
  // always a plain Add/Check row even if some recipe could also make it. This is
  // a SHEET-ONLY hierarchy: on commit each included sub-entry is still written as
  // a flat sibling shopping-list item stamped with the PRODUCER's `SourceRef`
  // (recipeId/servings/label = the producer's), exactly as before.
  subRows: RecipeAddRow[] | null;
}

// Compute the scaled amount/unit for an ingredient. quantity is always in metric
// (g/ml) so no conversion needed — scale and round directly.
function scaledAmountUnit(ing: Ingredient, scale: number): { amount?: number; unit?: string } {
  if (ing.parsed === null || ing.parsed.quantity === null) return {};
  const amount = Math.round(quantityToNumber(ing.parsed.quantity) * scale * 10) / 10;
  return ing.parsed.unit !== null ? { amount, unit: ing.parsed.unit } : { amount };
}

// Product-form quantity resolution (issue #500, Phase 2). When a recipe
// ingredient resolves to a ProductForm whose parent is the ingredient's OWN canon
// match, its scaled metric amount converts to a whole parent-product count (e.g.
// 90 ml lime juice → 3 limes), written with the `'count'` unit sentinel that the
// shopping row reads to render "Lime ×3". Re-derives the form from the snapshot
// (no schema change, no CF→client plumbing); the parent-match guard keeps it
// back-compatible — an ingredient matched before its form existed stays as-is.
// Returns null (identity-only degrade) on no form, a unit mismatch, or a
// degenerate yield, so the caller keeps the metric amount and today's behaviour.
//
// `rawCount` is the UNROUNDED parent-count (issue #501): `count` is rounded per
// recipe and is only the row's own display amount, so summing it across recipes
// double-rounds (6 g + 6 g of zest is 12 g = 3 limes, but 2 + 2 = 4). The raw
// value is what gets persisted as `formDemand` and summed at display time.
function formCountFor(
  ing: Ingredient,
  scale: number,
  forms: readonly ProductForm[],
  // Pass-through for `resolveProductForm`'s contested-phrase rule (issue #1180).
  canon: readonly CanonNaming[],
): { form: ProductForm; count: number; rawCount: number } | null {
  if (forms.length === 0 || !ing.canonId || ing.parsed === null || ing.parsed.quantity === null) {
    return null;
  }
  const form = resolveProductForm(ing.parsed.item, forms, canon);
  if (!form || form.parentCanonId !== ing.canonId) return null;
  const metricAmount = quantityToNumber(ing.parsed.quantity) * scale;
  const ingUnit: CanonItemUnit = ing.parsed.unit ?? 'count';
  const count = formParentCount(metricAmount, ingUnit, form);
  // formParentCount already rejects a unit mismatch and a degenerate/zero yield,
  // so a non-null count guarantees convertYield agrees on the same units.
  return count === null ? null : { form, count, rawCount: convertYield(metricAmount, form.yield) };
}

// The unit sentinel written on a product-form shopping row: marks `amount` as a
// parent-product count (not g/ml), so the shopping page renders "×N" and the
// display degrade path can tell a real count from a metric amount.
export const PRODUCT_FORM_COUNT_UNIT = 'count';

// Build the review plan for adding a recipe to a list at the given servings.
// Every ingredient becomes a row with its scaled amount and a default Add/Check
// state driven by the matched canon item's shoppingBehavior (issue #185). The
// caller (review sheet) lets the user adjust the toggles, then hands the rows to
// commitRecipeAddPlan. Pure read against the canon snapshot — no writes here.
export function buildRecipeAddPlan(recipe: Recipe, servings: number): RecipeAddRow[] {
  const baseServings = usableServings(recipe.metadata.servings) ?? 1;
  const scale = servings / baseServings;
  const canonSnapshot = getCanonItemsSnapshot();
  const canonById = canonIndex(canonSnapshot);
  const liveCanonIds = new Set(canonById.keys());
  // Snapshot the recipe list once so the buy-or-make resolver (Phase 2) is a pure
  // per-row lookup. `findProducingRecipes` is the pure @salt/domain helper; the
  // self-reference guard (a recipe can't make its own ingredient from itself) is
  // applied here, at the call site.
  const allRecipes = getRecipesSnapshot();
  const forms = getProductFormsSnapshot();

  // Form-count rows keyed by their parent canon, collected for the WITHIN-RECIPE
  // MAX collapse once every row is built (one lime supplies both juice and zest →
  // buy the max of this recipe's forms, not their sum). Scope matters: this maxes
  // the DISTINCT forms THIS recipe demands. Aggregating one parent across the whole
  // list is a display concern (#518, aggregateParentCount), where the same form in
  // two recipes SUMS. Each entry points back at its row so the losers can be dropped.
  // `formId`/`rawCount` carry the loser rows' demand onto the surviving row as
  // `formDemand` (issue #501) — collapsing to the MAX row alone would discard it,
  // and the display layer could then never recover the per-form sum across recipes.
  // `rawText` carries each contributing line's ORIGINAL recipe wording onto the
  // survivor as `originalText` (issue #528) — the collapsed row is labelled with
  // the parent product, which by design reads nothing like the recipe's own line.
  const formEntries: {
    rowIndex: number;
    parentCanonId: string;
    count: number;
    formId: string;
    rawCount: number;
    rawText: string;
  }[] = [];

  const rows: RecipeAddRow[] = [];
  for (const group of recipe.ingredients) {
    for (const ing of group.items) {
      const matched = hasLiveCanonMatch(ing, liveCanonIds);
      const canon = matched ? (canonById.get(ing.canonId!) ?? null) : null;
      // A product-form ingredient carries a parent-count (unit sentinel 'count');
      // otherwise fall back to the scaled metric amount. formCountFor requires a
      // live canon match (parentCanonId === ing.canonId), so it implies `matched`.
      const fc = matched ? formCountFor(ing, scale, forms, canonSnapshot) : null;
      if (fc) {
        formEntries.push({
          rowIndex: rows.length,
          parentCanonId: fc.form.parentCanonId,
          count: fc.count,
          formId: fc.form.id,
          rawCount: fc.rawCount,
          rawText: ing.rawText,
        });
      }
      const { amount, unit } = fc
        ? { amount: fc.count, unit: PRODUCT_FORM_COUNT_UNIT }
        : matched
          ? scaledAmountUnit(ing, scale)
          : {};

      const dflt = recipeItemAddDefault(
        canon?.shoppingBehavior ?? null,
        amount ?? null,
        canon?.largeQuantityThreshold,
      );

      // Prefer the parser's clean item name over the raw line so the shopping row
      // reads without the recipe's amounts/units/prep ("1 x 400g tin chopped
      // tomatoes, drained" → "tomatoes"). Falls back to the raw line when the
      // ingredient is unparsed or the parse yielded an empty item. Preparation
      // phrases are intentionally dropped; parenthetical notes ride to the item's
      // notes field. `parsed.displayText` is deliberately ignored — it is a frozen
      // parse-time measure that would not rescale with servings, so the scaled
      // metric amount/unit stays the source of truth for quantity.
      const itemText = ing.parsed?.item.trim() || ing.rawText;
      const notes = ing.parsed?.notes ?? '';

      // `parsed.displayText` — the line's original non-metric measure ("6 cloves")
      // — rides onto the row so the list can read "18g Garlic (6 cloves)" the way
      // the recipe page does, instead of a weight nobody can eyeball in the shop.
      //
      // ONLY at scale 1. The string is a frozen parse-time rendering with no
      // structure to multiply ("1½ cups", "2–3 tbsp", "6 cloves"), so on a scaled
      // add it would sit beside a rescaled amount stating a quantity that is
      // simply untrue and have the shopper buy the wrong thing. Dropping it costs
      // a hint; keeping it costs correctness, so it goes. The scaled metric
      // amount/unit remains the only quantity a scaled row shows.
      const measureNote = scale === 1 ? (ing.parsed?.displayText ?? null) : null;

      // Buy-or-make (Phase 2): a row is eligible when its ingredient's canon link
      // is produced by some OTHER recipe. Keyed off the ingredient's raw `canonId`
      // (not `matched`) so a producer stays offerable even if the canon doc was
      // deleted. Self-reference guard: exclude the recipe being added.
      const producers = ing.canonId
        ? findProducingRecipes(allRecipes, ing.canonId).filter((r) => r.id !== recipe.id)
        : [];

      rows.push({
        ingredientId: ing.id,
        rawText: ing.rawText,
        itemText,
        notes,
        name: canon?.name ?? itemText,
        fromCanon: canon !== null,
        isOptional: ing.isOptional,
        canonId: matched ? ing.canonId : null,
        matched,
        ...(amount !== undefined ? { amount } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(measureNote ? { measureNote } : {}),
        add: dflt.add,
        check: dflt.check,
        producers,
        make: false, // default to buy — unchanged behaviour unless the user opts in
        producerId: producers[0]?.id ?? null,
        // Default to the first producer's OWN base servings — never the master
        // recipe's chosen servings, never the required quantity. 1 when nothing
        // produces this row.
        madeServings: usableServings(producers[0]?.metadata.servings ?? null) ?? 1,
        subRows: null, // populated eagerly only when the user selects Make
      });
    }
  }

  // Same-parent aggregation (issue #500): collapse the form-count rows of one
  // parent to the single MAX-count row, dropping the losers, so "juice AND zest of
  // limes" becomes one lime line, not two. Only form-count rows are merged;
  // ordinary same-canon rows are left alone (combining stays a display concern).
  //
  // The surviving row also carries EVERY form's demand for that parent as
  // `formDemand` (issue #501). The collapse is still one row per parent per recipe
  // — the sheet and the list look exactly as before — but the losers' demand rides
  // along instead of being discarded, so the display layer can sum each form's
  // demand ACROSS recipes and round once.
  //
  // The survivor's `amount` is the parent count THIS recipe needs, from the same
  // `aggregateParentCount` the list uses — not the winning row's own count (issue
  // #521). The two differ only when one form appears on two lines: stock in a
  // braise (400 ml) and a gravy (400 ml) against a 500 ml cube is 2 cubes, but the
  // winner's own count is 1, so the sheet used to under-state what the list showed.
  // Across DISTINCT forms the aggregate IS the max, so juice-and-zest is unchanged.
  if (formEntries.length > 0) {
    const winners = maxCountWinners(
      formEntries.map((e) => ({ parentCanonId: e.parentCanonId, count: e.count })),
    );
    const formRowIndices = new Set(formEntries.map((e) => e.rowIndex));
    // Winning row index → the demand of every form of that same parent.
    const demandByRowIndex = new Map<number, FormDemand[]>();
    // Winning row index → the original recipe wording of every contributing line
    // (issue #528). Winner first so the row's own line leads, then source order;
    // a Set de-duplicates identical lines while preserving insertion order.
    const originalTextByRowIndex = new Map<number, string[]>();
    winners.forEach((entryIdx, parentCanonId) => {
      const winner = formEntries[entryIdx]!;
      const contributing = formEntries.filter((e) => e.parentCanonId === parentCanonId);
      demandByRowIndex.set(
        winner.rowIndex,
        contributing.map((e) => ({ formId: e.formId, parentCount: e.rawCount })),
      );
      originalTextByRowIndex.set(winner.rowIndex, [
        ...new Set([winner.rawText, ...contributing.map((e) => e.rawText)]),
      ]);
    });
    // Attach demand against the ORIGINAL row indices, then drop the losers.
    return rows
      .map((row, i) => {
        const demand = demandByRowIndex.get(i);
        if (!demand) return row;
        // Whole/direct produce is a separate row and aggregates at display time;
        // within one recipe there is only this parent's form demand to fold.
        const amount = aggregateParentCount({
          demands: demand,
          legacyFormCounts: [],
          wholeCounts: [],
        });
        // Re-decide the Add/Check default against the corrected amount: a
        // `stocked` parent's largeQuantityThreshold must see what the recipe
        // really needs, not the under-stated per-row count.
        const canon = row.canonId ? (canonById.get(row.canonId) ?? null) : null;
        const dflt = recipeItemAddDefault(
          canon?.shoppingBehavior ?? null,
          amount,
          canon?.largeQuantityThreshold,
        );
        return {
          ...row,
          amount,
          formDemand: demand,
          originalText: originalTextByRowIndex.get(i)!,
          add: dflt.add,
          check: dflt.check,
        };
      })
      .filter((_, i) => !formRowIndices.has(i) || demandByRowIndex.has(i));
  }
  return rows;
}

// Build the nested sub-entry rows for a made row: the chosen producer's OWN
// ingredients scaled to the header's chosen `madeServings` (Phase 2 — was fixed
// at the producer's base). Each is a full `RecipeAddRow` with its own default
// Add/Check (via `recipeItemAddDefault`, inside `buildRecipeAddPlan`), but with
// its buy-or-make affordance stripped (`producers: []`, `producerId: null`,
// `make: false`, `subRows: null`) so a sub-entry is always a plain toggleable
// row and can never be expanded again — ONE LEVEL DEEP (matching the old
// commit-time rebuild, which seeded `make: false`). Returns `[]` when no
// producer resolves, so the made header then contributes nothing (matching
// commit + count). Pure read against the recipe + canon snapshots (via
// `buildRecipeAddPlan`), so it's safe to call from the sheet on Make/producer/
// servings changes. `buildRecipeAddPlan` scales by `madeServings / producerBase`,
// so `madeServings` at the producer's base leaves amounts as authored.
export function buildMadeSubRows(row: RecipeAddRow): RecipeAddRow[] {
  if (row.producers.length === 0) return [];
  const producer = row.producers.find((r) => r.id === row.producerId) ?? row.producers[0]!;
  return buildRecipeAddPlan(producer, row.madeServings).map((sub) => ({
    ...sub,
    producers: [],
    producerId: null,
    make: false,
    subRows: null,
  }));
}

// How many shopping-list items a confirmed plan will actually write — the number
// the review sheet's "Add N to list" preview must show so it matches the commit
// result (issue #185). Walks the eagerly-built nested structure (Phase 1 of the
// nested sheet), never re-expanding at count time:
//   • a made row (`make`) is a LABEL-ONLY header that emits no item of its own —
//     it contributes only its included (`add: true`) sub-entries;
//   • any other included row (`add: true`, Buy) writes its single item → 1.
// Pure synchronous walk over the in-memory rows — safe to recompute in a Svelte
// `$derived`.
export function recipeAddPlanItemCount(rows: readonly RecipeAddRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.make) {
      // Label-only made header: count only its ticked sub-entries.
      total += (row.subRows ?? []).filter((sub) => sub.add).length;
      continue;
    }
    if (row.add) total += 1;
  }
  return total;
}

// Build the single shopping-list item for one plan row against a `SourceRef`.
// Extracted so the Buy path and the made-header sub-entry path share the exact
// same mapping (clean name, notes, scaled amount/unit, canon match, needsCheck).
// Returns the domain result; a domain `ValidationError` short-circuits commit.
function buildAddedItem(row: RecipeAddRow, source: SourceRef, now: string) {
  return addItem(
    [],
    {
      rawText: row.itemText,
      ...(row.notes ? { notes: row.notes } : {}),
      source,
      now,
      needsCheck: row.check,
      ...(row.matched ? { canonId: row.canonId, matchState: 'matched' as const } : {}),
      ...(row.amount !== undefined ? { amount: row.amount } : {}),
      ...(row.unit !== undefined ? { unit: row.unit } : {}),
      ...(row.formDemand !== undefined ? { formDemand: row.formDemand } : {}),
      ...(row.originalText !== undefined ? { originalText: row.originalText } : {}),
      ...(row.measureNote !== undefined ? { measureNote: row.measureNote } : {}),
    },
    _itemIds,
  );
}

// Write the user-confirmed rows of a recipe-add plan to the shopping list. Only
// rows left as `add: true` are written; `check: true` rows land flagged for
// verification (needsCheck). Matched rows carry their canonId + matchState and
// scaled amount/unit. One item per row — combining is display-time.
//
// Buy-or-make (nested sheet, Phase 1): a made row (`make`) is a LABEL-ONLY header
// that emits NO item of its own. Instead its eagerly-built `subRows` are written
// — walking the nested structure the sheet already prepared, rather than
// re-expanding the producer here. Each included (`add: true`) sub-entry is a flat
// sibling item stamped with the CHOSEN producer's `SourceRef` (recipeId/label =
// the producer's; servings = the header's chosen `madeServings`, Phase 2), so the
// stamped servings match the already-scaled sub-entry amounts and the same canon
// trigger picks it up exactly as before. Sub-rows are one level deep
// (`make: false`), so there is no recursion.
export async function commitRecipeAddPlan(
  recipe: Recipe,
  listId: string,
  servings: number,
  rows: readonly RecipeAddRow[],
): Promise<ReadResult<void, DomainError>> {
  const now = new Date().toISOString();
  const parentSource: SourceRef = {
    kind: 'recipe',
    recipeId: recipe.id,
    servings,
    label: recipe.title,
  };

  // All writes are direct single-item `saveShoppingListItem` calls (Buy rows and
  // made sub-entries alike). Failures are reported here.
  const saves: Promise<ReadResult<void, DomainError>>[] = [];
  for (const row of rows) {
    if (row.make) {
      // Label-only made header: emit nothing for the header; write each included
      // sub-entry stamped with the chosen producer's SourceRef.
      const subRows = row.subRows ?? [];
      if (subRows.length === 0) continue;
      const producer = row.producers.find((r) => r.id === row.producerId) ?? row.producers[0];
      if (!producer) continue;
      // The header's chosen batch size (Phase 2). The sub-entries in `subRows`
      // were already scaled to this same value by `buildMadeSubRows`, so the
      // written amounts and the stamped `SourceRef.servings` agree.
      const subSource: SourceRef = {
        kind: 'recipe',
        recipeId: producer.id,
        servings: row.madeServings,
        label: producer.title,
      };
      for (const sub of subRows) {
        if (!sub.add) continue;
        const result = buildAddedItem(sub, subSource, now);
        if (result.kind !== 'ok') return result;
        saves.push(saveShoppingListItem(listId, result.value[0]!));
      }
      continue;
    }

    if (!row.add) continue;
    const result = buildAddedItem(row, parentSource, now);
    if (result.kind !== 'ok') return result;
    saves.push(saveShoppingListItem(listId, result.value[0]!));
  }

  if (saves.length === 0) return success(undefined);

  const results = await Promise.all(saves);
  // Report the first shopping-list write failure (StorageError/SyncError/etc.);
  // the addItem domain ValidationError above short-circuits before any write and
  // is a suppressed category regardless, so it is intentionally not reported.
  const firstFailure = results.find((r) => r.kind !== 'ok');
  if (firstFailure) return reportIfFailed(getErrorReporter(), firstFailure);
  return success(undefined);
}
