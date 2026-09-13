<script lang="ts">
  import { Button, CanonIcon, EmptyState, Icon, Spinner } from '@salt/ui-components';
  import { onDestroy } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { flattenIngredients, progressOver, recipeChangedSince, stageStatus } from '@salt/domain';
  import type { BatchStageDoc } from '@salt/domain/schemas';
  import { goBack } from '../../lib/nav.js';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import {
    batch,
    initBatchSync,
    getBatchSnapshot,
    advanceStage,
    startStage,
    setIngredientChecked,
    setStepDone,
  } from '../../lib/batchService.js';
  import { observations, initBatchObservationsSync } from '../../lib/batchObservationService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { isWakeLockSupported, createWakeLock } from '../../lib/wakeLock.js';
  import { tick as hapticTick } from '../../lib/haptics.js';
  // The #994 cook parts, reused verbatim: the pager and its geometry, the collapsed
  // row, the kit chips, the done controls, the timeline and the amber banner.
  import { createStepDeck } from '../../lib/stepDeck.svelte.js';
  import { sectionMinHeight, PEEK_MAX_PX } from '../../lib/cookDeck.js';
  import { ingredientIcons, ingredientLabel } from '../../lib/cookIngredientIcons.js';
  import { firstUseByStep, kitByStep, stageTemperatureText } from '@salt/domain';
  import IngredientText from '../recipes/IngredientText.svelte';
  import CookTimeline from '../recipes/CookTimeline.svelte';
  import CookStepCollapsed from '../recipes/CookStepCollapsed.svelte';
  import CookStepKit from '../recipes/CookStepKit.svelte';
  import CookStepDoneControls from '../recipes/CookStepDoneControls.svelte';
  import CookRecipeChangedBanner from '../recipes/CookRecipeChangedBanner.svelte';
  import CookLoadingOrphan from '../recipes/CookLoadingOrphan.svelte';
  // The timer parts, reused exactly as the deck parts above are (issue #1327,
  // Phase 2). `createBatchTimers` widens each kitchen timer into the shape these
  // three already take — see its header for why that is a widening and not a cast.
  import CookTimersBar from '../recipes/CookTimersBar.svelte';
  import CookStepTimer from '../recipes/CookStepTimer.svelte';
  import CookTimerSheet from '../recipes/CookTimerSheet.svelte';
  import { createBatchTimers } from '../../lib/batchTimers.svelte.js';
  import BatchObservationSheet from './BatchObservationSheet.svelte';
  import BatchReadingRow from './BatchReadingRow.svelte';
  import {
    formatGrams,
    formatStatedDuration,
    formatTimeOfDay,
    formatWhen,
    isObservational,
  } from './batchDisplay.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';

  // COOKING A RUN (issue #1327, epic #778) — `/batches/:id/cook`.
  //
  // The app's THIRD full-viewport route, and the third reading of one act. Cook mode
  // is the recipe's own numbers; the guided cook is the same steps through a plan;
  // this is the same steps through a RUNNING BATCH — the frozen grams as the
  // weigh-out, the schedule's stages as bands on the steps they cite, and the
  // schedule's clock where cook mode would arm a timer. Declared in
  // `../fullViewport.ts` and named in `docs/design/ui-spec-v05.md` §2.1, as every
  // member of that list must be; the chrome is never suppressed from in here.
  //
  // ─── WHY THERE IS NO COOK SESSION ─────────────────────────────────────────────
  //
  // The ticks — which components are weighed, which steps are done — live on the
  // BATCH document (`checkedIngredientIds`, `completedStepIds`). A `cookSessions`
  // doc is per user and dies with the cook; a batch is the family's and outlives it.
  // Two people can have hands on one bake, and "the flour is weighed" is a fact
  // about the batch rather than about whoever weighed it — the same argument that
  // already put stage done/skip on this document. Everyone on the run sees everyone
  // else's ticks, deliberately. `docs/formulas-schedules-batches.md` says it
  // outright: a batch is not a cook session and must not be built on one.
  //
  // That is also why none of the session-bound cook modules is here.
  // `cookLifecycle.svelte.ts` and `cookTimers.svelte.ts` stay with the recipe
  // screens; the deck is shared because the deck genuinely is the same deck, which
  // is what the progress seam on `createStepDeck` exists for.
  //
  // ─── WHY THERE IS NO FINISH ───────────────────────────────────────────────────
  //
  // Cook mode ends its session; this page ends nothing. A batch ends when every
  // stage is done or skipped, on the batch page, exactly as today — and for a
  // ferment or a cure the hands-on part is one day of a weeks-long run, so a Finish
  // meaning "the batch is over" would be wrong for two of the three crafts and a
  // Finish meaning "hands off" is just leaving. Back returns to `/batches/:id`.
  //
  // ─── WHY THE SCHEDULE OWNS THE CLOCK ──────────────────────────────────────────
  //
  // A step cited by a WAIT stage with a duration counts down to that stage's
  // `plannedEndAt` and offers no timer — the batch's push reminder already exists
  // for that moment (`onBatchWritten`), and a second clock beside it would be two
  // alarms for one prove. The recipe's own timer for such a step is shown as TEXT:
  // it is the recipe's opinion, and the run's plan is what is actually being waited
  // on. Marking the step done marks the stage done, which re-times the tail through
  // `withStageAdvanced` and lets the existing reminder path re-enqueue.
  //
  // THAT IS A NARROWER SENTENCE THAN "a step with a stage on it", and the narrowness
  // is the point. An `active` stage draws its planned window and NO countdown, and
  // `remindableStages` fires at a stage's `plannedStartAt` — "put them in", never
  // "take them out". THE BAKE IS `active` (pinned verbatim in `STAGE_KIND_RULES`),
  // so a rule that read "any stage" would leave the one step where burning is the
  // failure mode with no clock and no alarm at all. An observational stage
  // (`duration: null`) has nothing to count down either, by definition.
  //
  // ─── AND WHY THE OTHER STEPS GET A TIMER ──────────────────────────────────────
  //
  // The other four steps of a bread — mix, knead, shape, vent — have no stage and
  // so no clock at all, which is what Phase 1 shipped and lived with. They take an
  // ordinary press-to-start timer now (Phase 2, decision 9), on the member's OWN
  // `kitchenTimers/{uid}` document and never on the batch: two people on one bake
  // each have their own ten minutes of kneading, and a timer is a personal thing
  // even when the loaf is not. What is new on that document is `origin` — an
  // additive, read-defaulted `{ batchId, stepId }` that is a deep link and a display
  // key and nothing else. It is what lets the deck show a timer ON its step from an
  // id rather than by matching label text, and the finished-timer push land back
  // here rather than on Mine. It is NOT scoping: the timer is read and written under
  // its owner's uid exactly as before.
  //
  // Every number on screen that belongs to the run is the run's own frozen figure;
  // the METHOD is read live from the recipe, which is the one join the batch page
  // deliberately does not make. That is why the recipe-updated banner belongs here
  // and not there — and why it carries no Restart: the grams are frozen by design,
  // so there is nothing to restart (a fresh run is a fresh run).

  let { params }: { params?: { id?: string } } = $props();

  const batchId = $derived(params?.id ?? '');

  $effect(() => {
    if (!batchId) return;
    return initBatchSync(batchId);
  });

  // The log rides on its own subscription, as it does on the batch page: an
  // observational stage shows the latest reading taken against it, and the header
  // pencil writes into the same collection.
  $effect(() => {
    if (!batchId) return;
    return initBatchObservationsSync(batchId);
  });

  // Three states, all different sentences: `undefined` still loading, `null` a link
  // to a run that is not there, a document the run.
  const run = $derived($batch);
  // The LIVE recipe, for the method alone. `null` while the library loads and
  // `null` for a dish that has since been deleted — the run survives either.
  const recipe = $derived(run ? ($recipes.find((r) => r.id === run.recipeId) ?? null) : null);
  const steps = $derived(recipe?.steps ?? []);

  // ─── The ticks ────────────────────────────────────────────────────────────────
  const checkedIds = $derived(new Set(run?.checkedIngredientIds ?? []));
  const completedIds = $derived(new Set(run?.completedStepIds ?? []));

  // ─── The weigh-out ────────────────────────────────────────────────────────────
  //
  // The batch's own `quantities`, grams leading and the percentage muted under it —
  // this is what mise en place IS for a run, and the one place a scaled number is
  // ever shown (the recipe never shows one). The label is the recipe's own line as
  // it was when the run started; the picture is joined against the LIVE recipe by
  // ingredient id, so a row whose ingredient has since gone keeps its words and
  // loses only its tile.
  //
  // Recipe-only ingredients — the crushed vitamin C tablet the formula has no
  // percentage for — come after, as written, with no batch quantity. They are as
  // real a part of the weigh-out as the flour, and dropping them would send someone
  // to the recipe page mid-bake.
  const liveIngredients = $derived(recipe ? flattenIngredients(recipe) : []);
  const ingredientById = $derived(new Map(liveIngredients.map((ing) => [ing.id, ing])));
  const quantityById = $derived(new Map((run?.quantities ?? []).map((q) => [q.ingredientId, q])));
  const extraIngredients = $derived(liveIngredients.filter((ing) => !quantityById.has(ing.id)));
  // Counted over the rows ON SCREEN, never over the stored id list — a tick left
  // behind by an edited-away ingredient must not inflate the count (`progressOver`).
  const miseIds = $derived([
    ...(run?.quantities ?? []).map((q) => q.ingredientId),
    ...extraIngredients.map((ing) => ing.id),
  ]);
  const mise = $derived(progressOver(miseIds, checkedIds));

  // ─── Where the stages sit in the method ───────────────────────────────────────
  //
  // Stages are ANNOTATIONS ON THE METHOD, not a replacement for it: the deck is
  // every recipe step in recipe order, and a stage rides on the step it cites.
  //
  // A stage with no step — an added fridge retard, or one whose citation the
  // extraction dropped as hallucinated — gets a card of its own, after the previous
  // stage's step, or before the first step when it is the first stage. Never
  // hidden: `extractProcessStages` drops the citation and never the stage, so a
  // `stepId` of `null` is as real a stage as any other and nothing here gates on it.
  interface StagePlacement {
    stage: BatchStageDoc;
    /** 1-based, over the run's whole stage list — what the band counts. */
    number: number;
  }
  const layout = $derived.by(() => {
    const stages = run?.stages ?? [];
    const stepIds = new Set(steps.map((s) => s.id));
    const onStep = new Map<string, StagePlacement>();
    const after = new Map<string, StagePlacement[]>();
    const leading: StagePlacement[] = [];
    let anchor: string | null = null;
    stages.forEach((stage, index) => {
      const placement: StagePlacement = { stage, number: index + 1 };
      // A second stage citing a step the first already claimed becomes a card of its
      // own rather than overwriting the band — two stages are two stages.
      if (stage.stepId !== null && stepIds.has(stage.stepId) && !onStep.has(stage.stepId)) {
        onStep.set(stage.stepId, placement);
        anchor = stage.stepId;
        return;
      }
      if (anchor === null) leading.push(placement);
      else {
        const list = after.get(anchor);
        if (list) list.push(placement);
        else after.set(anchor, [placement]);
      }
    });
    return { onStep, after, leading, total: stages.length };
  });

  // ─── The deck ─────────────────────────────────────────────────────────────────
  let stage = $state<'mise' | 'steps'>('mise');
  let peekedStepId = $state<string | null>(null);

  const stepDeck = createStepDeck({
    steps: () => steps,
    // Completion lives on the BATCH here — the seam issue #1327 gave the deck.
    completedStepIds: () => completedIds,
    setStepDone: (id, done) => void markStep(id, done),
    stage: () => stage,
    setStage: (next) => {
      stage = next;
    },
    setPeeked: (id) => {
      peekedStepId = id;
    },
  });
  const deck = stepDeck.deck;
  const {
    stepAnchor,
    peekStep,
    untickStep,
    handleStepDone,
    handleResume,
    jumpToStep,
    goToSteps,
    goToMise,
  } = stepDeck;
  const currentStep = $derived(stepDeck.currentStep);
  const currentStepDone = $derived(stepDeck.currentStepDone);
  const nextIncompleteStep = $derived(stepDeck.nextIncompleteStep);
  const nextIncompleteNumber = $derived(stepDeck.nextIncompleteNumber);
  const fadeHeight = $derived(stepDeck.fadeHeight);
  const showTimeline = $derived(stage === 'steps' && steps.length > 1);
  const stepProgress = $derived(
    progressOver(
      steps.map((s) => s.id),
      completedIds,
    ),
  );

  const firstUse = $derived(recipe ? firstUseByStep(recipe.ingredients) : new Map());
  const kit = $derived(kitByStep(recipe?.kit ?? [], steps));

  // ─── The timers ───────────────────────────────────────────────────────────────
  //
  // Mine, armed from this run, on the steps the schedule does not already time. The
  // sheet's open flag lives here because the markup binds it.
  let timerSheetOpen = $state(false);
  const timers = createBatchTimers({
    batchId: () => batchId,
    showSheet: () => (timerSheetOpen = true),
  });

  // WHICH STEPS OFFER ONE, in one place so the page cannot answer it two ways.
  //
  // The test is "is a clock already ticking on this step", not "does it wear a
  // band" — and those are different questions. The countdown below renders for a
  // `wait` stage only, and an observational stage has no end to count to, so a step
  // carrying an `active` or an observational stage has a planned window and nothing
  // else. Those steps take a timer exactly as a stage-less step does; only a step a
  // wait stage is genuinely counting down is refused one, because that is the only
  // case where a second alarm would be two for one prove. Every branch of that
  // sentence is pinned in `BatchCookPage.test.ts`.
  function stepTakesTimer(stepId: string): boolean {
    const placement = layout.onStep.get(stepId);
    if (placement === undefined) return true;
    return placement.stage.kind !== 'wait' || isObservational(placement.stage);
  }

  // ─── Writing ──────────────────────────────────────────────────────────────────
  //
  // NOTHING ON THIS PAGE WAITS FOR A WRITE. There is no lock, no `disabled` gate
  // and no in-flight flag anywhere in this section, and that is the whole of the
  // rule (issue #1365, fault 4).
  //
  // WHY A LOCK CANNOT WORK HERE. Firestore's `setDoc` does not resolve while
  // offline: the write is durably queued by `persistentLocalCache` and lands when
  // signal returns, but its promise stays pending, possibly for hours. Any UI state
  // released when that promise settles is therefore unbounded BY CONSTRUCTION, and
  // `try/finally` does not help — `finally` runs when a promise settles and this one
  // does not. That is not a hypothesis: `markStep` below already had a `try/finally`
  // and latched anyway, greying out both controls gated on the old `writing` boolean
  // for the rest of the visit. The weigh-out ticks were taken off that lock for
  // exactly this reason (PR #1334 review, BLOCKING #3); the note doing so named the
  // hazard and then left it standing for the two controls that kept the lock.
  //
  // WHAT REPLACES IT. `persist` (`batchService.ts:163-175`) stamps the document,
  // sets the local store and only THEN starts the round trip. So:
  //
  //   • the document this page renders is already the new one the instant a command
  //     has been CALLED — no resolution required — and `getBatchSnapshot()` answers
  //     with it synchronously. Every command below builds from that read, so a burst
  //     of taps composes correctly and in order, on its own;
  //   • the awaited promise carries exactly ONE extra fact — whether the network
  //     write failed — which is only ever used for a toast. Nothing the cook can see
  //     or press is derived from it.
  //
  // Re-entrancy is guarded on the DOCUMENT rather than on a flag: a step already
  // ticked is not re-ticked, a stage already done or skipped is not re-advanced.
  // A flag would have to be cleared by something, and the only candidate is the
  // promise that never settles.
  //
  // WHAT THIS GUARANTEES, AND WHAT IT DOES NOT (CLAUDE.md rule 12). It guarantees
  // that no control here is ever disabled by a write in flight, and that every write
  // a gesture implies is DISPATCHED before that gesture returns rather than
  // sequenced behind a network promise — both pinned by the stuck-write tests in
  // `BatchCookPage.test.ts`. It does NOT guarantee the write reaches Firestore, that
  // a failure is reported promptly (offline, the toast arrives whenever the promise
  // finally settles, and may not arrive at all this visit), or that two phones
  // tapping one stage produce a single write. Those are `persistentLocalCache`'s
  // job, unknowable offline, and document-level LWW as designed, respectively.

  async function markStep(stepId: string, done: boolean): Promise<void> {
    const current = getBatchSnapshot() ?? run;
    if (!current) return;

    if (!done) {
      // UNTICKING IS A SINGLE WRITE, not the two-write advance below.
      //
      // UNTICKING DOES NOT UN-MARK THE STAGE. There is no inverse of
      // `withStageAdvanced` and there deliberately is not one: the tail has
      // already been re-timed against the instant the stage ended, and
      // "un-ending" it would have to invent a schedule nobody planned. Unticking a
      // step is a correction to the METHOD's checklist; the run's record of what
      // happened stands, and the batch page is where a run is corrected.
      const result = await setStepDone(current, stepId, false);
      if (result.kind !== 'ok') addToast("Couldn't save that. Try again.", 'destructive');
      return;
    }

    // THE TICK. Dispatched, not awaited — see the note above. Already ticked means a
    // double tap or the other phone got there first, and a second whole-document
    // write saying the same thing is worth nothing.
    if (!current.completedStepIds.includes(stepId)) {
      void setStepDone(current, stepId, true).then((ticked) => {
        if (ticked.kind !== 'ok') addToast("Couldn't save that. Try again.", 'destructive');
      });
    }

    // MARKING THE STEP OF A STAGE MARKS THE STAGE. That write is the one the whole
    // reminder engine hangs off: `withStageAdvanced` re-times every later stage
    // from this instant and `onBatchWritten` re-queues the reminders whose key
    // moved — exactly what Done does on the batch page. Early and late are the
    // same gesture.
    const placement = layout.onStep.get(stepId);
    if (!placement) return;

    // Re-read the FRESHEST copy before this second write. Two things ride on this
    // one read:
    //
    //   • CORRECTNESS. The round trip is exactly the window a concurrent write from
    //     another phone on the same run lands in, and handing the advance a stale
    //     document would silently overwrite it (PR #1334 review, BLOCKING #1).
    //   • LIVENESS. It is also what makes the advance independent of the tick's
    //     NETWORK promise rather than sequenced behind it. `persist` has already put
    //     the ticked document in the store, so there is nothing left to wait for.
    //     This used to be `await setStepDone(...)`, and offline that await never
    //     returned — so the second write never went out AT ALL. The step was ticked
    //     locally and its stage silently left open, with no `actualEndAt` and no
    //     re-timed tail, which no reload could recover.
    const freshest = getBatchSnapshot() ?? current;

    // THE TICK HAS TO HAVE LANDED LOCALLY. This is the guard that used to be
    // "the tick's promise resolved ok", which offline is a promise that never
    // resolves. The local document is this page's truth, so the question the advance
    // actually needs answered is whether that document now says the step is done —
    // and `persist` answers it synchronously, offline included. A tick that never
    // reached the store (`withBatchStepDone` returned the same document, or the
    // write refused before persisting) does not get a stage advance on top of it.
    if (!freshest.completedStepIds.includes(stepId)) return;

    // Read the stage off the freshest document too, not off `layout` — the same
    // concurrent write could have marked or skipped it in the meantime.
    const stageDoc = freshest.stages.find((s) => s.id === placement.stage.id) ?? placement.stage;
    const status = stageStatus(stageDoc);
    if (status === 'done' || status === 'skipped') return;

    void advanceStage(freshest, placement.stage.id).then((advanced) => {
      if (advanced.kind !== 'ok') {
        addToast("Couldn't mark that stage done. Try again.", 'destructive');
      }
    });
  }

  async function toggleIngredient(id: string): Promise<void> {
    const current = run;
    if (!current) return;
    const next = !checkedIds.has(id);
    if (next) hapticTick();
    // Fire-and-forget, like `CookModePage.toggleIngredient` — see the note above
    // `markStep` for why nothing here waits on a write.
    const result = await setIngredientChecked(current, id, next);
    if (result.kind !== 'ok') addToast("Couldn't save that. Try again.", 'destructive');
  }

  // Marking a STAGE-ONLY card done — it has no step to tick, so this is the batch
  // page's own Done, on the same producer, reached from here. One write, where
  // `markStep` is two.
  async function markStageDone(stageId: string): Promise<void> {
    const current = getBatchSnapshot() ?? run;
    if (!current) return;
    // Re-entrancy on the document, not on a flag: the second tap of a double tap
    // reads a stage this page has already advanced locally.
    const stageDoc = current.stages.find((s) => s.id === stageId);
    if (!stageDoc) return;
    const status = stageStatus(stageDoc);
    if (status === 'done' || status === 'skipped') return;
    // Awaited only to say whether it failed. Nothing on the page is gated on it, so
    // an await that never returns costs a toast that never arrives and nothing else.
    const result = await advanceStage(current, stageId);
    if (result.kind !== 'ok') addToast("Couldn't mark that stage done. Try again.", 'destructive');
  }

  // STARTING a stage from the deck — the batch page's own Start, on the same
  // producer, reached from here (issue #1365). Started-without-done is a first-class
  // state, not a lesser Done: `docs/formulas-schedules-batches.md` :237-239 has it
  // recording overlap without planning it, and until now the deck could only say
  // "finished" about a stage you had merely begun.
  //
  // Like every other command in this section it holds nothing across its write; see
  // the note above `markStep`. `withStageStarted` re-times nothing, so this is one
  // whole-document write built from the freshest local snapshot.
  async function markStageStarted(stageId: string): Promise<void> {
    const current = getBatchSnapshot() ?? run;
    if (!current) return;
    const stageDoc = current.stages.find((s) => s.id === stageId);
    if (!stageDoc || stageStatus(stageDoc) !== 'notStarted') return;
    const result = await startStage(current, stageId);
    if (result.kind !== 'ok') addToast("Couldn't start that stage. Try again.", 'destructive');
  }

  // ─── The clock ────────────────────────────────────────────────────────────────
  //
  // One ticker for the whole page, driving every wait-stage countdown. Nothing is
  // written and nothing is derived FROM it except words: the planned end is on the
  // document and this only says how far off it is.
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  /** How long until (or how long past) an instant, in the words a cook wants. */
  function countdown(iso: string): string {
    const endMs = Date.parse(iso);
    if (!Number.isFinite(endMs)) return '';
    const minutes = Math.round((endMs - nowMs) / 60_000);
    const magnitude = Math.abs(minutes);
    // `formatMinutes` — never a page-local fork of it. #933 retired the `1 h 30
    // min` spelling everywhere else; re-deriving it here would put it right back
    // next to `formatStatedDuration`'s `1 hr 30 min` in the same block (PR #1334
    // review, SHOULD-FIX #5).
    const span = formatMinutes(magnitude);
    if (minutes <= -1) return `${span} over`;
    if (minutes < 1) return 'due now';
    return `${span} left`;
  }

  /** The latest reading logged against a stage — an observational stage's only news. */
  function latestReading(stageId: string) {
    const log = $observations ?? [];
    // The adapter orders ascending by `at` (when it was OBSERVED), so the last
    // matching entry is the most recent reading. Never re-sorted here.
    return log.filter((entry) => entry.stageId === stageId).at(-1) ?? null;
  }

  // ─── Staleness ────────────────────────────────────────────────────────────────
  //
  // An ORDERING against the run's start, not `hasRecipeChanged`'s inequality: a
  // batch snapshots no `updatedAt`, so there is no stamp to be unequal to. No
  // Restart — see the header comment.
  const recipeChanged = $derived(
    recipeChangedSince(run?.createdAt ?? null, recipe?.updatedAt ?? null),
  );

  // ─── The log, from here ───────────────────────────────────────────────────────
  let logOpen = $state(false);

  // ─── Keep awake ───────────────────────────────────────────────────────────────
  const wakeLockSupported = isWakeLockSupported();
  const wake = wakeLockSupported ? createWakeLock() : null;
  let keepAwake = $state(false);
  let togglingWakeLock = false;
  onDestroy(() => void wake?.disable());

  async function toggleWakeLock(): Promise<void> {
    if (togglingWakeLock) return;
    togglingWakeLock = true;
    try {
      if (keepAwake) {
        await wake?.disable();
        keepAwake = false;
        addToast('Screen can sleep again', 'success');
        return;
      }
      // Report what actually happened: `enable()` resolves false when the browser or
      // OS refuses, and the toggle must not claim a lock it never got.
      const acquired = (await wake?.enable()) ?? false;
      keepAwake = acquired;
      if (acquired) addToast('Screen will stay awake', 'success');
      else addToast("Your browser wouldn't let the screen stay awake.", 'destructive');
    } finally {
      togglingWakeLock = false;
    }
  }

  // Focus entry for a full-viewport route (ui-spec-v05 §2.4). The chrome that had
  // focus is unmounted as this route activates, so without this the next Tab would
  // restart at the top of the document. No restore on the way out: this page is
  // entered from the batch page, which unmounts as it opens.
  //
  // An `$effect` over `pageEl` rather than `onMount`: `pageEl` is bound INSIDE
  // `FeatureGuard`, which renders no children — and so never runs the `bind:this`
  // — until the flag settles, well after this component's own `onMount` already
  // fired. `onMount` therefore focused nothing, on every load (PR #1334 review,
  // BLOCKING #4). The effect re-runs when `pageEl` changes, so it catches the
  // element the moment the guard actually mounts it.
  let pageEl = $state.raw<HTMLElement | null>(null);
  $effect(() => {
    pageEl?.focus({ preventScroll: true });
  });

  function close(): void {
    goBack(`/batches/${batchId}`);
  }
</script>

<FeatureGuard feature="bread">
  <!-- `z-dialog` (50) and `fixed inset-0`, the rung ui-spec-v02 §4.1 gives a
     full-viewport route. `tabindex="-1"` makes the container a programmatic focus
     target and is not a tab stop; no `role="dialog"` — this is a route, not a layer
     (ui-spec-v05 §2.6). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={pageEl}
    tabindex="-1"
    class="z-dialog fixed inset-0 flex h-dvh flex-col bg-background focus:outline-none"
    data-testid="batch-cook-page"
  >
    {#if run === undefined}
      <div class="flex flex-1 items-center justify-center"><Spinner /></div>
    {:else if run === null}
      <div class="flex flex-1 flex-col items-center justify-center p-6">
        <EmptyState title="Batch not found" description="It may have been deleted." />
        <Button variant="outline" onclick={close} data-testid="batch-cook-back">Back</Button>
      </div>
    {:else if run.state === 'abandoned'}
      <!-- BLOCKING #2 (PR #1334 review): a stopped run offers nothing to mark
         done. `BatchDetailPage`'s Cook button only shows while `run.state ===
         'running'`, but this page is reachable by direct URL or back/forward
         regardless, and it must not accept a tick or an advance from a run
         nobody is running any more. This branch is the WHOLE of that guard —
         none of `markStep`/`toggleIngredient`/`markStageDone` re-checks
         `state`, exactly as `BatchDetailPage`'s stage handlers rely solely on
         `next?.kind !== 'abandoned'` hiding their own controls rather than
         also checking inside `handleAdvance` — one gate, not two copies of it
         to keep in step. Reactive, too: abandoning mid-visit replaces this
         content live, taking every control with it. -->
      <div class="flex flex-1 flex-col items-center justify-center p-6">
        <EmptyState
          title="This batch was abandoned"
          description="There's nothing left to cook here."
        />
        <Button variant="outline" onclick={close} data-testid="batch-cook-back">
          Back to the batch
        </Button>
      </div>
    {:else}
      <header class="flex shrink-0 items-center gap-3 px-4 py-3 {showTimeline ? '' : 'border-b'}">
        <Button
          variant="ghost"
          size="icon"
          onclick={close}
          ariaLabel="Back to the batch"
          title="Back to the batch"
          data-testid="batch-cook-close"
        >
          {#snippet leading()}<Icon name="ArrowLeft" size={20} />{/snippet}
        </Button>
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-base font-semibold" data-testid="batch-cook-title">
            {run.recipeTitle}
          </span>
          <span class="text-xs text-muted-foreground" data-testid="batch-cook-subtitle">
            {#if stage === 'mise'}
              Weigh out · {mise.checked}/{mise.total} ready
            {:else}
              Step {stepProgress.checked}/{stepProgress.total} done
            {/if}
          </span>
        </div>
        <!-- THE LOG IS THE DOOR THAT STAYS OPEN. The same sheet the batch page has,
           defaulting to the stage in hand, so a reading mid-bake does not mean going
           back to the desk view. -->
        <Button
          variant="ghost"
          size="icon"
          onclick={() => (logOpen = true)}
          ariaLabel="Log a reading"
          title="Log a reading"
          data-testid="batch-cook-log"
        >
          {#snippet leading()}<Icon
              name="Pencil"
              size={20}
              class="text-muted-foreground"
            />{/snippet}
        </Button>
        <!-- A timer for something the recipe never mentioned. Beside the log rather
           than in the deck, because it belongs to the whole cook and not to
           whichever step happens to be under the thumb. -->
        <Button
          variant="ghost"
          size="icon"
          onclick={timers.openAdHocTimerSheet}
          ariaLabel="Set a timer"
          title="Set a timer"
          data-testid="batch-cook-timer-add"
        >
          {#snippet leading()}<Icon
              name="Timer"
              size={20}
              class="text-muted-foreground"
            />{/snippet}
        </Button>
        {#if wakeLockSupported}
          <Button
            variant="ghost"
            size="icon"
            onclick={() => void toggleWakeLock()}
            ariaLabel="Keep screen awake"
            title={keepAwake ? 'Screen stays awake' : 'Keep screen awake'}
            aria-pressed={keepAwake}
            data-testid="batch-cook-wakelock"
            data-active={keepAwake}
          >
            {#snippet leading()}
              <span
                class="relative inline-flex transition-colors {keepAwake
                  ? 'text-warning'
                  : 'text-muted-foreground'}"
              >
                <Icon name="Smartphone" size={20} />
                <Icon
                  name="Lock"
                  size={14}
                  class="absolute -right-1 -bottom-1 rounded-full bg-background"
                />
              </span>
            {/snippet}
          </Button>
        {/if}
      </header>

      {#if showTimeline}
        <CookTimeline
          {steps}
          completedStepIds={completedIds}
          currentStepId={currentStep?.id ?? null}
          onJump={jumpToStep}
        />
      {/if}

      {#if timers.barTimers.length > 0}
        <!-- THE PERSISTENT BAR, cook mode's own component. Every timer armed from
           this run stays here whatever the deck is showing, so one that fires while
           the chef is on the weigh-out — or on a step that has since collapsed —
           is always visible and always dismissable. -->
        <CookTimersBar
          timers={timers.barTimers}
          {steps}
          now={timers.now}
          progressFor={timers.timerProgressFor}
          onEdit={timers.openRunningTimerSheet}
          onDismiss={timers.dismissTimer}
        />
      {/if}

      {#if recipeChanged}
        <!-- No Restart: the batch's grams are frozen by design and re-freezing them
           against a moved recipe would be a new run, not a restart. -->
        <CookRecipeChangedBanner
          message="This recipe was updated after this batch started. The batch's own amounts and times are unchanged."
        />
      {/if}

      {#if stage === 'mise'}
        <main class="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="batch-cook-mise">
          <div class="mx-auto flex max-w-2xl flex-col gap-2">
            <p class="text-xs text-muted-foreground" data-testid="batch-cook-frozen-note">
              These grams were worked out when the batch started. Editing the recipe or its formula
              afterwards won't change one.
            </p>
            {#each run.quantities as quantity (quantity.ingredientId)}
              {@const checked = checkedIds.has(quantity.ingredientId)}
              {@const live = ingredientById.get(quantity.ingredientId)}
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                  ? 'border-primary/40 bg-primary/5'
                  : 'bg-card hover:bg-muted/50'}"
                onclick={() => void toggleIngredient(quantity.ingredientId)}
                aria-pressed={checked}
                data-testid="batch-cook-mise-row"
                data-ingredient-id={quantity.ingredientId}
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input'}"
                  data-testid="batch-cook-mise-check"
                >
                  {#if checked}<Icon name="Check" size={18} />{/if}
                </span>
                <CanonIcon
                  thumbnail={live ? $ingredientIcons.thumbnailFor(live) : null}
                  name={live ? ingredientLabel(live) : quantity.label}
                  version={live ? $ingredientIcons.iconVersionFor(live) : undefined}
                  dimmed={checked}
                  size={40}
                />
                <span class="min-w-0 flex-1 text-base {checked ? 'text-muted-foreground' : ''}">
                  {#if quantity.label === ''}
                    <!-- The ingredient had already left the recipe when this run
                       started: a blank reads as "we no longer know what this was",
                       which is true. An id would read as gibberish. -->
                    <span class="italic text-muted-foreground">no longer in the recipe</span>
                  {:else}
                    {quantity.label}
                  {/if}
                </span>
                <!-- GRAMS LEAD, percent muted underneath: the figure you set the
                   scale to is the one the eye should land on. -->
                <span class="shrink-0 text-right">
                  <span
                    class="block text-lg font-semibold tabular-nums"
                    data-testid="batch-cook-mise-grams"
                  >
                    {formatGrams(quantity.grams)}
                  </span>
                  <span class="block text-xs tabular-nums text-muted-foreground">
                    {quantity.percent}%
                  </span>
                </span>
              </button>
            {/each}

            {#each extraIngredients as ingredient (ingredient.id)}
              {@const checked = checkedIds.has(ingredient.id)}
              <!-- AS WRITTEN, with no batch quantity — the formula has no percentage
                 for it and inventing one would be arithmetic the freeze never did. -->
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                  ? 'border-primary/40 bg-primary/5'
                  : 'bg-card hover:bg-muted/50'}"
                onclick={() => void toggleIngredient(ingredient.id)}
                aria-pressed={checked}
                data-testid="batch-cook-mise-extra"
                data-ingredient-id={ingredient.id}
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input'}"
                >
                  {#if checked}<Icon name="Check" size={18} />{/if}
                </span>
                <CanonIcon
                  thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                  name={ingredientLabel(ingredient)}
                  version={$ingredientIcons.iconVersionFor(ingredient)}
                  dimmed={checked}
                  size={40}
                />
                <span class="min-w-0 flex-1 text-base {checked ? 'text-muted-foreground' : ''}">
                  <IngredientText {ingredient} />
                </span>
              </button>
            {/each}
          </div>
        </main>
      {:else}
        <!-- The deck. Not a scroll container: `$lib/deck` owns the drag, the fling
           and the spring. The two a11y silences are cook mode's, for cook mode's
           reason — this element replaces a native scroller, which is focusable and
           arrow-key operable for free. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <main
          bind:this={deck.viewportEl}
          class="relative min-h-0 flex-1 touch-pinch-zoom overflow-hidden salt-focus-ring-inset"
          data-testid="batch-cook-steps"
          tabindex="0"
          aria-label="The method, stage by stage"
          onpointerdown={deck.handlePointerDown}
          onpointermove={deck.handlePointerMove}
          onpointerup={deck.handlePointerUp}
          onpointercancel={deck.handlePointerUp}
          onwheel={deck.handleWheel}
          onkeydown={deck.handleKeyDown}
        >
          {#if recipe === null}
            <!-- STILL LOADING, OR GONE — and they are not the same sentence (issue
               #1365). `recipe` is `null` for both, so this used to read "Loading the
               method…" forever for a run whose dish had been deleted. The split is
               the recipe store's own loading flag, which `CookLoadingOrphan` already
               owns for the two recipe cook screens; what is batch-specific is only
               the words and the way out, which it now takes as props.

               The copy says NOTHING about a session being closed: there is no cook
               session here (see the header), the run is untouched by the deletion,
               and the way out is the run itself. -->
            <div class="flex h-full flex-col">
              <CookLoadingOrphan
                deletedTitle="This recipe was deleted"
                deletedDescription="The method lived on the recipe, which no longer exists. The run itself is fine — its grams, stages and readings are all on the batch."
                backLabel="Back to the batch"
                onBack={() => push(`/batches/${batchId}`)}
              />
            </div>
          {:else if steps.length === 0}
            <div class="flex h-full flex-col items-center justify-center p-6">
              <EmptyState
                title="This recipe has no steps"
                description="The stages are still on the batch page."
              />
            </div>
          {/if}
          <div
            bind:this={deck.contentEl}
            class="will-change-transform"
            style="transform: translate3d(0, {-deck.offset}px, 0); padding-bottom: {PEEK_MAX_PX}px"
            data-testid="batch-cook-deck"
          >
            {#snippet stageCard(placement: StagePlacement)}
              {@const stageDoc = placement.stage}
              {@const status = stageStatus(stageDoc)}
              <!-- A STAGE WITH NO STEP, in sequence and never hidden. It carries its
                 own Done because the footer acts on steps and this is not one. -->
              <section
                class="mx-4 my-3 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-4"
                data-testid="batch-cook-stage-card"
                data-stage-id={stageDoc.id}
                data-status={status}
              >
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  <span class="font-semibold">Stage {placement.number} of {layout.total}</span>
                  <span class="font-medium">{stageDoc.label}</span>
                  <span class="text-xs uppercase tracking-wide text-muted-foreground">
                    {stageDoc.kind === 'wait' ? 'wait' : 'active'}
                  </span>
                </div>
                {@render stageFacts(stageDoc)}
                {#if status === 'notStarted' || status === 'inProgress'}
                  <!-- MARK DONE LEADS, START FOLLOWS — `BatchDetailPage.svelte`
                     :726-757's pairing for the stage in hand, which on this screen is
                     every stage card there is. The batch page reads a whole list at
                     once and can tell the stage in hand from one further down the
                     queue (`isCurrent`); the deck pages through the method one card
                     at a time, so the card under the thumb IS the one in hand and
                     there is no second case to distinguish. That is the boundary of
                     the mirroring, stated rather than implied: this renders the
                     sibling's current-stage shape on every card, and deliberately
                     does not import its `isCurrent` split.

                     Start appears only while the stage has not begun — once it has,
                     there is nothing left to record but the end. -->
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onclick={() => void markStageDone(stageDoc.id)}
                      data-testid="batch-cook-stage-done"
                    >
                      {#snippet leading()}<Icon name="Check" size={16} />{/snippet}
                      Mark done
                    </Button>
                    {#if status === 'notStarted'}
                      <Button
                        size="sm"
                        variant="outline"
                        onclick={() => void markStageStarted(stageDoc.id)}
                        data-testid="batch-cook-stage-mark-started"
                      >
                        {#snippet leading()}<Icon name="Play" size={16} />{/snippet}
                        Start
                      </Button>
                    {/if}
                  </div>
                {/if}
              </section>
            {/snippet}

            {#snippet stageFacts(stageDoc: BatchStageDoc)}
              {@const status = stageStatus(stageDoc)}
              {@const stated = formatStatedDuration(stageDoc.duration)}
              <div class="flex flex-col gap-1 text-sm">
                {#if stageDoc.skipped !== null}
                  {@const skip = stageDoc.skipped}
                  <!-- A SKIPPED STAGE SHOWS WHAT HAPPENED, NOT WHAT WAS PLANNED —
                     `BatchDetailPage.svelte:602-615` word for word, because the deck
                     and the batch page must not tell two stories about one bake
                     (issue #1365). Its `plannedStartAt`/`plannedEndAt` are still on
                     the document deliberately (`docs/formulas-schedules-batches.md`
                     :236-238 — a skip leaves them alone), and they are now
                     meaningless, so they are not rendered. This branch leads, so it
                     also takes the observational stage below it and the wait-stage
                     countdown out: there is nothing to count down to for a stage that
                     will never run. `stageFacts` renders on both the stage card and
                     the step band, so one guard covers both surfaces. -->
                  <span class="text-muted-foreground" data-testid="batch-cook-stage-skipped">
                    Skipped {formatWhen(skip.at)}
                  </span>
                  {#if skip.note !== ''}
                    <span data-testid="batch-cook-stage-skipped-note">{skip.note}</span>
                  {/if}
                {:else if isObservational(stageDoc)}
                  <span class="text-muted-foreground" data-testid="batch-cook-stage-observational">
                    No fixed time — mark it done when it's ready.
                  </span>
                  {#if latestReading(stageDoc.id)}
                    {@const reading = latestReading(stageDoc.id)!}
                    <div
                      class="rounded border border-border p-2"
                      data-testid="batch-cook-stage-reading"
                    >
                      <BatchReadingRow run={run!} entry={reading} when={formatWhen(reading.at)} />
                    </div>
                  {/if}
                {:else}
                  <span
                    class="tabular-nums text-muted-foreground"
                    data-testid="batch-cook-stage-window"
                  >
                    {formatTimeOfDay(stageDoc.plannedStartAt)}–{formatTimeOfDay(
                      stageDoc.plannedEndAt,
                    )}
                  </span>
                  <!-- THE SCHEDULE'S CLOCK, and the only one on a wait stage. Nothing
                     is armed for it: the run's own push reminder already exists for
                     this moment. -->
                  {#if stageDoc.kind === 'wait' && (status === 'notStarted' || status === 'inProgress')}
                    <span class="font-medium tabular-nums" data-testid="batch-cook-stage-countdown">
                      {countdown(stageDoc.plannedEndAt)}
                    </span>
                  {/if}
                {/if}
                <div
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                >
                  {#if stated !== null}
                    <span data-testid="batch-cook-stage-stated">Recipe says {stated}</span>
                  {/if}
                  {#if stageDoc.environment !== null}
                    <span
                      class="flex items-center gap-1"
                      data-testid="batch-cook-stage-environment"
                    >
                      <Icon name="Thermometer" size={12} />
                      {stageTemperatureText(stageDoc.environment.temperature)}
                    </span>
                  {/if}
                  {#if stageDoc.place !== null}
                    <span class="flex items-center gap-1" data-testid="batch-cook-stage-place">
                      <Icon name="MapPin" size={12} />
                      {stageDoc.place.label}
                    </span>
                  {/if}
                  {#if stageDoc.until !== null}
                    <span data-testid="batch-cook-stage-until">{stageDoc.until}</span>
                  {/if}
                  {#if status === 'done'}
                    <span data-testid="batch-cook-stage-status">stage done</span>
                  {:else if status === 'skipped'}
                    <span data-testid="batch-cook-stage-status">stage skipped</span>
                  {/if}
                </div>
              </div>
            {/snippet}

            {#each layout.leading as placement (placement.stage.id)}
              {@render stageCard(placement)}
            {/each}

            {#each steps as step, i (step.id)}
              {@const done = completedIds.has(step.id)}
              {@const collapsed = done && peekedStepId !== step.id}
              {@const placement = layout.onStep.get(step.id) ?? null}
              {@const chips = firstUse.get(step.id) ?? []}
              {@const stepKit = kit.get(step.id) ?? []}
              <section
                use:stepAnchor={step.id}
                data-step-id={step.id}
                data-complete={done}
                data-testid="batch-cook-step"
                class="flex flex-col px-4 {collapsed ? 'py-2' : 'border-t py-6'}"
                style="min-height: {collapsed ? 0 : sectionMinHeight(deck.viewportHeight)}px"
              >
                {#if collapsed}
                  <CookStepCollapsed
                    index={i}
                    text={step.text}
                    accentClass="border-primary/40 bg-primary/5"
                    labelClass="text-muted-foreground"
                    onPeek={() => peekStep(step.id)}
                  />
                {:else}
                  <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
                    {#if placement !== null}
                      <!-- THE BAND. The stage this step is, wearing the run's own
                         clock, temperature, place and criterion. -->
                      <div
                        class="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
                        data-testid="batch-cook-stage-band"
                        data-stage-id={placement.stage.id}
                        data-status={stageStatus(placement.stage)}
                      >
                        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                          <span class="font-semibold">
                            Stage {placement.number} of {layout.total}
                          </span>
                          <span class="font-medium">{placement.stage.label}</span>
                          <span class="text-xs uppercase tracking-wide text-muted-foreground">
                            {placement.stage.kind === 'wait' ? 'wait' : 'active'}
                          </span>
                        </div>
                        {@render stageFacts(placement.stage)}
                      </div>
                    {/if}

                    {#if done}
                      <div>
                        <span
                          class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                          data-testid="batch-cook-step-done-badge"
                        >
                          <Icon name="Check" size={12} />
                          Done
                        </span>
                      </div>
                    {/if}
                    <p class="text-xl leading-relaxed sm:text-2xl">{step.text}</p>

                    {#if step.note}
                      <div
                        class="flex items-start gap-3 rounded border border-warning/40 bg-warning/10 px-4 py-3 text-warning-text"
                        data-testid="batch-cook-step-note"
                      >
                        <Icon name="TriangleAlert" size={20} class="mt-1 shrink-0 text-warning" />
                        <span class="whitespace-pre-wrap text-lg">{step.note}</span>
                      </div>
                    {/if}

                    {#if chips.length > 0}
                      <!-- First use, in THE BATCH'S GRAMS where the run froze one.
                         An ingredient the formula has no percentage for keeps the
                         recipe's own words. -->
                      <ul
                        class="flex flex-wrap items-start gap-2"
                        data-testid="batch-cook-step-firstuse"
                      >
                        {#each chips as ing (ing.id)}
                          {@const quantity = quantityById.get(ing.id)}
                          <li class="shrink-0 max-w-full">
                            <span
                              class="flex w-full items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-4 text-left text-base"
                              data-testid="batch-cook-step-chip"
                            >
                              <CanonIcon
                                thumbnail={$ingredientIcons.thumbnailFor(ing)}
                                name={ingredientLabel(ing)}
                                version={$ingredientIcons.iconVersionFor(ing)}
                                size={40}
                                class="rounded-full"
                              />
                              <span class="min-w-0 break-words">
                                {#if quantity !== undefined}
                                  <span class="font-medium tabular-nums">
                                    {formatGrams(quantity.grams)}
                                  </span>
                                  {ingredientLabel(ing)}
                                {:else}
                                  <IngredientText ingredient={ing} />
                                {/if}
                              </span>
                            </span>
                          </li>
                        {/each}
                      </ul>
                    {/if}

                    {#if stepKit.length > 0}
                      <CookStepKit entries={stepKit} />
                    {/if}

                    {#if step.timer}
                      <!-- Bound to a const so the two closures below carry the
                         NARROWED timer. Svelte's `{#if}` narrowing does not reach
                         inside a callback, and `step.timer` read in one is
                         `StepTimerDoc | null` again (svelte-check, not tsc). -->
                      {@const stepTimer = step.timer}
                      {#if stepTakesTimer(step.id)}
                        <!-- No stage on this step, so nothing else is timing it: the
                           recipe's own duration, one tap to start (issue #1327,
                           Phase 2). The pencil beside it is the other case — change
                           the name or the length first. -->
                        <CookStepTimer
                          timer={stepTimer}
                          entry={timers.timerByStep.get(step.id)}
                          now={timers.now}
                          progressFor={timers.timerProgressFor}
                          onStart={() => timers.startStepTimer(step, stepTimer, i)}
                          onAdjust={() => timers.openStepTimerSheet(step, stepTimer, i)}
                          onDismiss={timers.dismissTimer}
                        />
                      {:else}
                        <!-- THE RECIPE'S OPINION, never armed. This step wears a stage
                           band, and the run's own clock is in it — a timer here would
                           be a second alarm for one wait. -->
                        <p
                          class="text-sm text-muted-foreground"
                          data-testid="batch-cook-step-timer"
                        >
                          The recipe says {stepTimer.durationMinutes} min for this step.
                        </p>
                      {/if}
                    {/if}

                    {#if done}
                      <CookStepDoneControls
                        onUntick={() => untickStep(step.id)}
                        onCollapse={() => (peekedStepId = null)}
                      />
                    {/if}
                  </div>
                {/if}
              </section>
              {#each layout.after.get(step.id) ?? [] as placement (placement.stage.id)}
                {@render stageCard(placement)}
              {/each}
            {/each}
          </div>
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background to-transparent"
            style="height: {fadeHeight}px"
            aria-hidden="true"
          ></div>
        </main>
      {/if}

      <!-- Footer. One primary, always in the same place. NO FINISH: when every step
         is ticked the only thing left is to leave, and the run ends on its stages. -->
      <footer class="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
        {#if stage === 'mise'}
          <span class="text-sm text-muted-foreground">Weigh everything out first.</span>
          <Button size="lg" onclick={goToSteps} data-testid="batch-cook-stage-toggle">
            {stepProgress.checked > 0 ? 'Continue cooking' : 'Start cooking'}
            {#snippet trailing()}<Icon name="ArrowRight" size={16} />{/snippet}
          </Button>
        {:else}
          <Button variant="ghost" onclick={goToMise} data-testid="batch-cook-stage-back">
            {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
            Weigh out
          </Button>
          {#if currentStep && !currentStepDone}
            <Button size="lg" onclick={handleStepDone} data-testid="batch-cook-step-done">
              {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
              {nextIncompleteStep ? 'Done · next' : 'Done'}
            </Button>
          {:else if nextIncompleteStep}
            <Button size="lg" onclick={handleResume} data-testid="batch-cook-step-resume">
              Resume · step {nextIncompleteNumber}
              {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
            </Button>
          {:else}
            <!-- NOT a Finish. It navigates and nothing else: the stages are what end
               a run, on the batch page, and for a cure the hands-on part is one day
               of a weeks-long batch. -->
            <Button size="lg" variant="outline" onclick={close} data-testid="batch-cook-to-batch">
              Back to the batch
              {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
            </Button>
          {/if}
        {/if}
      </footer>
    {/if}

    <!-- Mounted for the life of the page, never wrapped in `{#if}` — the sheet owns
       its own open/close transition and portals to <body>, so it lands above this
       full-viewport container rather than inside it. -->
    <BatchObservationSheet bind:open={logOpen} {batchId} run={run ?? null} />
    <!-- Cook mode's own sheet, mounted for the same reason and on the same terms: it
       takes a name and a number and hands back a name and a number, knowing nothing
       about ids, batches or steps. Minting the id, reading the clock and writing the
       document all stay in `createBatchTimers`. -->
    <CookTimerSheet
      bind:open={timerSheetOpen}
      prefill={timers.sheetPrefill}
      running={timers.sheetTarget?.running ?? false}
      onConfirm={timers.confirmTimerSheet}
    />
  </div>
</FeatureGuard>
