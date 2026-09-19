import { getFirestore, FieldValue, type DocumentSnapshot } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { RecipeSchema, DevSettingsSchema, type RecipeDoc } from '@salt/domain/schemas';
import { componentDisplayLines, isCookable, reconcileRecipePhases } from '@salt/domain';
import { generateRecipeImageFlow } from '../flows/generateRecipeImage.js';
import { describeRecipeSceneFlow } from '../flows/describeRecipeScene.js';
import { identifyRecipeKitFlow } from '../flows/identifyRecipeKit.js';
import { estimateRecipeTimesFlow } from '../flows/estimateRecipeTimes.js';
import { readComponentContext } from '../flows/componentContext.js';
import { readEquipmentItems } from '../flows/equipmentContext.js';
import { encodeHeroImage } from '../imaging/encodeHeroImage.js';
import { buildStorageDownloadUrl } from '../imaging/storageDownloadUrl.js';
import { AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS, withAiTimeout } from '../adapters/withAiTimeout.js';
import { aiFakeEnabled } from '../ai/fakeModel.js';
import { reportServerError } from '../observability/reportServerError.js';
import { withFirestoreTrigger, traceContextFromWrittenDoc } from './triggerEntrypoint.js';

// Tier-2 recipe hero-image generation (issue #148). The counterpart to
// onCanonItemWritten's icon branch: when a recipe is created (or its image is
// explicitly cleared / a regenerate is requested), generate one photorealistic
// "arty" hero from the title + description, store it in Firebase Storage, and
// write the public URL back to `recipe.image`.
//
// Since issue #882 there is a SECOND, independently-guarded branch: the kit — the
// pans, bowls and hand tools this dish needs a cook to get out — inferred from the
// whole saved recipe and written back to `recipe.kit`. The two run under
// `Promise.allSettled` (as onCanonItemWritten's icon + embedding pair do) so a
// failure in one can never reject the handler and retry both.
//
// Issue #952 adds a THIRD, and it is unlike the other two: it never fires on
// create. The three authoring paths already answer "how long does this take?"
// against a proper definition, so a create has nothing to re-ask. It fires only on
// an explicit `timesRequestedAt` bump — which today means the one-off backfill
// script — and rewrites the phase strip and its summary, and nothing else (the
// three `metadata.*TimeMinutes` fields went with issue #1233).

// Defined here (not imported from index.ts) to avoid a circular import; the
// Firebase CLI aggregates same-named defineSecret calls across files at deploy
// time. The trigger reaches Gemini for the image, so the key must be bound to it.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
// Bound so server error reporting (posthog-node) can read POSTHOG_API_KEY at
// runtime. Optional like elsewhere: when unset, reporting no-ops and the logger
// still emits.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

const IMAGE_STORAGE_PREFIX = 'recipe-images';

/**
 * Edge-trigger decision for the hero-image branch, mirroring
 * onCanonItemWritten.iconNeedsGeneration. The trigger fires on EVERY write to the
 * recipe doc — and recipes are re-saved often (canonicalise, per-row rematch,
 * edits, "apply changes"), each a whole-document `setDoc` — so generation must
 * start only on the write that *transitions* the recipe into "needs an image",
 * never merely because `image` currently happens to be null. Otherwise an edit
 * landing while a generation is in flight would start a duplicate.
 *
 * Generate when:
 *   - create (no prior doc) with a null image and not opted out
 *   - image just went non-null → null (regenerate, or user cleared)
 *   - the `imageRequestedAt` nonce changed — covers a forced regenerate of a
 *     recipe whose image was *already* null (see regenerateRecipeImage)
 * Skip when:
 *   - `image` is already set (a real `{ url, source }` — ai OR upload: a manual
 *     upload is never clobbered) → already have one
 *   - image was already null before this write and stayed null with no nonce bump:
 *     the write that first set it null already owns the in-flight generation.
 *
 * `imageHidden` is retired (Phase 1): it is no longer honored here — the AI
 * trigger auto-generates a hero regardless of that (now inert, back-compat-only)
 * field. Hero visibility is a pure client concern (an image URL either exists or
 * it doesn't).
 *
 * LWW note: a client `setDoc` that lands AFTER the trigger's `image` write and
 * still carries `image: null` will clobber the hero back to null (the documented
 * whole-document LWW contract) and re-fire this branch, which regenerates — so it
 * self-heals at the cost of an extra generation in that narrow race. The client
 * store preserves `image` across its own saves (it re-spreads the subscribed
 * copy), so the window is only saves that beat the subscription echo.
 */
function imageNeedsGeneration(before: DocumentSnapshot | undefined, after: RecipeDoc): boolean {
  if (after.image !== null) return false; // already have an image (ai or upload)
  if (!before?.exists) return true; // create → generate
  const prev = before.data();
  if ((prev?.['image'] ?? null) !== null) return true; // just cleared → generate
  // Already null and still null: only an explicit regenerate (nonce bump) re-fires;
  // any other field change (edit, canonicalise, rematch…) must not start a
  // duplicate.
  return prev?.['imageRequestedAt'] !== after.imageRequestedAt;
}

/**
 * Hero-image branch. Generates the photoreal hero when this write transitions the
 * recipe into "needs an image" (see imageNeedsGeneration).
 *
 * Trade-off of edge-triggering (same as the canon icon branch): a generation that
 * *fails* leaves `image` null but no longer self-heals on the next unrelated
 * write — the regenerate callable (which bumps `imageRequestedAt`) is the retry
 * path.
 */
async function maybeGenerateImage(
  id: string,
  recipe: RecipeDoc,
  before: DocumentSnapshot | undefined,
): Promise<void> {
  if (!imageNeedsGeneration(before, recipe)) return;

  // E2E (FUNCTIONS_AI_FAKE): skip image generation entirely. The real image model
  // and the Storage upload (which authenticates via the GCE metadata server) are
  // not emulator-safe and hang the trigger; no e2e spec asserts a generated hero.
  // Unreachable in production (the flag is never set there).
  if (aiFakeEnabled()) return;

  const title = recipe.title.trim();
  if (!title) return; // a blank draft has nothing to depict yet

  // Per-environment kill-switch (issue #238), checked only once the cheap
  // in-memory guard passes. Turning it off stops every generation path — create,
  // the cleared-image self-heal, and the manual regenerate callable (which routes
  // through this trigger). Re-enabling does not backfill.
  if (!(await isRecipeImageGenerationEnabled())) return;

  // Optional one-shot user steer written by the regenerate callable.
  const hint = recipe.imageHint?.trim();

  // Art direction for the hero. Deliberately the LAST thing before generation, so
  // every cheap skip above (fake-AI e2e, blank draft, kill-switch) short-circuits
  // before we pay for a text call.
  //
  // Brief present on the doc? Use it verbatim. Absent? Author one. The trigger does
  // not know or care whether a human or the model wrote it — an authored brief and
  // an edited one are the same field, and that is what makes a later "edit the
  // brief" affordance free.
  const brief = recipe.imageBrief?.trim() || (await describeSceneOrNothing(recipe));

  try {
    // No outer withAiTimeout (issue #915). The flow owns its budget — 60s + 1
    // retry, sized for an image generation — and a wrapper here imposed the
    // house 20s default on top of it, cutting long draws short. Follows the kit
    // branch below, and the equipment paths, rather than the other way round.
    const { imageBase64 } = await generateRecipeImageFlow({
      title,
      description: recipe.description,
      // Selects the opener, the scene fallback and the style anchors (issue
      // #637): a special is photographed as food that ARRIVES, not as a plated
      // dish. Always parsed (RecipeSchema defaults it), so pre-#637 docs read
      // back as 'recipe' and their prompt is byte-for-byte unchanged.
      kind: recipe.kind,
      ...(hint ? { hint } : {}),
      ...(brief ? { sceneBrief: brief } : {}),
      // Feed the recipe's own tags to the model as a dish-type cue for reading
      // mood/season/cuisine (issue #148, Phase 2). Always present on a parsed
      // RecipeDoc (string[], possibly empty); the flow drops empties and adds no
      // clause when there are none. Nothing new is persisted.
      tags: recipe.metadata.tags,
    });
    const raw = Buffer.from(imageBase64, 'base64');
    const webp = await encodeHeroImage(raw);
    const url = await uploadRecipeImage(id, webp);
    // Set the hero, persist the brief that produced it, and clear the one-shot hint
    // — all in the same write (the update fires regardless, so the brief rides along
    // for free). `source: 'ai'` marks it generated so a later trigger pass skips it
    // (and so the UI can tell it apart from a future user upload). The brief is
    // written whether we authored it or read it off the doc: re-writing an identical
    // value costs nothing and keeps the field a plain "this is the art direction for
    // the image you're looking at", with no in-flight window where a generated hero
    // has no brief beside it.
    await getFirestore()
      .collection('recipes')
      .doc(id)
      .update({
        image: { url, source: 'ai' },
        imageHint: FieldValue.delete(),
        ...(brief ? { imageBrief: brief } : {}),
      });
  } catch (err) {
    // Leave image null so a later regenerate retries; never block the trigger.
    logger.error('onRecipeWritten: image generation failed', { id, err });
    // Additive: image generation chains an AI flow, image processing and a Storage
    // upload — a throw here is unexpected. Report it to PostHog alongside the
    // logger. Best-effort, never throws; the handler's finally flushes.
    reportServerError(err);
  }
}

/**
 * Edge-trigger decision for the kit branch (issue #882), the exact counterpart of
 * `imageNeedsGeneration` above and guarded for the same reason: the trigger fires
 * on EVERY write, and recipes are re-saved constantly.
 *
 * Infer when:
 *   - create, with no stamp — the question has never been asked of this recipe
 *   - the stamp was just CLEARED (a redo: `redoRecipeKit` deletes it and bumps the
 *     nonce in one write, exactly as `regenerateCanonIcon` nulls `thumbnail`)
 *   - the `kitRequestedAt` nonce changed on a recipe that was already unstamped —
 *     a redo of one whose last inference failed
 * Skip otherwise, and in particular skip when the recipe was ALREADY unstamped
 * before this write and still is: the write that first left it unstamped owns the
 * in-flight inference, and an unrelated save landing during it (an import
 * canonicalising its ingredients seconds after create is the common case) must not
 * start a duplicate. This is `iconNeedsGeneration`'s shape, field for field, and it
 * is that transition test — not the mere absence of a stamp — that makes it safe.
 *
 * WHY NOT `kit.length === 0`. Because `kit` defaults to `[]`, an empty array cannot
 * tell "never inferred" apart from "inferred, and this dish genuinely needs nothing
 * listed" or from "inference failed". A guard keyed on emptiness would therefore
 * fire a fresh AI call on every unrelated save — canonicalise, per-row rematch, an
 * edit, "apply changes" — of any recipe whose kit came back empty, forever. The
 * stamp is what makes the branch self-terminating; the nonce is what lets a redo
 * re-fire it when nothing else about the document changed (Firestore emits no write
 * event for a no-op update — the reason canon's `iconRequestedAt` exists).
 *
 * Trade-off, stated because it is a real one: an EDIT does not re-infer. A recipe
 * whose method is rewritten keeps the kit it had until someone asks for a redo. That
 * is deliberate — re-inferring on every edit is the emptiness guard by another
 * route — and the redo action on the recipe page is the answer to it.
 */
export function kitNeedsInference(before: DocumentSnapshot | undefined, after: RecipeDoc): boolean {
  if (after.kitInferredAt !== undefined) return false; // already answered → skip
  if (!before?.exists) return true; // create → infer
  const prev = before.data();
  if (prev?.['kitInferredAt'] !== undefined) return true; // just cleared → infer
  // Unstamped before AND after: only an explicit nonce bump re-fires. Any other
  // field change — canonicalise, rematch, an edit — must not start a duplicate
  // while the first inference is still in flight.
  return prev?.['kitRequestedAt'] !== after.kitRequestedAt;
}

/**
 * Kit branch. Works out what this dish needs a cook to get out, and writes it to
 * `recipe.kit`.
 *
 * BEST-EFFORT (Rule 10): a kit list is an improvement to the recipe page, never a
 * precondition for anything. A failure logs, reports, and leaves `kitInferredAt`
 * UNSTAMPED so the redo action can retry — it never rejects, so the sibling image
 * branch is untouched by it.
 *
 * LWW note, identical to the image branch's: a client whole-document `setDoc` that
 * lands after this write and still carries the recipe as the client last knew it
 * clobbers the kit back off. That is the documented last-write-wins contract, not a
 * defect, and it is exactly what can happen to `image` / `imageBrief`. It self-heals
 * at the cost of one extra inference — the same write drops `kitInferredAt` with it,
 * so the next pass simply asks again. In the common case the client re-spreads its
 * subscribed copy and both fields ride along untouched.
 */
async function maybeInferKit(
  id: string,
  recipe: RecipeDoc,
  before: DocumentSnapshot | undefined,
): Promise<void> {
  if (!kitNeedsInference(before, recipe)) return;

  // A special has no method and a placeholder is a photograph and a title — neither
  // has anything to get out, so neither may ever cost an AI call. Asked through the
  // pure capability predicate, never `kind === 'special'`: what a kind can do is
  // answered in one place (packages/domain/src/recipe/queries/capabilities.ts) and
  // nowhere else.
  if (!isCookable(recipe.kind)) return;

  // Nothing to read yet. Returning WITHOUT stamping is deliberate: re-evaluating
  // this guard on a half-written draft's every save costs nothing (it is in-memory),
  // and the save that finally gives the recipe a method is the one that pays for an
  // answer.
  if (recipe.steps.length === 0) return;

  // E2E (FUNCTIONS_AI_FAKE): skip inference entirely, exactly as the image branch
  // does. Unreachable in production (the flag is never set there).
  if (aiFakeEnabled()) return;

  // Per-environment kill-switch (issue #238), checked only once the cheap in-memory
  // guards pass — the SAME switch the hero image uses, deliberately not a second
  // flag. It is the "stop this environment spending money generating recipe content"
  // lever, and a kit list is that. Re-enabling does not backfill.
  if (!(await isRecipeImageGenerationEnabled())) return;

  try {
    // What the household actually owns (issue #954), read only once every cheap
    // guard above has passed so a recipe that will not be inferred costs no read.
    // The ITEMS rather than their rendering since issue #1465 — the flow renders
    // them itself, with a handle per item and per owned entry, because it has to
    // answer with which one it meant. `readEquipmentItems` is the same reader
    // `readEquipmentContext` folds through for chefChat and authorRecipe, and it
    // is fail-open by construction: a missing doc, a failed `safeParse` or a
    // thrown read all return `[]`, which the flow treats as "no manifest" and
    // answers exactly as it did before. Kit context is an enhancement, never a
    // precondition (Rule 10).
    const equipment = await readEquipmentItems(getFirestore(), 'identifyRecipeKit');

    // No `withAiTimeout` wrapper HERE, following `describeSceneOrNothing` below
    // rather than the image branch above: the flow owns its own deadline
    // (`AI_TRIGGER_FLOW_TIMEOUT`, derived from this function's own
    // `timeoutSeconds`, no retry) and a second wrapper would impose the house 20s
    // default on top of it — cutting the call short and retrying a flow that
    // deliberately does not retry.
    const { kit } = await identifyRecipeKitFlow({
      title: recipe.title.trim(),
      description: recipe.description,
      // Flattened to display lines, as the scene brief flattens them: the flow
      // wants what the dish is made of, not how the list happens to be grouped.
      ingredients: recipe.ingredients.flatMap((g) => g.items.map((i) => i.rawText)),
      // Steps carry their ids — the flow has to answer with the ids this document
      // actually holds, and the sanitiser inside it drops anything else.
      steps: recipe.steps.map((s) => ({ id: s.id, text: s.text })),
      equipment: [...equipment],
    });
    // Partial `.update()`, never a whole-document set: a full write from here would
    // clobber whatever a concurrent client save had just put on the document.
    //
    // Stamping `kitInferredAt` is the whole of the self-termination: this write
    // re-fires the trigger, and the guard's first line sees the stamp and stops.
    // The redo nonce is deliberately LEFT ALONE rather than deleted — deleting it
    // would itself read as a nonce change on that re-fire (`N !== undefined`) and
    // buy a second inference for every redo. It is inert once the stamp is set,
    // which is exactly how `regenerateCanonIcon` leaves `iconRequestedAt` in place.
    await getFirestore().collection('recipes').doc(id).update({
      kit,
      kitInferredAt: Date.now(),
    });
  } catch (err) {
    // Leave `kitInferredAt` unstamped so a redo retries; never block the trigger.
    logger.error('onRecipeWritten: kit inference failed', { id, err });
    // Additive: an AI flow throwing is unexpected, so report it to PostHog alongside
    // the logger. Best-effort, never throws; the handler's finally flushes.
    reportServerError(err);
  }
}

/**
 * Edge-trigger decision for the time re-estimate branch (issue #952, phase 2).
 *
 * Deliberately the NARROWEST of the three guards in this file, and narrower than
 * `kitNeedsInference` directly above in one specific way: **a create does not fire
 * it.** Kit had to fire on create because nothing else in the system ever produces
 * a kit list. Times are different — the librarian and both extractors are asked
 * for all three fields against the definition in `recipeFieldRules`, and
 * `assembleRecipeDraft` reconciles them on the way in. A recipe that has just been
 * authored already has the best answer this codebase can give, so re-asking on
 * create would buy a second AI call per recipe, forever, to second-guess it.
 *
 * Estimate when, and only when: the `timesRequestedAt` nonce CHANGED on this write.
 * That is the backfill script asking, or any future "re-estimate the times" action.
 * The nonce (rather than a bare flag) is what guarantees the request mutates the
 * document at all — Firestore emits no write event for a no-op update, the same
 * reason `kitRequestedAt` and `iconRequestedAt` exist.
 *
 * WHY NOT `timesEstimatedAt === undefined`, which would look like the kit guard.
 * Because that would make every unrelated save of a never-backfilled recipe —
 * canonicalise, per-row rematch, an edit, "apply changes", each a whole-document
 * `setDoc` — fire an AI call, on a library where every pre-#952 recipe is
 * permanently unstamped. The stamp exists for the script's benefit (skip what is
 * already done, resume an interrupted run); the nonce is what gates the branch.
 * They are two fields doing two jobs, which is why both are on the schema.
 *
 * A re-estimate of an already-stamped recipe is therefore possible and cheap: bump
 * the nonce again. The script does that by not skipping when told not to.
 */
export function timesNeedEstimate(before: DocumentSnapshot | undefined, after: RecipeDoc): boolean {
  if (after.timesRequestedAt === undefined) return false; // nobody asked
  // "A create does not fire it" is only true here: without this line, a create
  // whose payload happened to carry the nonce would read as a "nonce changed"
  // (undefined !== N) and fire — the guard's whole contract, restated at
  // `maybeInferKit`'s sibling reasoning above. No live path creates a recipe
  // carrying the nonce today (this is a claim/code mismatch, not a live defect —
  // #952 phase 2 review, should-fix 5), but it is what makes the comment above
  // true rather than true "usually".
  if (!before?.exists) return false;
  return before.data()?.['timesRequestedAt'] !== after.timesRequestedAt;
}

/**
 * Time re-estimate branch. Re-asks how long the recipe actually takes and writes
 * the answer to the phase strip and its one-line summary.
 *
 * BEST-EFFORT (Rule 10), exactly as the kit branch is: a failure logs, reports and
 * leaves `timesEstimatedAt` UNSTAMPED, so re-running the backfill script picks the
 * recipe up again. It never rejects, so the two sibling branches are untouched by
 * it.
 *
 * THE WRITE IS TWO FIELD PATHS AND A STAMP. Not a document `set`, and not a
 * `metadata` object — `update({ 'metadata.phases': … })` addresses the leaves, so
 * `metadata.servings` and `metadata.tags` are not even sent, let alone
 * overwritten. That matters more here than on the other two branches because this
 * one is driven by a script sweeping the whole library: recipes are last-write-wins
 * per WHOLE document (CLAUDE.md → Data model conventions), so a coarser write from
 * a batch pass would be a library-wide opportunity to clobber a concurrent edit.
 *
 * It deliberately does NOT touch `updatedAt`, `lastEditedBy`, `rawText`,
 * ingredients, steps or timers. The flow has no output field for any of them, so
 * that is structural rather than a promise.
 */
async function maybeEstimateTimes(
  id: string,
  recipe: RecipeDoc,
  before: DocumentSnapshot | undefined,
): Promise<void> {
  if (!timesNeedEstimate(before, recipe)) return;

  // A special is a restaurant and a placeholder is a photograph and a title —
  // neither is cooked, so neither has times worth an AI call. Asked through the
  // pure capability predicate, never `kind === 'special'`: what a kind can do is
  // answered in one place (packages/domain/src/recipe/queries/capabilities.ts).
  if (!isCookable(recipe.kind)) return;

  // Nothing to read. A recipe with no method gives the estimate no evidence
  // beyond its title, and a number invented from a title is worse than the
  // optimistic one it would replace.
  if (recipe.steps.length === 0) return;

  // E2E (FUNCTIONS_AI_FAKE): skip entirely, exactly as the other two branches do.
  // Unreachable in production (the flag is never set there).
  if (aiFakeEnabled()) return;

  // The SAME per-environment kill-switch the hero image and the kit use (issue
  // #238), checked only once the cheap in-memory guards pass. It is the "stop this
  // environment spending money generating recipe content" lever, and a sweep of
  // the whole library is the most expensive thing that lever exists for.
  if (!(await isRecipeImageGenerationEnabled())) return;

  try {
    const times = await estimateRecipeTimesFlow({
      title: recipe.title.trim(),
      description: recipe.description,
      servings: recipe.metadata.servings,
      // Flattened to display lines, as the kit and scene branches flatten them:
      // the flow wants what the dish is made of, not how the list is grouped.
      // These lines are most of the prep estimate.
      ingredients: recipe.ingredients.flatMap((g) => g.items.map((i) => i.rawText)),
      // The step's own timer is a FACT the model should not have to re-derive
      // from prose, and it is what separates an unattended prove from time on
      // heat.
      steps: recipe.steps.map((s) => ({
        text: s.text,
        timerMinutes: s.timer?.durationMinutes ?? null,
      })),
    });
    // No `withAiTimeout` wrapper here (issue #915): the flow owns its budget.
    // The phase strip and its summary (issue #1122 review, blocking 1) — merged
    // against the STORED strip by the same `reconcileRecipePhases` function
    // `assembleRecipeDraft` calls, so the two write paths answer "the model
    // returned nothing" identically. The branch's edge trigger (runs only when
    // someone bumped `timesRequestedAt`, never on a plain save) is what protects a
    // hand-edited strip from a routine save; this guard is what protects it from
    // THIS write when the model's answer omitted `phases` — a real case, not a
    // hypothetical one: a recipe already estimated once (Phase 1, Phase 3
    // backfill, or a hand correction) that gets asked again and gets three good
    // numbers back with no strip must keep the strip it had, not lose it while
    // `timesEstimatedAt` is stamped in the same write so the backfill never
    // revisits it.
    const phaseStrip = reconcileRecipePhases(times, recipe.metadata);
    await getFirestore().collection('recipes').doc(id).update({
      'metadata.phases': phaseStrip.phases,
      'metadata.timingSummary': phaseStrip.timingSummary,
      // Stamped in the SAME update as the answer, so "estimated" and "has the
      // new numbers" cannot disagree. The request nonce is left in place rather
      // than deleted — deleting it would read as a nonce change on this write's
      // own re-fire and buy a second estimate every time, which is exactly the
      // trap the kit branch documents.
      timesEstimatedAt: Date.now(),
    });
  } catch (err) {
    // Leave `timesEstimatedAt` unstamped so a re-run retries; never block the
    // trigger.
    logger.error('onRecipeWritten: time estimate failed', { id, err });
    // Additive: an AI flow throwing is unexpected, so report it to PostHog
    // alongside the logger. Best-effort, never throws; the handler's finally
    // flushes.
    reportServerError(err);
  }
}

/**
 * Authors a scene brief for the hero: art direction describing the plated dish,
 * written by a cheap fast-model text call that reads the WHOLE recipe — every
 * ingredient and every step — not just the title/description/tags the image prompt
 * can see. That is how a hero comes to show the blistered top or the torn basil
 * that exist only in the method.
 *
 * BEST-EFFORT (Rule 10): a brief is an improvement to the image prompt, never a
 * precondition for it. Any failure degrades to `undefined`, and the image flow then
 * falls back to its "read the dish yourself" clause — i.e. exactly the behaviour
 * every recipe had before briefs existed. A brief failure must never cost the user
 * their hero, so this never throws.
 */
async function describeSceneOrNothing(recipe: RecipeDoc): Promise<string | undefined> {
  try {
    const { brief } = await describeRecipeSceneFlow({
      title: recipe.title.trim(),
      description: recipe.description,
      // The brief step never used to get these — only the image flow did. For a
      // placeholder that was a hole rather than a missed cue: it has no method
      // and no ingredients, and its mood lives in `tags`, so the prompt's "read
      // the MOOD, which the tags carry" was reading a field nobody sent.
      tags: recipe.metadata.tags,
      // A special has no method and no ingredients for the art director to read,
      // so it gets a prompt that asks what the food looks like as it ARRIVES
      // (issue #637) rather than what it looks like once cooked and plated.
      kind: recipe.kind,
      // Flatten the ingredient groups to their display lines — the flow wants the
      // dish's content, not its grouping.
      ingredients: recipe.ingredients.flatMap((g) => g.items.map((i) => i.rawText)),
      steps: recipe.steps.map((s) => s.text),
      // The dishes a meal is built from (issue #838). A bundle-only meal has no
      // ingredients and no method, so without these the art director's whole
      // input is a title — the case where the blindness costs most.
      //
      // Resolved against Firestore because a CF has no in-memory recipes store;
      // the browser's brief dialog resolves the same meal against that store and
      // renders the lines with the SAME `componentDisplayLines`, so the two
      // callers cannot describe different dinners. `readComponentContext` is a
      // no-op read for a recipe with no components and returns [] on any failure,
      // so this cannot cost a hero.
      components: componentDisplayLines(
        await readComponentContext(getFirestore(), recipe, 'onRecipeWritten'),
      ),
    });
    const trimmed = brief.trim();
    return trimmed || undefined;
  } catch (err) {
    // Non-fatal by construction (we fall back), but a text flow throwing is
    // unexpected — report it additively alongside the logger, best-effort.
    logger.warn('onRecipeWritten: scene brief failed, falling back to the dish-reading prompt', {
      id: recipe.id,
      err,
    });
    reportServerError(err);
    return undefined;
  }
}

/**
 * Reads the per-environment recipe-generation kill-switch (issue #238) from
 * `devSettings/singleton`. Named for the image because that is what it was built
 * for, and deliberately reused unchanged by the kit branch (issue #882) rather
 * than joined by a second flag: it is the one lever that says "this environment is
 * not to spend money generating recipe content", and splitting it would mean
 * turning generation off twice. Fails OPEN: a missing doc, an unexpected shape, or a
 * read error all default to ENABLED, so an environment that never configured the
 * switch keeps generation on and a transient read glitch never silently halts it.
 */
async function isRecipeImageGenerationEnabled(): Promise<boolean> {
  try {
    const snap = await getFirestore().collection('devSettings').doc('singleton').get();
    if (!snap.exists) return true;
    const parsed = DevSettingsSchema.safeParse(snap.data());
    if (!parsed.success) {
      // Expected validation fallback (a doc that doesn't match the schema):
      // NOT reported — a ValidationError-class "expected" outcome, suppressed per
      // policy. The fail-open default + the warn log are the contract.
      logger.warn('onRecipeWritten: invalid devSettings doc, defaulting to enabled');
      return true;
    }
    return parsed.data.recipeImageGenerationEnabled;
  } catch (err) {
    logger.warn('onRecipeWritten: devSettings read failed, defaulting to enabled', { err });
    // A read THROW (vs a shape mismatch above) is a StorageError-class failure.
    // Non-critical (we fail open), but genuinely unexpected, so report it
    // additively — best-effort, never throws.
    reportServerError(err, 'StorageError');
    return true;
  }
}

/** Uploads the hero to Storage and returns its public download URL. */
async function uploadRecipeImage(id: string, webp: Buffer): Promise<string> {
  const bucket = getStorage().bucket();
  const path = `${IMAGE_STORAGE_PREFIX}/${id}.webp`;
  await bucket.file(path).save(webp, {
    contentType: 'image/webp',
    // A regenerate reuses the same object path, so the URL is stable but its
    // BYTES change — do NOT mark it immutable. A short max-age caches within a
    // session while letting a regenerated hero appear without a hard reload.
    metadata: { cacheControl: 'public, max-age=3600' },
  });
  return buildStorageDownloadUrl(bucket.name, path);
}

export const onRecipeWritten = onDocumentWritten(
  {
    document: 'recipes/{id}',
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    // Image generation (~5–8s+) plus sharp encoding need more headroom than the
    // default text-only triggers.
    //
    // The NAMED constant, not a literal (issue #1418): the kit and times flows
    // derive their AI deadline by subtracting recording headroom from this
    // number, and holding it in one place is what stops the two drifting apart.
    // `tests/aiBudgetVsFunctionQuota.test.ts` reads the options object this
    // function is registered with, so putting a literal back here goes red.
    timeoutSeconds: AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS,
    // Serialise image work per instance (Cloud Run scales out instances instead)
    // so a burst of recipe writes can't pack multiple libvips/sharp decodes onto
    // one instance and OOM it — same rationale as onCanonItemWritten. 1GiB gives
    // the single decode comfortable room. Pinned inline because this module loads
    // before index.ts's setGlobalOptions (same reason region is inline).
    concurrency: 1,
    memory: '1GiB',
  },
  withFirestoreTrigger<{ id: string }>(async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;

    const parsed = RecipeSchema.safeParse(after.data());
    if (!parsed.success) {
      logger.error('onRecipeWritten: invalid doc shape, skipping', {
        id: event.params.id,
        error: parsed.error.message,
      });
      return;
    }

    const id = event.params.id;
    // Wait for the OTel pipeline to be live before running so the flow's AI spans
    // are captured by the span processors (issue #370); resolves immediately once
    // warm, and settles (never rejects) on a telemetry-init failure.
    // Three independently-guarded side-effects, as onCanonItemWritten has two.
    // allSettled
    // so a failure in one branch never rejects the handler — a rejection would
    // retry BOTH, paying a second time for the one that had already succeeded. Both
    // are edge-triggered on before→after, so both need the prior snapshot.
    await Promise.allSettled([
      maybeGenerateImage(id, parsed.data, event.data?.before),
      maybeInferKit(id, parsed.data, event.data?.before),
      maybeEstimateTimes(id, parsed.data, event.data?.before),
    ]);
  }, traceContextFromWrittenDoc),
);
