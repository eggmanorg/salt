<script lang="ts">
  import { Button, Icon, TextField } from '@salt/ui-components';
  import { isCookable, recipePhaseTotals, type Recipe, type RecipePhase } from '@salt/domain';
  import { MAX_RECIPE_PHASES } from '@salt/domain/schemas';
  import EditableZone from './EditableZone.svelte';
  import MinutesField from './MinutesField.svelte';
  import RecipePhaseTimeline from './RecipePhaseTimeline.svelte';
  import ReorderControl from './ReorderControl.svelte';
  import { kindOf } from './recipeKind.js';

  /**
   * The timing strip, read and written in the same place (issue #1319, Phase 2).
   *
   * It owns the whole region the identity card used to gate itself: the read-mode
   * drawing (`RecipePhaseTimeline`, untouched), the dashed `+ Add a phase` slot a
   * recipe with no strip offers while editing, and one editable row per phase.
   *
   * THE STRIP STAYS ON SCREEN WHILE THE ROWS ARE OPEN, above them, drawn from the
   * same list the boxes are writing. That is what makes "an empty minutes box
   * means zero" something a cook can see rather than a rule they are told: clear
   * the box and the block and the total both restate themselves at zero.
   *
   * THIS COMPONENT HOLDS NO DRAFT OF ITS OWN. Every box is fed from `recipe` and
   * every keystroke composes the next whole recipe through `onEdit`, so there is
   * no editing state here that could outlive the document it belongs to when a
   * "Made from" tap swaps `params.id` underneath the page (issue #1326/#1331's
   * recurring finding). The one exception is deliberate and bounded: each
   * `MinutesField` owns its own in-flight TEXT, which is the point of that
   * component, and it is mounted inside the zone's editor, so it is destroyed
   * when the zone closes and re-seeds whenever the stored figure disagrees with
   * it. `RecipePhaseEditor.test.ts` pins the swap.
   *
   * The rules below are `docs/recipe-module.md` -> *Hand-editing the strip*, not
   * re-derived here: two minute fields per row and never a third (elapsed time is
   * computed at the point of use and never stored); the six-phase cap is INBOUND
   * only, so a stored seven-phase strip renders and edits row for row and the cap
   * only withholds the Add button; and an empty minute box means `0`, not `null`.
   */
  let {
    recipe,
    editing,
    onEdit,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
  } = $props();

  const phases = $derived(recipe.metadata.phases ?? []);
  const totals = $derived(recipePhaseTotals(phases));
  const timingSummary = $derived(recipe.metadata.timingSummary ?? null);

  // The cap is INBOUND ONLY (issue #1123). It stops a cook adding a seventh block;
  // it never truncates, hides or refuses a stored strip that already has one.
  const canAddPhase = $derived(phases.length < MAX_RECIPE_PHASES);

  // What this entry can do (issue #637) — the predicate, never a comparison
  // against the kind. An outing has no timing to plan, so it is offered no slot
  // and grows no pencil; a stored strip on one still READS, because the zone falls
  // back to its view whenever it is not being edited. The same shape the Added-by
  // zone in the identity card uses for an empty roster.
  const offersEditing = $derived(editing && isCookable(kindOf(recipe)));

  function setPhases(next: RecipePhase[]): void {
    onEdit({ ...recipe, metadata: { ...recipe.metadata, phases: next } });
  }

  function addPhase(): void {
    setPhases([...phases, { label: '', handsOnMinutes: 0, handsOffMinutes: 0 }]);
  }

  function removePhase(index: number): void {
    setPhases(phases.filter((_, i) => i !== index));
  }

  function updatePhase(index: number, patch: Partial<RecipePhase>): void {
    setPhases(phases.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  // The dashed slot's words are an IMPERATIVE — `+ Add a phase`, which is what the
  // issue's own outcome names — so opening it on an empty strip produces the phase
  // it just promised, and the zone's focus call lands the cursor in that row's name
  // box. Every other slot in this card is a noun (`+ Servings`) and opens an empty
  // control that writes nothing until you type into it; this one is not, and the
  // difference is the label.
  //
  // The boundary, stated rather than papered over: that write is real, so backing
  // straight out leaves a blank phase on the recipe, exactly as pressing `Add
  // phase` and then leaving does. Nothing prunes it here. The blank-row rule this
  // issue settled — kept while editing, dropped on Done — is composed into
  // `finishEditing` by Phase 4 for steps and reused by Phase 5 for ingredient
  // rows, and phases want the same treatment when that lands rather than a fourth
  // answer invented in this file.
  function seedFirstPhase(): void {
    if (phases.length === 0) addPhase();
  }

  // Whole non-negative minutes and nothing stricter — the strip's own bound. An
  // empty or unparseable box means 0, not `null`: unlike Servings, a phase's
  // minute figure is REQUIRED by the schema and 0 is a real answer, since a prove
  // has no hands-on time at all. An emptied box reaches 0 through `Number('')`,
  // which is stated here because it reads like an accident and is not.
  function phaseMinutesOrZero(text: string): number {
    const n = Number(text.trim());
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  // A plain string, because a NUMBER in a text node compiles to `n ?? ''` and that
  // fallback is a branch no test can reach.
  function rowNumber(index: number): string {
    return `${index + 1}.`;
  }
</script>

<EditableZone
  editing={offersEditing}
  filled={totals.hasPhases}
  label="Edit timing"
  slotLabel="Add a phase"
  testId="recipe-edit-phases"
  class="w-full"
  onOpen={seedFirstPhase}
>
  {#snippet view()}
    <div class="min-w-0 flex-1">
      <RecipePhaseTimeline {phases} {timingSummary} />
    </div>
  {/snippet}
  {#snippet edit(close)}
    <div class="flex w-full flex-col gap-3" data-testid="recipe-phase-rows">
      {#if totals.hasPhases}
        <RecipePhaseTimeline {phases} {timingSummary} />
      {/if}
      <!-- Keyed by POSITION, as the timeline's own blocks are: a phase has no id,
           and two phases may honestly share a label ("Rest" twice). Each row's
           boxes are re-fed from the array on every render, so a reorder moves the
           figures rather than the components. -->
      {#each phases as phase, i (i)}
        <div
          class="flex flex-col gap-2 rounded border border-border p-3"
          data-testid="recipe-phase-row"
        >
          <div class="flex items-start gap-2">
            <span class="mt-2 text-sm font-medium text-muted-foreground">{rowNumber(i)}</span>
            <TextField
              label="Phase"
              placeholder="What happens in this block"
              value={phase.label}
              onValueChange={(v) => updatePhase(i, { label: v })}
              class="flex-1"
              data-testid="recipe-phase-label-field"
            />
            <ReorderControl items={phases} index={i} noun="phase" onReorder={setPhases} />
            <Button
              variant="ghost"
              size="sm"
              onclick={() => removePhase(i)}
              aria-label="Remove phase"
            >
              <Icon name="Trash2" size={16} />
            </Button>
          </div>
          <div class="grid grid-cols-2 gap-3 pl-6">
            <MinutesField
              label="Hands-on (min)"
              value={phase.handsOnMinutes}
              parse={phaseMinutesOrZero}
              onValueChange={(m) => updatePhase(i, { handsOnMinutes: m })}
              data-testid="recipe-phase-hands-on-field"
            />
            <MinutesField
              label="Hands-off (min)"
              value={phase.handsOffMinutes}
              parse={phaseMinutesOrZero}
              onValueChange={(m) => updatePhase(i, { handsOffMinutes: m })}
              data-testid="recipe-phase-hands-off-field"
            />
          </div>
        </div>
      {/each}
      <div class="flex items-center justify-between gap-2">
        <div>
          {#if canAddPhase}
            <Button variant="outline" size="sm" onclick={addPhase} data-testid="recipe-phase-add">
              {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
              Add phase
            </Button>
          {/if}
        </div>
        <Button variant="ghost" size="sm" onclick={close} data-testid="recipe-phase-done">
          Done
        </Button>
      </div>
    </div>
  {/snippet}
</EditableZone>
