<script lang="ts">
  import { Button, CanonIcon, DetailPage, EmptyState, Icon, Spinner } from '@salt/ui-components';
  import { goBack } from '../../lib/nav.js';
  import { recipes, isLoadingRecipes } from '../../lib/recipeService.js';
  import {
    guidedPlan,
    initGuidedPlanSync,
    generateGuidedPlan,
    saveGuidedPlan,
    editGuidedPlan,
  } from '../../lib/guidedPlanService.js';
  import {
    firstUseByStep,
    guidedPrepBoard,
    hasRecipeChanged,
    isCookable,
    looseIngredientsForStep,
    prepEntryForContainer,
    prepEntryIngredients,
  } from '@salt/domain';
  import type { GuidedPlanDoc, GuidedStepNoteDoc } from '@salt/domain/schemas';
  import { kindOf } from './recipeKind.js';
  import { addToast } from '../../lib/toastStore.js';
  import { ingredientIcons, ingredientLabel } from '../../lib/cookIngredientIcons.js';
  import { kitIcons } from '../../lib/kitIcons.js';
  import IngredientText from './IngredientText.svelte';
  import GuidedPlanLine from './GuidedPlanLine.svelte';
  import GuidedStepNotes from './GuidedStepNotes.svelte';
  import GuidedStepLookahead from './GuidedStepLookahead.svelte';

  // READ THE PLAN THE WAY YOU WILL COOK IT (issue #1453) — `/recipes/:id/guided`.
  //
  // An ordinary AppShell route, deliberately NOT full-viewport (ui-spec-v05 §2.1
  // names this page as the one that must never be added to that list): this is
  // desk work, not a hands-full single-task mode, and it is somewhere you arrive
  // from the recipe and leave again.
  //
  // What it is FOR: a plan is AI-written and then READ BY A HUMAN. It used to ask
  // for that reading as a form — five labelled text boxes per step, most of them
  // blank and wearing a placeholder that read like advice. This screen asks for it
  // as a READING: the bench first (the bowls the cook will fetch, as the guided
  // cook screen draws them), then one step per screen, with whatever the plan adds
  // drawn by the same component the cook deck draws it with. Tap a line to change
  // it.
  //
  // THERE IS NO SAVE. Every change is written the moment it is made, the way
  // editing a recipe in place already works — `editGuidedPlan`, which carries the
  // "not checked yet" flag through untouched. What replaces Save is APPROVE, which
  // is `saveGuidedPlan`: the claim that a person has read this plan against the
  // recipe as it now stands, which is the only thing that drops the flag and
  // re-stamps the plan.
  //
  // THE BOUNDARY OF "EXACTLY AS THE COOK WILL SEE IT", stated rather than implied
  // (CLAUDE.md rule 12): `GuidedStepNotes` and `GuidedStepLookahead` are literally
  // the components the cook deck renders, so the plan's own lines cannot drift.
  // The recipe's step text, the timer and the step chrome around them are this
  // page's own, and the cook deck's are richer — the claim covers the plan's
  // lines, not the whole screen.
  //
  // APPROVE IS NEVER DISABLED. A warning is information, never permission (Salt
  // records, never polices). That includes a reminder set past the end of its
  // timer, which used to block the save: with per-line writes there is no save to
  // block, the runtime already ignores a reminder it cannot fire, and issue #1453
  // Phase 2 puts the fix on the step it belongs to.

  let { params }: { params?: { id?: string } } = $props();

  const recipeId = $derived(params?.id ?? '');
  const recipe = $derived($recipes.find((r) => r.id === recipeId) ?? null);
  const plan = $derived($guidedPlan ?? null);

  // Subscribe to this recipe's plan for as long as the page is open. Re-runs when
  // the id changes; the service resets its store on every init so a plan from a
  // previous recipe can never be shown against this one.
  $effect(() => {
    if (!recipeId) return;
    return initGuidedPlanSync(recipeId);
  });

  // ─── Where you are ────────────────────────────────────────────────────────────
  //
  // The bench, or the index of the step being read. LOCAL, and stored NOWHERE:
  // "Looks right" is navigation, not a verdict. No per-step "seen" state exists in
  // the document or anywhere else, and the dots are for orientation rather than
  // compliance.
  let screen = $state<'bench' | number>('bench');

  const steps = $derived(recipe?.steps ?? []);
  const stepIndex = $derived(typeof screen === 'number' ? Math.min(screen, steps.length - 1) : -1);
  const step = $derived(stepIndex >= 0 ? (steps[stepIndex] ?? null) : null);

  // ─── Writing ──────────────────────────────────────────────────────────────────
  //
  // There is no draft document and no dirty flag — the only draft that exists is
  // the one line currently open, and it lives inside `GuidedPlanLine`. Every
  // command below reads the plan the store holds, returns the next one, and hands
  // it straight to the service, whose optimistic store paints it on the next
  // frame.

  function apply(next: (current: GuidedPlanDoc) => GuidedPlanDoc): void {
    const current = plan;
    if (!current) return;
    void editGuidedPlan(next(current)).then((result) => {
      if (result.kind !== 'ok') addToast("Couldn't save that change.", 'destructive');
    });
  }

  // A note that says nothing is not kept. Every authored field has to be listed
  // here — one left out is a note that survives as a husk, and a step that was
  // merely tapped on would leave one behind.
  function saysSomething(note: GuidedStepNoteDoc): boolean {
    return Boolean(
      note.container ||
      note.setup ||
      note.cue ||
      note.lookahead ||
      note.getAhead ||
      note.checkIns.length > 0,
    );
  }

  function noteFor(stepId: string): GuidedStepNoteDoc | null {
    return plan?.stepNotes.find((n) => n.stepId === stepId) ?? null;
  }

  function updateNote(stepId: string, patch: Partial<GuidedStepNoteDoc>): void {
    apply((current) => {
      const at = current.stepNotes.findIndex((n) => n.stepId === stepId);
      const before: GuidedStepNoteDoc = current.stepNotes[at] ?? {
        stepId,
        container: null,
        setup: null,
        cue: null,
        checkIns: [],
        lookahead: null,
        getAhead: null,
      };
      const after = { ...before, ...patch };
      if (at === -1) {
        return saysSomething(after)
          ? { ...current, stepNotes: [...current.stepNotes, after] }
          : current;
      }
      // Edited IN PLACE rather than moved to the end: the document's order is the
      // only thing a diff of two saves has to read, and churning it on every typed
      // word would make every edit look like a rewrite.
      return {
        ...current,
        stepNotes: saysSomething(after)
          ? current.stepNotes.map((n, i) => (i === at ? after : n))
          : current.stepNotes.filter((_, i) => i !== at),
      };
    });
  }

  // ─── The bench ────────────────────────────────────────────────────────────────
  //
  // The same shape, from the same function, that the guided cook screen's prep
  // stage is drawn from — bowls first, with the jobs that fill them hanging under
  // each. Without the ticks: nothing is being done here, it is being read.
  const board = $derived.by(() =>
    recipe && plan ? guidedPrepBoard(recipe, plan.prep) : { cards: [], alsoGetOut: [] },
  );

  // The card a new job is being written into, or null. Local, like every other
  // half-made line on this page: a job is written only once it has words, so
  // opening "+ job" and thinking better of it leaves nothing behind.
  let addingJobTo = $state<{ key: string; container: string | null } | null>(null);

  function addJob(container: string | null, text: string): void {
    if (text === '') return;
    apply((current) => ({
      ...current,
      // The editor mints the id, as the schema's comment says it does: the flow
      // mints them on a generation, whoever writes the document mints them here.
      prep: [...current.prep, { id: crypto.randomUUID(), text, container, ingredientIds: [] }],
    }));
  }

  function setJobText(jobId: string, text: string): void {
    apply((current) => ({
      ...current,
      prep: current.prep.map((p) => (p.id === jobId ? { ...p, text } : p)),
    }));
  }

  function deleteJob(jobId: string): void {
    apply((current) => ({ ...current, prep: current.prep.filter((p) => p.id !== jobId) }));
  }

  function detachIngredient(jobId: string, ingredientId: string): void {
    apply((current) => ({
      ...current,
      prep: current.prep.map((p) =>
        p.id === jobId
          ? { ...p, ingredientIds: p.ingredientIds.filter((i) => i !== ingredientId) }
          : p,
      ),
    }));
  }

  // File a stray ingredient into a bowl. Removed from everywhere else on the way
  // in, so "named in exactly one job" holds by construction — the invariant the
  // whole tray exists to protect, since in guided mode the prep list REPLACES the
  // ingredient checklist and an ingredient in no job is one the cook never sees.
  //
  // A bowl may be filled by several jobs; the ingredient joins the FIRST of them.
  // The tray's question is "which bowl does this go in", and asking it as a list
  // of sentences instead would be asking the reader to pick between two jobs whose
  // result ends up in the same bowl anyway.
  function fileIngredient(jobId: string, ingredientId: string): void {
    apply((current) => ({
      ...current,
      prep: current.prep.map((p) => ({
        ...p,
        ingredientIds:
          p.id === jobId
            ? [...p.ingredientIds.filter((i) => i !== ingredientId), ingredientId]
            : p.ingredientIds.filter((i) => i !== ingredientId),
      })),
    }));
  }

  // ─── One step ─────────────────────────────────────────────────────────────────

  const firstUse = $derived(firstUseByStep(recipe?.ingredients ?? []));
  const prepEntries = $derived(plan?.prep ?? []);
  const note = $derived(step ? noteFor(step.id) : null);
  const containerContents = $derived(
    recipe
      ? prepEntryIngredients(recipe, prepEntryForContainer(prepEntries, note?.container ?? null))
      : [],
  );
  const loose = $derived(
    step ? looseIngredientsForStep(firstUse.get(step.id) ?? [], prepEntries, note) : [],
  );
  // Reminders hang off the step's timer, so a step without one has none — shown
  // or offered — exactly as on the cook deck.
  const checkIns = $derived(step?.timer ? (note?.checkIns ?? []) : []);

  // ─── Drift, and the two flags ─────────────────────────────────────────────────
  //
  // Read off the STORE rather than any draft: the question is whether the plan AS
  // WRITTEN was reviewed against this recipe.
  const recipeChanged = $derived(
    hasRecipeChanged(plan?.recipeUpdatedAtAtSave ?? null, recipe?.updatedAt ?? null),
  );

  // ─── The summary in the bar ───────────────────────────────────────────────────
  //
  // What the plan actually contains, in the reader's words. Counted off the live
  // document, so it moves as lines are added.
  function count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }
  const summary = $derived.by(() => {
    if (!plan) return '';
    const bowls = board.cards.filter((c) => c.name !== null).length;
    const cues = plan.stepNotes.filter((n) => n.cue).length;
    const reminders = plan.stepNotes.reduce((n, note) => n + note.checkIns.length, 0);
    return [
      count(bowls, 'bowl', 'bowls'),
      count(steps.length, 'step', 'steps'),
      count(cues, 'cue', 'cues'),
      count(reminders, 'reminder', 'reminders'),
    ].join(' · ');
  });

  // ─── Commands ─────────────────────────────────────────────────────────────────

  let writing = $state(false);
  let approving = $state(false);

  async function handleWrite(): Promise<void> {
    if (!recipe || writing) return;
    writing = true;
    const result = await generateGuidedPlan(recipe);
    writing = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't write the plan. Try again.", 'destructive');
      return;
    }
    // A re-run REPLACES the plan, so the reading starts again at the bench.
    screen = 'bench';
    addToast('Plan written. Give it a read.', 'success');
  }

  async function handleApprove(): Promise<void> {
    if (!recipe || !plan || approving) return;
    approving = true;
    const result = await saveGuidedPlan(plan, recipe);
    approving = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't approve the plan.", 'destructive');
      return;
    }
    addToast('Plan approved.', 'success');
  }

  const loading = $derived($isLoadingRecipes || $guidedPlan === undefined);
</script>

{#if loading}
  <div class="flex justify-center p-8"><Spinner /></div>
{:else if !recipe}
  <div class="p-6">
    <EmptyState title="Recipe not found" description="It may have been deleted." />
  </div>
{:else if !isCookable(kindOf(recipe))}
  <!-- Capability-gated, never kind-gated (CLAUDE.md): a plan explains a METHOD, so
       an entry with no method has nothing to explain. Reachable only by typing the
       URL — the recipe page does not offer the action for these. -->
  <div class="p-6">
    <EmptyState
      title="Nothing to plan here"
      description="A guided plan spells out a method, and this entry doesn't have one."
    />
  </div>
{:else}
  <DetailPage
    title="Guided plan"
    subtitle={recipe.title}
    onBack={() => goBack(`/recipes/${recipe.id}`)}
    backLabel="Back"
    fill
    class="p-4 sm:p-6"
  >
    {#snippet actions()}
      {#if plan}
        <Button
          size="sm"
          variant="outline"
          onclick={handleWrite}
          loading={writing}
          disabled={writing || approving}
          data-testid="guided-plan-rerun-button"
        >
          {#snippet leading()}<Icon name="RefreshCw" size={16} />{/snippet}
          Re-run
        </Button>
      {/if}
    {/snippet}

    {#if !plan}
      <!-- No plan yet. `$guidedPlan === null` specifically, never `undefined` —
           the store's three states are what keep this prompt from flashing over a
           plan that is still a frame away from arriving. -->
      <div data-testid="guided-plan-empty">
        <EmptyState
          title="No guided plan yet"
          description="Write one and this recipe gains a prep list and notes under every step — what to chop into which bowl, how the hob is set, what the pan should sound like."
        >
          {#snippet actions()}
            <Button
              onclick={handleWrite}
              loading={writing}
              disabled={writing}
              data-testid="guided-plan-write-button"
            >
              {#snippet leading()}<Icon name="Sparkles" size={16} />{/snippet}
              Write the plan
            </Button>
            <!-- The wait is LONG — the model writes a note for every step, so a
                 full-length recipe takes a minute or two (see GUIDED_PLAN_TIMEOUT
                 in the flow). The button's own spinner is 16px inside a control
                 whose label never changes, which at ten seconds reads as slow and
                 at ninety reads as broken. This line is the difference between
                 waiting and giving up. -->
            {#if writing}
              <p class="text-sm text-muted-foreground" data-testid="guided-plan-writing-note">
                Writing the plan — this takes up to a couple of minutes for a long recipe. You can
                leave this page open.
              </p>
            {/if}
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col gap-4" data-testid="guided-plan-editor">
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {#if screen === 'bench'}
            {#if plan.needs_approval}
              <!-- Used-but-flagged, exactly as on a recipe: informational, never a
                   gate. Approving is what clears it — reading the plan through and
                   correcting it IS the review, and an edit alone is not. -->
              <div
                class="flex items-center gap-2 rounded border border-review/40 bg-review/10 px-3 py-2 text-sm text-review-text"
                data-testid="guided-plan-unreviewed-chip"
              >
                <Icon name="TriangleAlert" size={16} />
                Written by AI — not checked yet. Read it through and approve it.
              </div>
            {/if}

            {#if recipeChanged}
              <!-- The recipe moved under the plan. The plan is NOT deleted and NOT
                   regenerated: it may be several hand-corrections deep. Two ways
                   out, both the user's call — write it again, or reconcile by hand
                   and approve (approving re-stamps, so the banner clears either
                   way). -->
              <div
                class="flex flex-wrap items-center gap-3 rounded border border-warning/40 bg-warning/10 px-3 py-2"
                data-testid="guided-plan-stale-banner"
              >
                <p class="flex-1 text-sm text-warning-text">
                  The recipe has changed since this plan was written.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onclick={handleWrite}
                  loading={writing}
                  disabled={writing || approving}
                  data-testid="guided-plan-stale-rerun-button"
                >
                  Write it again
                </Button>
              </div>
            {/if}

            {#if board.alsoGetOut.length > 0}
              <!-- THE ONE WARNING THE BENCH KEEPS. In guided mode the prep list
                   REPLACES the ingredient checklist, so an ingredient in no bowl is
                   one the cook never sees — it silently vanishes from the dish.
                   Filing it is one tap, which is why this is a tray of things to
                   put away rather than a banner about them. -->
              <div
                class="flex flex-col gap-3 rounded border border-warning/40 bg-warning/10 px-3 py-3"
                data-testid="guided-plan-unassigned-warning"
              >
                <p class="text-sm text-warning-text">
                  Not in any bowl yet — the cook will never see these.
                </p>
                {#each board.alsoGetOut as ingredient (ingredient.id)}
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="flex-1 text-sm text-warning-text">{ingredient.rawText}</span>
                    {#each board.cards as card (card.key)}
                      {@const firstJob = card.jobs[0]}
                      {#if firstJob}
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => fileIngredient(firstJob.id, ingredient.id)}
                          data-testid="guided-plan-file-button"
                        >
                          {card.name ?? 'Just get out'}
                        </Button>
                      {/if}
                    {/each}
                  </div>
                {/each}
              </div>
            {/if}

            <!-- ─── The bench ─────────────────────────────────────────────── -->
            <ul class="flex flex-col gap-3" data-testid="guided-plan-bench">
              {#each board.cards as card (card.key)}
                <li
                  class="overflow-hidden rounded-xl border-l-[3px] border-l-secondary/60 bg-card shadow-ambient"
                  data-testid="guided-plan-bench-card"
                  data-container-key={card.key}
                >
                  <div
                    class="flex w-full items-center gap-2.5 border-b border-border/50 px-4 py-3.5"
                  >
                    {#if card.name !== null}
                      <!-- The vessel itself, drawn (issue #882) and resolved from
                           the plan's own words at display time — the same tile the
                           cook screen's card header shows. -->
                      <CanonIcon
                        thumbnail={$kitIcons.kitIconFor(card.name)}
                        version={$kitIcons.kitIconVersionFor(card.name)}
                        name={card.name}
                        size={32}
                      />
                    {/if}
                    <span
                      class="min-w-0 flex-1 truncate text-base font-semibold"
                      data-testid="guided-plan-bench-card-name"
                    >
                      {card.name ?? 'Just get out'}
                    </span>
                  </div>
                  <ul class="flex flex-col gap-2 px-3 py-4">
                    {#each card.jobs as job (job.id)}
                      <li data-testid="guided-plan-job" data-prep-id={job.id}>
                        <div class="flex items-start gap-2">
                          <GuidedPlanLine
                            class="min-w-0 flex-1 px-2 py-1 text-base"
                            value={job.text}
                            ariaLabel="this job's words"
                            placeholder="Dice the carrots, onion and celery"
                            multiline
                            onCommit={(v) => setJobText(job.id, v)}
                          >
                            <span class="whitespace-pre-wrap">{job.text}</span>
                          </GuidedPlanLine>
                          <button
                            type="button"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Delete this job"
                            onclick={() => deleteJob(job.id)}
                            data-testid="guided-plan-job-delete"
                          >
                            <Icon name="Trash2" size={16} />
                          </button>
                        </div>
                        <!-- HOW MUCH. The job's sentence carries no quantities by
                             design, so these are what say there is one onion —
                             the same rows, from the same amounts, the cook screen
                             shows under the job. Tap one to take it out of the
                             bowl; it reappears in the tray above. -->
                        <ul class="mt-0.5 flex flex-col gap-0.5 pl-4">
                          {#each job.rows as row (row.id)}
                            {@const ingredient = row.ingredient}
                            {#if ingredient}
                              <li>
                                <button
                                  type="button"
                                  class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-destructive/10"
                                  onclick={() => detachIngredient(job.id, row.id)}
                                  aria-label="Take {ingredientLabel(ingredient)} out of this job"
                                  data-testid="guided-plan-job-ingredient"
                                >
                                  <CanonIcon
                                    thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                                    name={ingredientLabel(ingredient)}
                                    version={$ingredientIcons.iconVersionFor(ingredient)}
                                    size={32}
                                  />
                                  <span class="min-w-0 flex-1 text-base">
                                    <IngredientText {ingredient} />
                                  </span>
                                  <Icon name="X" size={14} class="shrink-0 text-muted-foreground" />
                                </button>
                              </li>
                            {/if}
                          {/each}
                        </ul>
                      </li>
                    {/each}
                    <li>
                      {#if addingJobTo?.key === card.key}
                        <GuidedPlanLine
                          class="w-full px-2 py-1 text-base"
                          value=""
                          ariaLabel="the new job's words"
                          placeholder="Dice the carrots, onion and celery"
                          multiline
                          startOpen
                          onCommit={(v) => addJob(card.name, v)}
                          onClose={() => (addingJobTo = null)}
                        >
                          <span></span>
                        </GuidedPlanLine>
                      {:else}
                        <Button
                          size="sm"
                          variant="ghost"
                          onclick={() => (addingJobTo = { key: card.key, container: card.name })}
                          data-testid="guided-plan-add-job"
                        >
                          {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
                          job
                        </Button>
                      {/if}
                    </li>
                  </ul>
                </li>
              {/each}
              {#if board.cards.length === 0}
                <!-- A plan with no jobs at all. The flow always writes some, so
                     this is a hand-emptied plan — it still needs a way back to
                     having one, or the bench is a dead end. -->
                <li>
                  {#if addingJobTo}
                    <GuidedPlanLine
                      class="w-full px-2 py-1 text-base"
                      value=""
                      ariaLabel="the new job's words"
                      placeholder="Dice the carrots, onion and celery"
                      multiline
                      startOpen
                      onCommit={(v) => addJob(null, v)}
                      onClose={() => (addingJobTo = null)}
                    >
                      <span></span>
                    </GuidedPlanLine>
                  {:else}
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => (addingJobTo = { key: '', container: null })}
                      data-testid="guided-plan-add-job"
                    >
                      {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
                      Add a job
                    </Button>
                  {/if}
                </li>
              {/if}
            </ul>
          {:else if step}
            <!-- ─── One step ──────────────────────────────────────────────── -->
            <div class="flex flex-col gap-4" data-testid="guided-plan-step">
              <p class="text-lg" data-testid="guided-plan-step-text">
                <span class="mr-1 font-medium text-muted-foreground">{stepIndex + 1}.</span
                >{step.text}
                {#if step.timer}
                  <span class="ml-1 text-xs text-muted-foreground"
                    >({step.timer.durationMinutes} min timer)</span
                  >
                {/if}
              </p>
              {#if step.note}
                <!-- The recipe's own warning, in the recipe's own vocabulary and
                     read-only: the plan never edits the dish. Shown because the
                     cook screen shows it, and a step read without it is not the
                     step the cook will meet. -->
                <div
                  class="flex items-start gap-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-warning-text"
                  data-testid="guided-plan-step-note"
                >
                  <Icon name="TriangleAlert" size={16} class="mt-1 shrink-0" />
                  <span class="whitespace-pre-wrap text-sm">{step.note}</span>
                </div>
              {/if}
              <GuidedStepNotes
                {note}
                {containerContents}
                {loose}
                {checkIns}
                edit={{
                  timerMinutes: step.timer?.durationMinutes ?? null,
                  onSetContainer: (v) => updateNote(step.id, { container: v }),
                  onSetSetup: (v) => updateNote(step.id, { setup: v }),
                  onSetCue: (v) => updateNote(step.id, { cue: v }),
                  onSetCheckIn: (i, checkIn) =>
                    updateNote(step.id, {
                      checkIns: checkIns.map((c, at) => (at === i ? checkIn : c)),
                    }),
                  onAddCheckIn: (checkIn) =>
                    updateNote(step.id, { checkIns: [...checkIns, checkIn] }),
                  onRemoveCheckIn: (i) =>
                    updateNote(step.id, { checkIns: checkIns.filter((_, at) => at !== i) }),
                }}
              />
              <GuidedStepLookahead
                lookahead={note?.lookahead ?? ''}
                getAhead={note?.getAhead ?? ''}
                nextNumber={stepIndex + 2 <= steps.length ? stepIndex + 2 : null}
                edit={{
                  onSetLookahead: (v) => updateNote(step.id, { lookahead: v }),
                  onSetGetAhead: (v) => updateNote(step.id, { getAhead: v }),
                }}
              />
            </div>
          {/if}
        </div>

        <!-- ─── The bar ───────────────────────────────────────────────────── -->
        <div class="flex flex-col gap-3 border-t pt-3">
          {#if screen === 'bench'}
            <div class="flex justify-end">
              <Button
                onclick={() => (screen = 0)}
                disabled={steps.length === 0}
                data-testid="guided-plan-start-reading"
              >
                Start reading
              </Button>
            </div>
          {:else}
            <div class="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                onclick={() => (screen = stepIndex === 0 ? 'bench' : stepIndex - 1)}
                data-testid="guided-plan-back"
              >
                {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
                Back
              </Button>
              <!-- Where you are, and nothing more. No tick, no count of steps
                   "done": a dot is orientation, and recording which steps someone
                   looked at would be policing a reading. -->
              <div class="flex flex-wrap items-center justify-center gap-1.5">
                {#each steps as s, i (s.id)}
                  <button
                    type="button"
                    class="h-2 w-2 rounded-full {i === stepIndex
                      ? 'bg-primary'
                      : 'bg-muted-foreground/30'}"
                    aria-label="Step {i + 1}"
                    aria-current={i === stepIndex ? 'step' : undefined}
                    onclick={() => (screen = i)}
                    data-testid="guided-plan-dot"
                  ></button>
                {/each}
              </div>
              <Button
                onclick={() => (screen = stepIndex + 1 < steps.length ? stepIndex + 1 : 'bench')}
                data-testid="guided-plan-looks-right"
              >
                {stepIndex + 1 < steps.length ? 'Looks right' : 'Done reading'}
              </Button>
            </div>
          {/if}
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm text-muted-foreground" data-testid="guided-plan-summary">{summary}</p>
            <Button
              onclick={handleApprove}
              loading={approving}
              data-testid="guided-plan-approve-button"
            >
              {#snippet leading()}<Icon name="Check" size={16} />{/snippet}
              Approve the plan
            </Button>
          </div>
        </div>
      </div>
    {/if}
  </DetailPage>
{/if}
