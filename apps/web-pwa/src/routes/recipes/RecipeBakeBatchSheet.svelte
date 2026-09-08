<script lang="ts">
  import {
    Button,
    Icon,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Spinner,
    TextField,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import {
    LEAVENING_PERCENT_BOUNDS,
    diffProcess,
    flattenIngredients,
    placeReachesTemperature,
    solveFormula,
    stageTemperatureText,
    targetYield,
    withComponentPercentScaled,
    type Recipe,
    type ScheduleAnchor,
  } from '@salt/domain';
  import type { Formula, ProposeScheduleOutput, StageEnvironment } from '@salt/domain/schemas';
  import { batches, initBatchesSync, proposeSchedule, startBatch } from '../../lib/batchService.js';
  import { equipment } from '../../lib/equipmentService.js';
  import { reviewRows, type ProposalStageRow } from './scheduleProposal.js';
  import {
    EMPTY_DOUGH_ANSWER,
    LOAF_TIN_CHIP_GRAMS,
    doughAmountFrom,
    seedDoughAnswer,
    suggestedTrayGrams,
    vesselFrom,
    type DoughAnswerFields,
    type DoughAnswerMode,
    type TrayBy,
  } from './doughAnswer.js';
  import { addToast } from '../../lib/toastStore.js';
  import { formatDoughAmount, formatGrams } from '../../lib/quantityDisplay.js';

  // "Bake a batch" (issue #812, phases 1 and 2 of epic #778) — the scale sheet.
  //
  // Two questions and nothing else: WHAT are you making this time, and WHEN. Answering
  // them freezes a run and opens it.
  //
  // ─── THE ONE PLACE A SCALED NUMBER APPEARS BEFORE THE BATCH EXISTS ────────────
  //
  // docs/formulas-schedules-batches.md is emphatic: the recipe never shows scaled
  // numbers, and scaled quantities live on the batch. This sheet is the sanctioned
  // exception, because you cannot ask for twelve rolls without being shown what
  // twelve rolls weigh out to. Two rules keep the exception from spreading:
  //
  //   • IT WRITES NOTHING TO THE RECIPE, and nothing to the formula either. Closing
  //     it leaves both documents exactly as they were, so the weekly loaf can never
  //     silently become twelve rolls. A PROPOSAL DOES NOT CHANGE THIS: a restructured
  //     process and an adjusted leavening percentage live in this component's state
  //     and are handed to the freeze, never to `saveFormula`.
  //   • THE PREVIEW IS THE SAME ARITHMETIC THE FREEZE WILL DO. It calls the same
  //     `solveFormula` with the same yield on the same formula it will pass to
  //     `startBatch` — including the adjusted one, when a leavening opinion has been
  //     applied — so what is on screen is what lands on the document.
  //
  // ─── THE TWO HALVES OF `ScheduleAnchor`, AND WHY THEY BEHAVE DIFFERENTLY ──────
  //
  // "I'm starting at" is ARITHMETIC. The reference process is timed forward from the
  // instant given, offline and instantly, and there is nothing to review.
  //
  // "Out of the oven at" is a QUESTION, because a finish time is only useful once
  // something can RESTRUCTURE the process to hit it — ninety minutes on the counter
  // becoming twenty on the counter and eight in the fridge. So it asks
  // `proposeSchedule`, and what comes back is REVIEWED AS A DIFF before anything is
  // created. Declining creates nothing at all.
  //
  // ─── THE MODEL AUTHORS ONCE, AND IS NEVER IN THE HOT PATH ─────────────────────
  //
  // One call, before the batch exists. `diffProcess` renders the answer already in
  // hand — re-rendering the review never re-asks — and once Start is pressed the
  // schedule is frozen onto the document and there is no way back to this sheet for
  // that run. Freezing is what prevents versions; see `freezeBatch`.
  //
  // Nothing here computes a clock time and nothing here computes a gram. The target
  // is back-solved by `resolveSchedule` inside the freeze, which lands on the minute
  // asked for BY CONSTRUCTION, and every weight comes from `solveFormula`. The
  // proposal itself emits neither, deliberately (see `schemas/proposeSchedule.ts`).
  //
  // The time uses a native `datetime-local` input rather than a hand-rolled picker.
  // `RecipeAddToPlannerSheet` rejected the native control for its calendar and was
  // right to: a month grid has to start on the household's own first day of the
  // week, which no OS control knows. An instant carries no such convention — it is a
  // date and a time and nothing else — so the native control is simply correct here,
  // and it is one control fewer to maintain.

  interface Props {
    recipe: Recipe;
    formula: Formula;
    open: boolean;
  }
  let { recipe, formula, open = $bindable() }: Props = $props();

  // ─── When ─────────────────────────────────────────────────────────────────────

  /** Which end of the process the person is nailing down. */
  type AnchorMode = 'startAt' | 'endAt';

  function pad(value: number): string {
    return String(value).padStart(2, '0');
  }

  /** Now, in the `YYYY-MM-DDTHH:mm` local form a `datetime-local` input wants. */
  function localNow(): string {
    const at = new Date();
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  let mode = $state<AnchorMode>('startAt');
  // ONE field for both modes. A start and a finish are the same kind of fact and
  // the same control answers for both; only the label and what happens next differ.
  let whenLocal = $state(localNow());

  // A `datetime-local` value has no offset, so it is read as LOCAL time — which is
  // what the person typing it means. `null` while the box is empty or half-typed.
  const whenIso = $derived.by(() => {
    const ms = new Date(whenLocal).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  });

  // ─── What ─────────────────────────────────────────────────────────────────────

  // "What are you filling?" — the answer, and every box all three answers use. See
  // `doughAnswer.ts` for the rule that turns them into a `DoughAmount`, and for why
  // the tin leads.
  let answerMode = $state<DoughAnswerMode>('tin');
  let answer = $state<DoughAnswerFields>({ ...EMPTY_DOUGH_ANSWER });
  // Whether the person has ANSWERED the question, as against merely being shown
  // the answer `seed()` opened on. Only the vessel reads it, and it is the whole
  // of why: `seedDoughAnswer` lands a one-unit formula on the tin, so a focaccia
  // declaring 1 × 1400 g of dough opens saying "a loaf tin, 1400 g" — and deriving
  // a vessel from that would stamp "1400 g loaf tin" on a run nobody described.
  // `BatchSchema.vessel` says "as the person starting it described it", and this
  // is the flag that keeps that sentence true. The scale is unaffected: an
  // untouched sheet already means the formula's own reference yield.
  let answered = $state(false);
  let busy = $state(false);
  // Why the run could not be started, in the service's own words. Rendered rather
  // than toasted: every one of these is a sentence that tells you where to go next,
  // and a toast that vanishes is the wrong home for an instruction.
  let startError = $state<string | null>(null);

  // ─── The proposal ─────────────────────────────────────────────────────────────

  let proposing = $state(false);
  let proposal = $state<ProposeScheduleOutput | null>(null);
  // The question this proposal answers, as a key. A proposal is an answer to ONE
  // ask — this process, out of the oven at this minute — so moving the target
  // silently retires it rather than leaving a stale diff on screen claiming to
  // describe a time nobody asked for. It also does the in-flight race guard for
  // free: an answer that arrives after the target moved simply never matches.
  let proposalFor = $state<string | null>(null);
  let proposeError = $state<string | null>(null);

  // How warm the kitchen is, declared up here because `askKey` below is part of what
  // it answers.
  let ambientText = $state('');
  // Whether the person has typed in the box, as against being shown the prefill.
  // The prefill arrives asynchronously — the batches subscription resolves after the
  // sheet is on screen — so without this it could land on top of a figure already
  // being typed.
  let ambientTouched = $state(false);

  // The kitchen figure is part of the QUESTION, not a decoration on it: a schedule
  // written for a 26 °C room is a different answer from one written for 16 °C, so
  // changing it retires the proposal exactly as moving the target time does rather
  // than leaving a diff on screen that answers a question nobody asked.
  const askKey = $derived(`${mode}|${whenLocal}|${ambientText.trim()}`);
  const activeProposal = $derived(proposalFor === askKey ? proposal : null);

  // ─── Where, and how warm the kitchen is (issue #1286) ─────────────────────────
  //
  // Two questions, and BOTH ARE SKIPPABLE. Answering neither starts exactly the run
  // this sheet started before they existed: `ambientCelsius` lands null and every
  // stage's `place` lands null, which is what "at whatever the kitchen is" means
  // and what every run written before this field meant.
  //
  // The kitchen figure sits with "When" rather than down here, because it is an
  // input to the schedule proposal and has to be answered before it is asked for.

  /** The places this household has described. A knife block is not one. */
  const places = $derived(($equipment?.items ?? []).filter((item) => item.environment !== null));
  /** id → name, so the review can say "moved to the dough proofer" (issue #1286). */
  const placeNames = $derived(new Map(places.map((place) => [place.id, place.name])));

  // The picker's "nowhere in particular" value. A Select cannot hold null, and the
  // counter is deliberately not an equipment entry, so "nothing chosen" and
  // "deliberately the counter" are one answer — the same choice FormulaPage makes.
  const NO_PLACE = '';

  // The stages this run will ACTUALLY be frozen from: a reviewed proposal's, or the
  // formula's own. One picker per stage of that list, so what is on screen is
  // positionally the array `startBatch` resolves — the alignment `freezeBatch`
  // documents.
  type PickerStage = { label: string; environment: StageEnvironment | null };
  const effectiveStages = $derived<readonly PickerStage[]>(
    activeProposal !== null ? activeProposal.stages : (formula.process ?? []),
  );

  let placeIds = $state<(string | null)[]>([]);

  // Re-seeded whenever the stage list itself changes identity — a proposal arriving,
  // being declined, or being silently retired because the target time moved — and on
  // every open. A choice made against one process must never be carried onto a
  // different one by position; that is exactly how a place would end up frozen onto
  // a stage nobody picked it for.
  let seededStages: readonly PickerStage[] | null = null;
  $effect(() => {
    const stages = effectiveStages;
    if (!open) {
      seededStages = null;
      return;
    }
    if (seededStages === stages) return;
    seededStages = stages;
    // The recipe's own suggestion is the starting point, not an invention: a stage
    // authored with `equipmentId` opens on that place.
    placeIds = stages.map((stage) => stage.environment?.equipmentId ?? null);
  });

  // Subscribed only while the sheet is open, and only for the kitchen-temperature
  // prefill: the recipe page has no other reason to hold the collection.
  $effect(() => {
    if (!open) return;
    return initBatchesSync();
  });

  /** The last kitchen temperature anybody gave, from the most recent run that gave one. */
  const lastAmbientCelsius = $derived.by(() => {
    const all = $batches;
    if (all === undefined) return null;
    let newest: { at: string; celsius: number } | null = null;
    for (const run of all) {
      if (run.ambientCelsius === null) continue;
      if (newest === null || run.createdAt > newest.at)
        newest = { at: run.createdAt, celsius: run.ambientCelsius };
    }
    return newest?.celsius ?? null;
  });

  // Null for an empty box and for half-typed rubbish alike. Both mean the same
  // thing here — no answer — and neither is an error worth a sentence.
  const ambientCelsius = $derived.by(() => {
    const text = ambientText.trim();
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  });

  // ─── "That chamber doesn't get that warm" ─────────────────────────────────────
  //
  // INFORMATION, NEVER A GATE. It appears beside the picker at the one moment it can
  // change something — while the place is still being chosen — and `canStart` does
  // not consult it. Salt records what happened; it does not police it.
  const placeNotes = $derived(
    effectiveStages.map((stage, index) => {
      const chosen = placeIds[index] ?? null;
      if (chosen === null) return null;
      const item = places.find((candidate) => candidate.id === chosen);
      const environment = item?.environment ?? null;
      const asked = stage.environment?.temperature ?? null;
      if (item === undefined || environment === null || asked === null) return null;
      if (placeReachesTemperature(environment, asked)) return null;
      return `${item.name} runs ${environment.minCelsius}–${environment.maxCelsius} °C. This stage asks for ${stageTemperatureText(asked)}.`;
    }),
  );

  function choosePlace(index: number, value: string): void {
    const next = [...placeIds];
    next[index] = value === NO_PLACE ? null : value;
    placeIds = next;
  }

  /**
   * Seed from the formula's OWN reference yield — "the recipe as written" is the
   * answer most runs want, and it should be sitting in the boxes rather than
   * waiting to be typed.
   *
   * A basis-driven formula declares a weight rather than a count of anything, so
   * there is nothing to seed: the boxes come up empty, no amount resolves, and the
   * solve falls back to `formula.referenceYield` for exactly that answer.
   */
  function seed(): void {
    mode = 'startAt';
    whenLocal = localNow();
    startError = null;
    discardProposal();
    const seeded = seedDoughAnswer(
      formula.referenceYield.kind === 'target' ? formula.referenceYield.shape : null,
    );
    answerMode = seeded.mode;
    answer = seeded.fields;
    answered = false;
    ambientText = '';
    ambientTouched = false;
  }

  // Re-seed on each open: a sheet reopened this evening must not still be offering
  // this morning's start time, last run's count, or last night's proposal.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) seed();
    wasOpen = open;
  });

  // The prefill, declared AFTER the re-seed above so it fills the box `seed()` has
  // just cleared rather than being wiped by it. It runs again when the subscription
  // resolves — the figure arrives after the sheet is already on screen — and stops
  // the moment anybody types.
  $effect(() => {
    if (!open || ambientTouched) return;
    const last = lastAmbientCelsius;
    if (last !== null) ambientText = String(last);
  });

  // The ONE seam every box goes through — a field cannot be changed without the
  // question counting as answered, which is what stops a control added later from
  // silently reopening the invented-vessel hole above.
  function setAnswer(patch: Partial<DoughAnswerFields>): void {
    answer = { ...answer, ...patch };
    answered = true;
  }

  function setAnswerMode(mode: DoughAnswerMode): void {
    answerMode = mode;
    answered = true;
  }

  const amount = $derived(doughAmountFrom(answerMode, answer));
  // What we would propose for an un-named vessel. A PROPOSAL: it reaches the grams
  // box only when the button is pressed, and can be typed straight over.
  const suggestedGrams = $derived(suggestedTrayGrams(answer));
  // Omitted, never invented: no amount means the formula's own reference yield,
  // which is precisely what `startBatch` does with an absent `atYield`.
  const atYield = $derived(amount === null ? null : targetYield(amount));
  // The vessel this run is recorded against — the tin and tray answers only, and
  // only once the question has actually been answered. It is a note on the
  // finished record and nothing reads it back: see `BatchSchema.vessel`.
  const vessel = $derived(answered ? vesselFrom(answerMode, answer) : undefined);

  // ─── The leavening opinion, priced by the domain ──────────────────────────────
  //
  // The proposal says "longer and colder, so I'd take the yeast down to roughly
  // two-thirds" and hands over a FACTOR. Everything numeric after that is the
  // domain's: `withComponentPercentScaled` turns the factor into a percentage
  // through the one rounding authority, and `solveFormula` turns the percentage into
  // grams through the same rounding every other component gets. No figure on this
  // screen was authored by a model.
  //
  // AND THE BOUNDS RAIL IS THE SAME ONE. `withComponentPercentScaled` stamps
  // LEAVENING_PERCENT_BOUNDS onto the component it touched and `solveFormula`
  // refuses if the result is outside them (#782). That refusal is consulted HERE,
  // where the gram figure would otherwise be printed — so an absurd suggestion is
  // never displayed, and there is no second check anywhere that could disagree with
  // the first.

  const adjustedFormula = $derived.by(() => {
    const adjustment = activeProposal?.adjustment ?? null;
    if (adjustment === null) return null;
    return withComponentPercentScaled(formula, adjustment, LEAVENING_PERCENT_BOUNDS);
  });

  const solvedYield = $derived(atYield ?? formula.referenceYield);
  const baseSolved = $derived(solveFormula(formula, solvedYield));
  const adjustedSolved = $derived(
    adjustedFormula === null ? null : solveFormula(adjustedFormula, solvedYield),
  );
  const adjustmentApplies = $derived(adjustedSolved !== null && adjustedSolved.ok);

  // The formula this run will actually be frozen from, and the solve behind every
  // number on screen. An adjustment the rail refused is simply not applied — an
  // opinion that cannot be honoured is dropped, never fatal, exactly as
  // `withComponentPercentScaled` drops one it cannot apply.
  const effectiveFormula = $derived(
    adjustmentApplies && adjustedFormula !== null ? adjustedFormula : formula,
  );
  const solved = $derived(
    adjustmentApplies && adjustedSolved !== null && adjustedSolved.ok ? adjustedSolved : baseSolved,
  );

  // ─── The preview ──────────────────────────────────────────────────────────────

  // The recipe's own `rawText`, keyed by ingredient id — the same join `startBatch`
  // makes when it freezes the labels onto the run, so the preview and the document
  // read identically.
  const labelById = $derived(
    new Map(flattenIngredients(recipe).map((ingredient) => [ingredient.id, ingredient.rawText])),
  );

  const unsolvable = $derived.by(() => {
    if (solved.ok) return null;
    switch (solved.reason.kind) {
      case 'emptyFormula':
        return 'This formula has nothing in it yet.';
      case 'noBasis':
        return 'This formula has no basis — nothing is marked as the 100%.';
      case 'basisNotNormalised':
        return "This formula's basis doesn't add up to 100%.";
      default:
        return "This formula doesn't resolve into weights.";
    }
  });

  // ─── The review ───────────────────────────────────────────────────────────────

  const referenceProcess = $derived(formula.process ?? []);
  const diff = $derived(
    activeProposal === null ? null : diffProcess(referenceProcess, activeProposal.stages),
  );
  const review = $derived(
    activeProposal === null || diff === null
      ? null
      : reviewRows(diff, referenceProcess, activeProposal.stages, placeNames),
  );

  type Leavening =
    { kind: 'applied'; reason: string; label: string; text: string } | { kind: 'refused' };

  const leavening = $derived.by((): Leavening | null => {
    const adjustment = activeProposal?.adjustment ?? null;
    if (adjustment === null) return null;
    if (adjustedSolved === null) return null;
    if (!adjustedSolved.ok) return { kind: 'refused' };
    const before = baseSolved.ok
      ? baseSolved.solution.components.find((c) => c.ingredientId === adjustment.ingredientId)
      : undefined;
    const after = adjustedSolved.solution.components.find(
      (c) => c.ingredientId === adjustment.ingredientId,
    );
    // An id the formula does not hold: `withComponentPercentScaled` returned the
    // formula untouched, so there is nothing to show and nothing was changed.
    if (before === undefined || after === undefined) return null;
    return {
      kind: 'applied',
      reason: adjustment.reason,
      label: labelById.get(adjustment.ingredientId) ?? '',
      text: `${before.percent}% → ${after.percent}%, ${formatGrams(before.grams)} → ${formatGrams(after.grams)}`,
    };
  });

  // ─── Asking ───────────────────────────────────────────────────────────────────

  function discardProposal(): void {
    proposal = null;
    proposalFor = null;
    proposeError = null;
  }

  const canPropose = $derived(!proposing && !busy && solved.ok && whenIso !== null);

  async function handlePropose(): Promise<void> {
    if (!canPropose) return;
    proposing = true;
    discardProposal();
    const askedFor = askKey;
    // Sliced to `YYYY-MM-DDTHH:mm` because that is exactly what the wire schema
    // accepts, and a browser that decided to hand back seconds must not turn a good
    // ask into an invalid-argument. The ISO instant is kept on this side for
    // `resolveSchedule`: one representation each, for the one job each is right for.
    const result = await proposeSchedule({
      recipeId: recipe.id,
      targetEndAtLocal: whenLocal.slice(0, 16),
      ambientCelsius,
    });
    proposing = false;
    if (result.kind !== 'ok') {
      // Neither an offline call nor a rejected one is reported to PostHog
      // (docs/salt-architecture.md §7.6); both are a sentence and a retry.
      proposeError =
        result.error.kind === 'AuthError'
          ? 'You need to be signed in to plan a schedule.'
          : "Couldn't work out a schedule just now. Check your connection and try again.";
      return;
    }
    proposal = result.value;
    proposalFor = askedFor;
  }

  // ─── Start ────────────────────────────────────────────────────────────────────

  // In `endAt` mode the proposal is a GATE, not a garnish: a finish time is a
  // request to restructure, and starting without having read what was restructured
  // would freeze a schedule nobody reviewed.
  const canStart = $derived(
    !busy &&
      !proposing &&
      solved.ok &&
      whenIso !== null &&
      (mode === 'startAt' || activeProposal !== null),
  );

  async function handleStart(): Promise<void> {
    if (!canStart || whenIso === null) return;
    busy = true;
    startError = null;
    const accepted = activeProposal;
    const anchor: ScheduleAnchor =
      mode === 'endAt' ? { kind: 'endAt', at: whenIso } : { kind: 'startAt', at: whenIso };
    const result = await startBatch({
      recipe,
      formula: effectiveFormula,
      ...(atYield === null ? {} : { atYield }),
      ...(vessel === undefined ? {} : { vessel }),
      anchor,
      ...(accepted === null
        ? {}
        : { proposedStages: accepted.stages, rationale: accepted.rationale }),
      stagePlaceIds: placeIds,
      equipment: $equipment?.items ?? [],
      ambientCelsius,
    });
    busy = false;
    if (result.kind !== 'ok') {
      // BATCH_NOT_STARTABLE carries a human sentence and is deliberately NOT
      // reported to PostHog — somebody typed the percentages, or the formula has no
      // stages yet, and both are ordinary flow with an obvious next step. Anything
      // else has already been reported by the service on its way through.
      startError =
        result.error.kind === 'ValidationError' && result.error.message
          ? result.error.message
          : "Couldn't start this batch. Try again.";
      return;
    }
    open = false;
    addToast('Batch started.', 'success');
    push(`/batches/${result.value.id}`);
  }
</script>

{#snippet diffGroup(title: string, kind: string, rows: ProposalStageRow[])}
  {#if rows.length > 0}
    <div class="flex flex-col gap-1">
      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul class="flex flex-col gap-1">
        {#each rows as row (row.key)}
          <li class="text-sm" data-testid="bake-batch-diff-row" data-diff-kind={kind}>
            <span class="font-medium">{row.label}</span>
            {#if row.details.length > 0}
              <span class="text-muted-foreground"> — {row.details.join(' · ')}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<Sheet
  bind:open
  side="bottom"
  onOpenChange={(v) => {
    if (!v) busy = false;
  }}
>
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Bake a batch</SheetTitle>
    </SheetHeader>

    <p class="-mt-2 truncate text-sm text-muted-foreground" data-testid="bake-batch-recipe-title">
      {recipe.title}
    </p>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" data-testid="bake-batch-sheet">
      <!-- ─── What are you filling? ───────────────────────────────────────────── -->
      <!-- The tin leads because that is how the question gets asked in a kitchen:
           "I have a 900 g loaf tin, what do I put in to fill it." A UK tin is sold
           by the dough it takes, so there is no sum in between and nothing to
           overrule — see `doughAnswer.ts`. -->
      <div class="flex flex-col gap-3">
        <RadioGroup
          label="What are you filling?"
          value={answerMode}
          onValueChange={(v) => {
            setAnswerMode(v as DoughAnswerMode);
          }}
        >
          <RadioGroupItem value="tin" label="A loaf tin" />
          <RadioGroupItem value="tray" label="A tray or dish" />
          <RadioGroupItem value="pieces" label="A number of pieces" />
          <RadioGroupItem value="weight" label="A weight of dough" />
        </RadioGroup>

        {#if answerMode === 'tin'}
          <div class="flex flex-col gap-2" data-testid="bake-batch-tin">
            <div class="flex flex-wrap gap-2">
              {#each LOAF_TIN_CHIP_GRAMS as grams (grams)}
                <Button
                  size="sm"
                  variant={answer.tinGramsText === String(grams) ? 'solid' : 'outline'}
                  onclick={() => setAnswer({ tinGramsText: String(grams) })}
                  data-testid="bake-batch-tin-chip"
                  data-tin-grams={grams}
                >
                  {formatGrams(grams)}
                </Button>
              {/each}
            </div>
            <div class="flex flex-wrap items-end gap-3">
              <TextField
                label="Tin size (g)"
                inputmode="numeric"
                class="w-32"
                value={answer.tinGramsText}
                onValueChange={(v) => setAnswer({ tinGramsText: v })}
                data-autofocus
                data-testid="bake-batch-tin-grams"
              />
              <TextField
                label="How many tins"
                inputmode="numeric"
                class="w-28"
                value={answer.tinCountText}
                onValueChange={(v) => setAnswer({ tinCountText: v })}
                data-testid="bake-batch-tin-count"
              />
            </div>
          </div>
        {:else if answerMode === 'tray'}
          <!-- THE ONE GUESSED NUMBER IN THE FEATURE, and everything here is
               arranged around that: the suggestion lands in an ordinary editable
               box, the copy says plainly that it is a starting point, and the
               coefficient itself is never shown as a fact. A named tin does not
               come through here — see `doughAmount.ts`. -->
          <div class="flex flex-col gap-2" data-testid="bake-batch-tray">
            <RadioGroup
              label="How are you describing it?"
              value={answer.trayBy}
              onValueChange={(v) => {
                setAnswer({ trayBy: v as TrayBy });
              }}
            >
              <RadioGroupItem value="size" label="Length × width" />
              <RadioGroupItem value="volume" label="A volume" />
            </RadioGroup>

            {#if answer.trayBy === 'size'}
              <div class="flex flex-wrap items-end gap-3">
                <TextField
                  label="Length (cm)"
                  inputmode="decimal"
                  class="w-28"
                  value={answer.trayLengthText}
                  onValueChange={(v) => {
                    setAnswer({ trayLengthText: v });
                  }}
                  data-testid="bake-batch-tray-length"
                />
                <TextField
                  label="Width (cm)"
                  inputmode="decimal"
                  class="w-28"
                  value={answer.trayWidthText}
                  onValueChange={(v) => {
                    setAnswer({ trayWidthText: v });
                  }}
                  data-testid="bake-batch-tray-width"
                />
                <TextField
                  label="Dough depth (cm)"
                  inputmode="decimal"
                  class="w-32"
                  value={answer.trayDepthText}
                  onValueChange={(v) => {
                    setAnswer({ trayDepthText: v });
                  }}
                  data-testid="bake-batch-tray-depth"
                />
              </div>
              <p class="text-xs text-muted-foreground">
                How deep the dough sits, not how tall the tray is — a tray is never filled to its
                walls.
              </p>
            {:else}
              <div class="flex flex-wrap items-end gap-3">
                <TextField
                  label="Volume"
                  inputmode="decimal"
                  class="w-28"
                  value={answer.trayVolumeText}
                  onValueChange={(v) => {
                    setAnswer({ trayVolumeText: v });
                  }}
                  data-testid="bake-batch-tray-volume"
                />
                <RadioGroup
                  label="In"
                  value={answer.trayVolumeUnit}
                  onValueChange={(v) => {
                    setAnswer({ trayVolumeUnit: v as 'ml' | 'l' });
                  }}
                >
                  <RadioGroupItem value="ml" label="ml" />
                  <RadioGroupItem value="l" label="litres" />
                </RadioGroup>
              </div>
            {/if}

            <div class="flex flex-wrap items-end gap-3">
              <TextField
                label="Dough (g)"
                inputmode="numeric"
                class="w-32"
                value={answer.trayGramsText}
                onValueChange={(v) => {
                  setAnswer({ trayGramsText: v });
                }}
                data-testid="bake-batch-tray-grams"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={suggestedGrams === null}
                onclick={() => {
                  if (suggestedGrams === null) return;
                  setAnswer({ trayGramsText: String(suggestedGrams) });
                }}
                data-testid="bake-batch-tray-suggest"
              >
                Suggest a weight
              </Button>
            </div>
            <p class="text-xs text-muted-foreground" data-testid="bake-batch-tray-note">
              A starting point, not a measurement — how much dough a tray takes depends on the style
              and how much rise you want. Type over it.
            </p>
          </div>
        {:else if answerMode === 'pieces'}
          <div class="flex flex-wrap items-end gap-3" data-testid="bake-batch-pieces">
            <TextField
              label="How many"
              inputmode="numeric"
              class="w-28"
              value={answer.pieceCountText}
              onValueChange={(v) => setAnswer({ pieceCountText: v })}
              data-autofocus
              data-testid="bake-batch-piece-count"
            />
            <TextField
              label="Dough each (g)"
              inputmode="numeric"
              class="w-32"
              value={answer.pieceGramsText}
              onValueChange={(v) => setAnswer({ pieceGramsText: v })}
              data-testid="bake-batch-piece-grams"
            />
          </div>
        {:else}
          <div class="flex flex-wrap items-end gap-3" data-testid="bake-batch-weight">
            <TextField
              label="Dough (g)"
              inputmode="numeric"
              class="w-32"
              value={answer.totalGramsText}
              onValueChange={(v) => setAnswer({ totalGramsText: v })}
              data-autofocus
              data-testid="bake-batch-total-dough"
            />
          </div>
        {/if}
      </div>

      <!-- ─── What that weighs out to ─────────────────────────────────────────── -->
      {#if solved.ok}
        <ul class="flex flex-col gap-1" data-testid="bake-batch-preview">
          {#each solved.solution.components as component (component.ingredientId)}
            <li
              class="flex items-baseline justify-between gap-3 text-sm"
              data-testid="bake-batch-preview-row"
              data-ingredient-id={component.ingredientId}
            >
              <span class="min-w-0 flex-1 truncate">
                {labelById.get(component.ingredientId) ?? ''}
              </span>
              <span
                class="shrink-0 font-medium tabular-nums"
                data-testid="bake-batch-preview-grams"
              >
                {formatGrams(component.grams)}
              </span>
            </li>
          {/each}
        </ul>

        <div class="flex flex-col gap-0.5 text-sm" data-testid="bake-batch-totals">
          <p>
            <span class="font-medium tabular-nums" data-testid="bake-batch-total-grams">
              {formatGrams(solved.solution.totalGrams)}
            </span>
            in the bowl.
          </p>
          {#if solved.solution.units !== null}
            <p class="text-muted-foreground" data-testid="bake-batch-yield">
              {formatDoughAmount(solved.solution.units)}{#if vessel !== undefined}, in a {vessel}{/if}.
            </p>
          {/if}
        </div>
      {:else}
        <p class="text-sm text-muted-foreground" data-testid="bake-batch-unsolvable">
          {unsolvable} Open the formula screen to sort it out.
        </p>
      {/if}

      <!-- ─── When? ───────────────────────────────────────────────────────────── -->
      <div class="flex flex-col gap-2">
        <RadioGroup
          label="When"
          value={mode}
          onValueChange={(v) => {
            mode = v as AnchorMode;
          }}
        >
          <RadioGroupItem value="startAt" label="I'm starting at…" />
          <RadioGroupItem value="endAt" label="Out of the oven at…" />
        </RadioGroup>

        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">
            {mode === 'endAt' ? 'Out of the oven at' : 'Starting'}
          </span>
          <input
            type="datetime-local"
            class="salt-focus-ring w-full rounded border border-input bg-background px-3 py-2 text-sm"
            bind:value={whenLocal}
            data-testid="bake-batch-when"
          />
        </label>

        {#if mode === 'startAt'}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onclick={() => (whenLocal = localNow())}
              data-testid="bake-batch-start-now"
            >
              {#snippet leading()}<Icon name="Clock" size={14} />{/snippet}
              Now
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Every stage is timed forward from here. Marking one done later moves the rest with it.
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">
            We'll work out a schedule that lands on this minute — moving the waits about if it has
            to — and show you what changed before anything is started.
          </p>
        {/if}
      </div>

      <!-- ─── How warm is the kitchen? ────────────────────────────────────────── -->
      <!-- Above the proposal on purpose: this is the figure the schedule has been
           missing, so it has to be answerable before "Work out a schedule" is
           pressed. Skipping it is always allowed and costs nothing. -->
      <div class="flex flex-col gap-1">
        <TextField
          label="Kitchen temperature (°C)"
          inputmode="decimal"
          class="w-40"
          placeholder="optional"
          value={ambientText}
          onValueChange={(v) => {
            ambientText = v;
            ambientTouched = true;
          }}
          data-testid="bake-batch-ambient"
        />
        <p class="text-xs text-muted-foreground">
          How warm the room is today. Nothing is worked out from it — it's recorded on the run, and
          it's what a schedule is written for instead of an assumed 20 °C.
        </p>
      </div>

      <!-- ─── The proposal ────────────────────────────────────────────────────── -->
      {#if mode === 'endAt'}
        {#if proposing}
          <!-- Honest in-flight copy rather than a bare button spinner: this call
               reads the whole method and reasons about a night's worth of ferment,
               and the spike measured it well past a minute. A fake percentage would
               be a lie about progress nobody can measure. -->
          <div
            class="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-8 text-center"
            data-testid="bake-batch-proposing"
          >
            <Spinner />
            <p class="text-sm font-medium text-foreground">Working out a schedule…</p>
            <p class="text-xs text-muted-foreground">
              This can take a minute or two — it's reading the method and deciding which waits to
              move. Nothing is started until you've seen what it did.
            </p>
          </div>
        {:else if proposeError !== null}
          <p class="text-sm text-destructive" data-testid="bake-batch-propose-error">
            {proposeError}
          </p>
        {/if}

        {#if activeProposal !== null && diff !== null && review !== null}
          <div
            class="flex flex-col gap-3 rounded-md border border-border p-3"
            data-testid="bake-batch-proposal"
          >
            <p class="text-sm" data-testid="bake-batch-rationale">{activeProposal.rationale}</p>

            {#if diff.hasChanges}
              <!-- One stage becoming two reads as a removal plus additions, because
                   that is what it is: there is no honest way to say which half
                   inherited the original. See `diffProcess`. -->
              {@render diffGroup('Changed', 'changed', review.changed)}
              {@render diffGroup('Added', 'added', review.added)}
              {@render diffGroup('Removed', 'removed', review.removed)}
            {:else}
              <!-- A real answer, not an empty state: it read the method, looked at
                   the time you asked for and said the process already gets there. -->
              <p class="text-sm text-muted-foreground" data-testid="bake-batch-no-changes">
                Nothing needs moving — the stages as written already land where you asked. They'll
                just be timed backwards from it.
              </p>
            {/if}

            {#if leavening !== null}
              {#if leavening.kind === 'applied'}
                <div
                  class="flex flex-col gap-1 rounded-md bg-muted/40 p-2"
                  data-testid="bake-batch-leavening"
                >
                  <p class="text-sm">{leavening.reason}</p>
                  <p class="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span class="min-w-0 truncate">{leavening.label}</span>
                    <span class="font-medium tabular-nums" data-testid="bake-batch-leavening-figure"
                      >{leavening.text}</span
                    >
                  </p>
                  <p class="text-xs text-muted-foreground">
                    The suggestion is the words; the percentage and the grams are worked out here,
                    the same way every other weight on this sheet is.
                  </p>
                </div>
              {:else}
                <p class="text-sm text-muted-foreground" data-testid="bake-batch-leavening-refused">
                  It also wanted to change the leavening, by more than the {LEAVENING_PERCENT_BOUNDS.minPercent}%–{LEAVENING_PERCENT_BOUNDS.maxPercent}%
                  of the basis a leavening can work in. That part has been left alone — the schedule
                  above still stands.
                </p>
              {/if}
            {/if}
          </div>
        {/if}
      {/if}

      <!-- ─── Where does each stage happen? ──────────────────────────────────── -->
      <!-- Below the review, because in "out of the oven at" mode the stages here are
           the PROPOSAL's — one picker per stage of the process this run will actually
           be frozen from. Hidden entirely when the household has described no places:
           an empty picker asks a question with no answers. -->
      {#if places.length > 0 && effectiveStages.length > 0}
        <div class="flex flex-col gap-2" data-testid="bake-batch-places">
          <p class="text-sm font-medium">Where does each stage happen?</p>
          {#each effectiveStages as stage, index (index)}
            <div class="flex flex-col gap-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="min-w-0 flex-1 truncate text-sm">{stage.label || 'Stage'}</span>
                <Select
                  value={placeIds[index] ?? NO_PLACE}
                  onValueChange={(v) => choosePlace(index, v)}
                >
                  <SelectTrigger
                    class="w-44"
                    aria-label={`Where does ${stage.label || 'this stage'} happen?`}
                    data-testid="bake-batch-stage-place"
                  >
                    {places.find((p) => p.id === placeIds[index])?.name ?? 'Kitchen temperature'}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PLACE}>Kitchen temperature</SelectItem>
                    {#each places as place (place.id)}
                      <SelectItem value={place.id}>{place.name}</SelectItem>
                    {/each}
                  </SelectContent>
                </Select>
              </div>
              {#if placeNotes[index] !== null}
                <!-- A note, not a refusal: Start is unaffected. -->
                <p class="text-xs text-muted-foreground" data-testid="bake-batch-place-note">
                  {placeNotes[index]}
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if startError !== null}
        <p class="text-sm text-destructive" data-testid="bake-batch-error">{startError}</p>
      {/if}
    </div>

    <SheetFooter class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}
        >Cancel</Button
      >
      {#if mode === 'endAt' && activeProposal === null}
        <Button
          size="sm"
          onclick={handlePropose}
          loading={proposing}
          disabled={!canPropose}
          data-testid="bake-batch-propose"
        >
          Work out a schedule
        </Button>
      {:else}
        {#if activeProposal !== null}
          <!-- Declining creates NOTHING. It puts the ask back the way it was; no
               batch exists, and nothing was written on the way here. -->
          <Button
            variant="ghost"
            size="sm"
            onclick={discardProposal}
            disabled={busy}
            data-testid="bake-batch-decline"
          >
            No thanks
          </Button>
        {/if}
        <Button
          size="sm"
          onclick={handleStart}
          loading={busy}
          disabled={!canStart}
          data-testid="bake-batch-confirm"
        >
          Start
        </Button>
      {/if}
    </SheetFooter>
  </SheetContent>
</Sheet>
