<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DetailPage,
    EmptyState,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Spinner,
    Textarea,
    TextField,
  } from '@salt/ui-components';
  import { goBack } from '../../lib/nav.js';
  import { recipes, isLoadingRecipes } from '../../lib/recipeService.js';
  import {
    guidedPlan,
    initGuidedPlanSync,
    generateGuidedPlan,
    saveGuidedPlan,
  } from '../../lib/guidedPlanService.js';
  import {
    flattenIngredients,
    guidedContainerProblems,
    hasRecipeChanged,
    isCookable,
  } from '@salt/domain';
  import type { GuidedPlanDoc } from '@salt/domain/schemas';
  import { kindOf } from './recipeKind.js';
  import { addToast } from '../../lib/toastStore.js';

  // The guided-plan editor (issue #751, Phase 1) — `/recipes/:id/guided`.
  //
  // An ordinary AppShell route, deliberately NOT full-viewport: this is desk work,
  // not a hands-full single-task mode, and it is somewhere you arrive from the
  // recipe and leave again.
  //
  // What it is FOR: a plan is AI-written and then READ BY A HUMAN. Every line is
  // editable because the review is the point — the model is a first draft that
  // gets the shape right and will get some cue or container wrong, and the person
  // who cooks this dish knows which. Saving IS the review: it drops the "not
  // checked yet" flag and re-stamps the plan against the recipe as it now stands.

  let { params }: { params?: { id?: string } } = $props();

  const recipeId = $derived(params?.id ?? '');
  const recipe = $derived($recipes.find((r) => r.id === recipeId) ?? null);
  const ingredients = $derived(recipe ? flattenIngredients(recipe) : []);

  // Subscribe to this recipe's plan for as long as the page is open. Re-runs when
  // the id changes; the service resets its store on every init so a plan from a
  // previous recipe can never be shown against this one.
  $effect(() => {
    if (!recipeId) return;
    return initGuidedPlanSync(recipeId);
  });

  // ─── The editing model ────────────────────────────────────────────────────────
  //
  // Deliberately NOT the document shape. Two differences, both so the fields
  // behave like fields: an absent value is `''` here rather than `null` (a text
  // box's empty state is an empty string, and mapping at the seam beats sprinkling
  // `?? ''` through the template), and a check-in's minutes are the RAW STRING the
  // user is typing. Keeping minutes as a number would mean re-rendering the box
  // from the parsed value, so clearing it to type a new number would snap it back
  // to whatever it last parsed as.
  interface CheckInDraft {
    // Local render key only. Check-ins have no identity in the document — they are
    // a list of reminders — but Svelte needs a stable key to keep an input's DOM
    // node (and its cursor) attached to the row while the list is edited.
    key: string;
    atMinutes: string;
    text: string;
  }
  interface NoteDraft {
    stepId: string;
    container: string;
    setup: string;
    cue: string;
    checkIns: CheckInDraft[];
    lookahead: string;
    getAhead: string;
  }
  interface PrepDraft {
    id: string;
    text: string;
    container: string;
    ingredientIds: string[];
  }

  let prepDraft = $state<PrepDraft[]>([]);
  let noteDrafts = $state<NoteDraft[]>([]);
  // Whether the drafts hold edits the store does not. Guards the re-seed below.
  let dirty = $state(false);
  // The exact document version the drafts were seeded from, `${id}:${updatedAt}`.
  // A VERSION, not an id: the seed effect must be able to answer "have I already
  // taken these drafts from this exact document?" — answering with the id alone
  // would re-seed on every effect run and answering with nothing would loop.
  let seededStamp = $state<string | null>(null);

  function stampOf(plan: GuidedPlanDoc): string {
    return `${plan.id}:${plan.updatedAt}`;
  }

  function seed(plan: GuidedPlanDoc): void {
    prepDraft = plan.prep.map((p) => ({
      id: p.id,
      text: p.text,
      container: p.container ?? '',
      ingredientIds: [...p.ingredientIds],
    }));
    noteDrafts = plan.stepNotes.map((n) => ({
      stepId: n.stepId,
      container: n.container ?? '',
      setup: n.setup ?? '',
      cue: n.cue ?? '',
      checkIns: n.checkIns.map((c) => ({
        key: crypto.randomUUID(),
        atMinutes: String(c.atMinutes),
        text: c.text,
      })),
      lookahead: n.lookahead ?? '',
      getAhead: n.getAhead ?? '',
    }));
    dirty = false;
    seededStamp = stampOf(plan);
  }

  // Seed from the store on arrival, and re-seed when a NEW version of the document
  // lands — but never over unsaved edits to the version already in hand. A remote
  // save from the other member while someone is mid-sentence would otherwise wipe
  // the sentence; leaving the draft alone means the local save wins on LWW, which
  // is the same answer every other surface in the app gives.
  $effect(() => {
    const plan = $guidedPlan;
    if (plan === undefined) return; // still loading — nothing to seed from yet
    if (plan === null) {
      if (seededStamp !== null) {
        prepDraft = [];
        noteDrafts = [];
        dirty = false;
        seededStamp = null;
      }
      return;
    }
    // Already seeded from exactly this version. The early return is what stops the
    // effect looping: `seed` writes state this effect reads.
    if (seededStamp === stampOf(plan)) return;
    // Unsaved edits to THIS plan win over an incoming version. A different plan
    // (the id changed) always re-seeds — those edits belong to another recipe.
    if (dirty && seededStamp?.startsWith(`${plan.id}:`)) return;
    seed(plan);
  });

  function touch(): void {
    dirty = true;
  }

  // ─── Prep list ────────────────────────────────────────────────────────────────

  function addPrepEntry(): void {
    prepDraft = [
      ...prepDraft,
      { id: crypto.randomUUID(), text: '', container: '', ingredientIds: [] },
    ];
    touch();
  }

  function removePrepEntry(id: string): void {
    prepDraft = prepDraft.filter((p) => p.id !== id);
    touch();
  }

  function setPrepField(id: string, field: 'text' | 'container', value: string): void {
    prepDraft = prepDraft.map((p) => (p.id === id ? { ...p, [field]: value } : p));
    touch();
  }

  function detachIngredient(prepId: string, ingredientId: string): void {
    prepDraft = prepDraft.map((p) =>
      p.id === prepId
        ? { ...p, ingredientIds: p.ingredientIds.filter((i) => i !== ingredientId) }
        : p,
    );
    touch();
  }

  // Attach an unassigned ingredient to a job. Also removes it from anywhere else,
  // so "exactly once" holds by construction and the only way to end up with a
  // duplicate is to hand-edit the document.
  function attachIngredient(prepId: string, ingredientId: string): void {
    if (!prepId) return;
    prepDraft = prepDraft.map((p) => ({
      ...p,
      ingredientIds:
        p.id === prepId
          ? [...p.ingredientIds.filter((i) => i !== ingredientId), ingredientId]
          : p.ingredientIds.filter((i) => i !== ingredientId),
    }));
    touch();
  }

  const ingredientLabels = $derived(new Map(ingredients.map((i) => [i.id, i.rawText])));

  // THE WARNING THIS PAGE EXISTS TO SHOW. In guided mode the prep list REPLACES the
  // ingredient checklist, so an ingredient named in no prep job is one the cook
  // never sees — it silently vanishes from the dish. The prompt demands every id
  // appears exactly once; this is the check that the plan in front of you actually
  // does, whether it was written by the model or by hand.
  const assignedIds = $derived(new Set(prepDraft.flatMap((p) => p.ingredientIds)));
  const unassigned = $derived(ingredients.filter((i) => !assignedIds.has(i.id)));

  // ─── Step notes ───────────────────────────────────────────────────────────────

  // The note for a step, or a blank one. Notes are looked up BY STEP ID and the
  // list is rendered from the RECIPE, which is what makes a note whose step no
  // longer exists render as nothing: it is never found, never displayed, and never
  // shown against a neighbouring step. It is also not deleted — a step that came
  // back would find its note waiting.
  function noteFor(stepId: string): NoteDraft {
    return (
      noteDrafts.find((n) => n.stepId === stepId) ?? {
        stepId,
        container: '',
        setup: '',
        cue: '',
        checkIns: [],
        lookahead: '',
        getAhead: '',
      }
    );
  }

  function updateNote(stepId: string, patch: Partial<NoteDraft>): void {
    const existing = noteDrafts.find((n) => n.stepId === stepId);
    noteDrafts = existing
      ? noteDrafts.map((n) => (n.stepId === stepId ? { ...n, ...patch } : n))
      : [...noteDrafts, { ...noteFor(stepId), ...patch }];
    touch();
  }

  function addCheckIn(stepId: string): void {
    updateNote(stepId, {
      checkIns: [
        ...noteFor(stepId).checkIns,
        { key: crypto.randomUUID(), atMinutes: '', text: '' },
      ],
    });
  }

  function removeCheckIn(stepId: string, key: string): void {
    updateNote(stepId, { checkIns: noteFor(stepId).checkIns.filter((c) => c.key !== key) });
  }

  function setCheckInField(
    stepId: string,
    key: string,
    field: 'atMinutes' | 'text',
    value: string,
  ): void {
    updateNote(stepId, {
      checkIns: noteFor(stepId).checkIns.map((c) => (c.key === key ? { ...c, [field]: value } : c)),
    });
  }

  // A check-in is armed off its step's timer, so "at 20 minutes" into a 15-minute
  // timer is a reminder that can never fire. The schema cannot see the timer — it
  // holds no recipe — so this cross-check lives here, where the recipe is in hand,
  // and it BLOCKS THE SAVE rather than warning: an unfirable reminder is not a
  // matter of taste. (Phase 3 owns the runtime side; nothing here arms anything.)
  function checkInError(value: string, durationMinutes: number): string | undefined {
    const trimmed = value.trim();
    if (trimmed === '') return 'Say when.';
    const minutes = Number(trimmed);
    if (!Number.isFinite(minutes) || minutes <= 0) return 'Minutes must be a number above 0.';
    if (minutes >= durationMinutes) {
      return `Must be under ${durationMinutes} min — the timer already covers the end.`;
    }
    return undefined;
  }

  // Every check-in the editor can SEE is valid. Check-ins on a note whose step is
  // gone are deliberately excluded: they are not rendered, so they cannot be fixed
  // here, and blocking the save on an invisible row would be a dead end.
  const hasCheckInError = $derived(
    (recipe?.steps ?? []).some((step) =>
      step.timer
        ? noteFor(step.id).checkIns.some(
            (c) => checkInError(c.atMinutes, step.timer!.durationMinutes) !== undefined,
          )
        : false,
    ),
  );

  // ─── Container names (issue #761) ─────────────────────────────────────────────
  //
  // The plan's two halves join on the container NAME and nothing else: a step note
  // says "onion bowl" and the job that filled the onion bowl is where that step's
  // amounts come from. Two ways an author breaks it — the same name on two jobs
  // (the step reaches the first one, and is shown the wrong contents) and a name no
  // job fills (the step shows no contents at all).
  //
  // Both WARN and neither BLOCKS, which is the opposite call to `hasCheckInError`
  // above and for a reason worth stating: an unfirable check-in is a promise the
  // app cannot keep, while a mis-named bowl only costs a line of guidance from a
  // plan that is otherwise correct and perfectly cookable. Refusing to save it
  // would strand every hand-edit made alongside it. The save gate is unchanged.
  //
  // Computed off the DRAFTS, not the stored plan, so the warning appears as the
  // problem is created and clears the moment it is fixed. Only notes for steps the
  // recipe still has are asked about: a note for a deleted step renders nowhere, so
  // a warning about it would be one nobody could act on.
  const containerProblems = $derived(
    guidedContainerProblems(
      prepDraft,
      (recipe?.steps ?? []).map((s) => noteFor(s.id)),
    ),
  );
  const prepNumbers = $derived(new Map(prepDraft.map((p, i) => [p.id, i + 1])));
  const stepNumbers = $derived(new Map((recipe?.steps ?? []).map((s, i) => [s.id, i + 1])));

  // ─── Drift ────────────────────────────────────────────────────────────────────
  //
  // The saved stamp against the live recipe (the same comparison cook mode makes
  // against its session). Read off the STORE, not the draft: the question is
  // whether the plan as SAVED was written against this recipe.
  const recipeChanged = $derived(
    hasRecipeChanged($guidedPlan?.recipeUpdatedAtAtSave ?? null, recipe?.updatedAt ?? null),
  );

  // ─── Commands ─────────────────────────────────────────────────────────────────

  let writing = $state(false);
  let saving = $state(false);

  async function handleWrite(): Promise<void> {
    if (!recipe || writing) return;
    writing = true;
    const result = await generateGuidedPlan(recipe);
    writing = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't write the plan. Try again.", 'destructive');
      return;
    }
    // A re-run REPLACES the plan, so the drafts must come from the new document
    // rather than survive as "unsaved edits" to the one it replaced. Dropping the
    // dirty flag is all it takes: the store already holds the new version, and the
    // seed effect re-seeds from it the moment nothing is being protected.
    dirty = false;
    addToast('Plan written. Give it a read.', 'success');
  }

  async function handleSave(): Promise<void> {
    const plan = $guidedPlan;
    if (!recipe || !plan || saving || hasCheckInError) return;
    saving = true;
    const result = await saveGuidedPlan(
      {
        ...plan,
        prep: prepDraft.map((p) => ({
          id: p.id,
          text: p.text.trim(),
          container: p.container.trim() || null,
          ingredientIds: p.ingredientIds,
        })),
        stepNotes: noteDrafts
          .map((n) => ({
            stepId: n.stepId,
            container: n.container.trim() || null,
            setup: n.setup.trim() || null,
            cue: n.cue.trim() || null,
            checkIns: n.checkIns
              .filter((c) => c.atMinutes.trim() !== '')
              .map((c) => ({ atMinutes: Number(c.atMinutes), text: c.text.trim() })),
            lookahead: n.lookahead.trim() || null,
            getAhead: n.getAhead.trim() || null,
          }))
          // An empty note carries nothing. Dropping them keeps the document to what
          // was actually said, and stops a step that was merely tapped on from
          // leaving a husk behind. EVERY authored field has to be listed here — one
          // left out is one silently discarded on save, and the cook would never
          // learn which.
          .filter(
            (n) =>
              n.container || n.setup || n.cue || n.lookahead || n.getAhead || n.checkIns.length > 0,
          ),
      },
      recipe,
    );
    saving = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't save the plan.", 'destructive');
      return;
    }
    dirty = false;
    addToast('Plan saved.', 'success');
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
    class="p-4 sm:p-6"
  >
    {#snippet actions()}
      {#if $guidedPlan}
        <Button
          size="sm"
          variant="outline"
          onclick={handleWrite}
          loading={writing}
          disabled={writing || saving}
          data-testid="guided-plan-rerun-button"
        >
          {#snippet leading()}<Icon name="RefreshCw" size={16} />{/snippet}
          Re-run
        </Button>
        <Button
          size="sm"
          onclick={handleSave}
          loading={saving}
          disabled={saving || writing || hasCheckInError}
          data-testid="guided-plan-save-button"
        >
          {#snippet leading()}<Icon name="Check" size={16} />{/snippet}
          Save
        </Button>
      {/if}
    {/snippet}

    {#if !$guidedPlan}
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
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="flex flex-col gap-4" data-testid="guided-plan-editor">
        {#if $guidedPlan.needs_approval}
          <!-- Used-but-flagged, exactly as on a recipe: informational, never a gate.
               Saving is what clears it — there is no separate "mark reviewed",
               because reading the plan and correcting it IS the review. -->
          <div
            class="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="guided-plan-unreviewed-chip"
          >
            <Icon name="TriangleAlert" size={16} />
            Written by AI — not checked yet. Read it through and save.
          </div>
        {/if}

        {#if recipeChanged}
          <!-- The recipe moved under the plan. The plan is NOT deleted and NOT
               regenerated: it may be several hand-corrections deep, and throwing
               that away to chase an edit to one step would be a bad trade. Two ways
               out, both the user's call — re-run for a fresh plan, or reconcile by
               hand and save (a save re-stamps, so the banner clears either way). -->
          <div
            class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2"
            data-testid="guided-plan-stale-banner"
          >
            <p class="flex-1 text-sm text-amber-900">
              The recipe has changed since this plan was written.
            </p>
            <Button
              size="sm"
              variant="outline"
              onclick={handleWrite}
              loading={writing}
              disabled={writing || saving}
              data-testid="guided-plan-stale-rerun-button"
            >
              Write it again
            </Button>
          </div>
        {/if}

        {#if unassigned.length > 0}
          <div
            class="flex flex-col gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-3"
            data-testid="guided-plan-unassigned-warning"
          >
            <p class="text-sm text-amber-900">
              {unassigned.length === 1
                ? 'One ingredient is'
                : `${unassigned.length} ingredients are`}
              in no prep step. While cooking, the prep list is the only ingredient list — anything missing
              here is never shown at all.
            </p>
            {#each unassigned as ing (ing.id)}
              <div class="flex flex-wrap items-center gap-2">
                <span class="flex-1 text-sm text-amber-900">{ing.rawText}</span>
                <Select value="" onValueChange={(v) => attachIngredient(v, ing.id)}>
                  <SelectTrigger
                    class="h-8 w-56"
                    aria-label={`Add ${ing.rawText} to a prep step`}
                    data-testid="guided-plan-assign-select"
                  >
                    Add to a prep step…
                  </SelectTrigger>
                  <SelectContent>
                    {#each prepDraft as p, i (p.id)}
                      <SelectItem value={p.id}>{p.text.trim() || `Prep step ${i + 1}`}</SelectItem>
                    {/each}
                  </SelectContent>
                </Select>
              </div>
            {/each}
          </div>
        {/if}

        {#if containerProblems.duplicates.length > 0}
          <!-- Two jobs, one name. While cooking, a step that asks for that name
               reaches the FIRST job in the list and shows its contents — so the
               other bowl's are shown to nobody, and the step is confidently wrong.
               A warning, never a gate: the plan still cooks. -->
          <div
            class="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-3"
            data-testid="guided-plan-duplicate-container-warning"
          >
            <p class="text-sm text-amber-900">
              Two prep steps can't share a container name — a step that asks for it only ever gets
              the first one. Name each for what's in it: "onion bowl", "sugar bowl".
            </p>
            {#each containerProblems.duplicates as dup (dup.name)}
              <p class="text-sm text-amber-900">
                <span class="font-medium">{dup.name}</span>
                — prep steps {dup.prepIds.map((id) => prepNumbers.get(id) ?? '?').join(', ')}
              </p>
            {/each}
          </div>
        {/if}

        {#if containerProblems.dangling.length > 0}
          <!-- A step reaching for a bowl nothing fills. It still cooks — the step
               simply shows no contents, and its ingredients stay in the loose list
               — so this warns and nothing more. Usually a word apart from a real
               container name ("the onion bowl" vs "onion bowl"). -->
          <div
            class="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-3"
            data-testid="guided-plan-dangling-container-warning"
          >
            <p class="text-sm text-amber-900">
              A step wants a container no prep step fills, so it can't show what's in it. Copy the
              name from the prep step exactly, word for word.
            </p>
            {#each containerProblems.dangling as miss (miss.stepId + miss.name)}
              <p class="text-sm text-amber-900">
                Step {stepNumbers.get(miss.stepId) ?? '?'} wants
                <span class="font-medium">{miss.name}</span>
              </p>
            {/each}
          </div>
        {/if}

        <!-- ─── Prep ─────────────────────────────────────────────────────────── -->
        <Card>
          <CardHeader>
            <CardTitle>Prep</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            {#each prepDraft as entry, i (entry.id)}
              <div
                class="flex flex-col gap-2 rounded border p-3"
                data-testid="guided-plan-prep-entry"
              >
                <div class="flex items-start gap-2">
                  <Textarea
                    label={`Prep step ${i + 1}`}
                    rows={2}
                    autoresize
                    placeholder="e.g. Dice the carrots, onion and celery into 5mm pieces"
                    value={entry.text}
                    onValueChange={(v) => setPrepField(entry.id, 'text', v)}
                    class="flex-1"
                    data-testid="guided-plan-prep-text"
                  />
                  <button
                    type="button"
                    class="mt-7 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete prep step ${i + 1}`}
                    onclick={() => removePrepEntry(entry.id)}
                    data-testid="guided-plan-prep-delete"
                  >
                    <Icon name="Trash2" size={16} />
                  </button>
                </div>
                <TextField
                  label="Into"
                  placeholder="onion bowl — leave blank if nothing is set aside"
                  value={entry.container}
                  onValueChange={(v) => setPrepField(entry.id, 'container', v)}
                  data-testid="guided-plan-prep-container"
                />
                <div class="flex flex-wrap gap-1">
                  {#each entry.ingredientIds as ingId (ingId)}
                    <!-- An id whose ingredient is gone from the recipe still shows,
                         as the id, so it can be removed. Hiding it would leave a
                         phantom holding an ingredient slot nobody can find. -->
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs hover:bg-destructive/10"
                      onclick={() => detachIngredient(entry.id, ingId)}
                      aria-label={`Remove ${ingredientLabels.get(ingId) ?? ingId} from this prep step`}
                      data-testid="guided-plan-prep-ingredient-chip"
                    >
                      {ingredientLabels.get(ingId) ?? ingId}
                      <Icon name="X" size={12} />
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
            <div>
              <Button
                size="sm"
                variant="outline"
                onclick={addPrepEntry}
                data-testid="guided-plan-add-prep-button"
              >
                {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
                Add a prep step
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- ─── Step notes ───────────────────────────────────────────────────── -->
        <Card>
          <CardHeader>
            <CardTitle>Notes on the steps</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-5">
            {#each recipe.steps as step, i (step.id)}
              {@const note = noteFor(step.id)}
              <div class="flex flex-col gap-2" data-testid="guided-plan-step-note">
                <!-- The step's own words, READ-ONLY and unstyled as an input. The
                     plan never edits the recipe — it only ever adds lines below. -->
                <p class="text-sm">
                  <span class="mr-1 font-medium text-muted-foreground">{i + 1}.</span>{step.text}
                  {#if step.timer}
                    <span class="ml-1 text-xs text-muted-foreground"
                      >({step.timer.durationMinutes} min timer)</span
                    >
                  {/if}
                </p>
                <div class="flex flex-col gap-2 border-l-2 pl-3">
                  <TextField
                    label="Wants"
                    placeholder="onion bowl — exactly as the prep step names it"
                    value={note.container}
                    onValueChange={(v) => updateNote(step.id, { container: v })}
                    data-testid="guided-plan-note-container"
                  />
                  <TextField
                    label="Setup"
                    placeholder="e.g. small hob burner, medium-low"
                    value={note.setup}
                    onValueChange={(v) => updateNote(step.id, { setup: v })}
                    data-testid="guided-plan-note-setup"
                  />
                  <TextField
                    label="Cue"
                    placeholder="a very gentle sizzle, not a crackle — leave blank if there's no real test"
                    value={note.cue}
                    onValueChange={(v) => updateNote(step.id, { cue: v })}
                    data-testid="guided-plan-note-cue"
                  />
                  <!-- The two fields read a step EARLY (issue #769). They are edited
                       here, against the step they describe, and shown to the cook on
                       the step BEFORE — so the labels have to say so, or they read as
                       two more things to print underneath. -->
                  <TextField
                    label="Coming up"
                    placeholder="the sauce reduces by half — shown while they're still on the step before"
                    value={note.lookahead}
                    onValueChange={(v) => updateNote(step.id, { lookahead: v })}
                    data-testid="guided-plan-note-lookahead"
                  />
                  <TextField
                    label="Get ahead"
                    placeholder="preheat the oven to 200°C — only if it has to start during the previous step"
                    value={note.getAhead}
                    onValueChange={(v) => updateNote(step.id, { getAhead: v })}
                    data-testid="guided-plan-note-get-ahead"
                  />
                  {#if step.timer}
                    {#each note.checkIns as ci (ci.key)}
                      <div class="flex items-start gap-2" data-testid="guided-plan-check-in">
                        <TextField
                          label="At (min)"
                          inputmode="numeric"
                          class="w-28"
                          value={ci.atMinutes}
                          error={checkInError(ci.atMinutes, step.timer.durationMinutes)}
                          onValueChange={(v) => setCheckInField(step.id, ci.key, 'atMinutes', v)}
                          data-testid="guided-plan-check-in-minutes"
                        />
                        <TextField
                          label="Reminder"
                          class="flex-1"
                          placeholder="e.g. give it a stir, or the bottom will catch"
                          value={ci.text}
                          onValueChange={(v) => setCheckInField(step.id, ci.key, 'text', v)}
                          data-testid="guided-plan-check-in-text"
                        />
                        <button
                          type="button"
                          class="mt-7 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Delete this check-in"
                          onclick={() => removeCheckIn(step.id, ci.key)}
                          data-testid="guided-plan-check-in-delete"
                        >
                          <Icon name="Trash2" size={16} />
                        </button>
                      </div>
                    {/each}
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={() => addCheckIn(step.id)}
                        data-testid="guided-plan-add-check-in-button"
                      >
                        {#snippet leading()}<Icon name="BellPlus" size={14} />{/snippet}
                        Add a check-in
                      </Button>
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </CardContent>
        </Card>
      </div>
    {/if}
  </DetailPage>
{/if}
