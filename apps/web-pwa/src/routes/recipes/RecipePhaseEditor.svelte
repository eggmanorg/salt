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
   * THIS COMPONENT HOLDS A DRAFT, exactly as #1319 settled and Phase 1 built five
   * of (`titleDraft`, `descriptionDraft`, `servingsDraft`, `sourceDraft`,
   * `RecipeNotesCard.draft`). An earlier version of this file claimed the
   * opposite as a virtue, pinned only by a test that swaps the recipe's `id`
   * (which the page's own id-keyed `$effect` already closes by dropping
   * `editing` before that can happen) and never a concurrent write to the SAME
   * document while a box was open. It was a real defect there: another phone, or
   * a chat amendment applied in the docked pane, lands in `$recipes` while a
   * cook is mid-word, and a box bound straight to `recipe` repaints out from
   * under the cursor (#1332 review, blocking 1).
   *
   * `phasesDraft` and `timingSummaryDraft` are what every row, the Add/cap logic
   * and the strip drawn above them read WHILE EDITING. `recipe` itself is read
   * to seed them, in `seedDraft`, and only from two places: `onOpen`, so a zone
   * that was closed while someone else edited opens onto the current document,
   * and the `recipe.id` effect below, so this instance is never left holding a
   * stale document if it is ever reused for a different one without the page
   * having closed it first — belt-and-suspenders over the page's own guard, and
   * what the `id`-swap test still pins. Nothing re-seeds the draft for any other
   * reason, so a snapshot arriving mid-edit is invisible until the zone is
   * closed and reopened, which is also the moment it can no longer surprise
   * anybody mid-word. Every write still goes straight through `onEdit` as it
   * happens — there is no Save — composed against the freshest `recipe` so a
   * field this editor does not own is never rolled back to what it was when the
   * zone opened.
   *
   * `MinutesField`'s own in-flight TEXT (`RecipePhaseEditor.test.ts` pins the
   * swap) is layered on top of that, not a substitute for it: its `value` prop
   * is now fed from the draft, so it re-seeds only in response to THIS editor's
   * own writes, never a concurrent one.
   *
   * The rules below are `docs/recipe-module.md` -> *Hand-editing the strip*, not
   * re-derived here: two minute fields per row and never a third (elapsed time is
   * computed at the point of use and never stored); the six-phase cap is INBOUND
   * only, so a stored seven-phase strip renders and edits row for row and the cap
   * only withholds the Add button; and an empty minute box means `0`, not `null`.
   *
   * Phases 3-5: render this component's PATTERN, not its retired one — hold a
   * draft, seeded on open and on an `id` change, and never bind a box straight
   * to `recipe`. The method rail and the ingredient rows are where the real
   * typing happens, so this is the surface the concurrent-write defect would
   * matter most on.
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

  // The STORED list, read only for read-mode drawing (`filled`, the `view`
  // snippet) and to seed the draft below. Never read by a row or by the strip
  // while editing — that binding straight to the store is the bug #1332's
  // review found (blocking 1).
  const storedPhases = $derived(recipe.metadata.phases ?? []);
  const storedTotals = $derived(recipePhaseTotals(storedPhases));
  const storedTimingSummary = $derived(recipe.metadata.timingSummary ?? null);

  // What every row, the strip-while-editing and the Add/cap logic actually
  // read. Seeded from `recipe` in `seedDraft` and NEVER re-synced from it for
  // any other reason — see the component header for why.
  let phasesDraft = $state<RecipePhase[]>([]);
  let timingSummaryDraft = $state<string | null>(null);

  const activeTotals = $derived(recipePhaseTotals(phasesDraft));

  // The cap is INBOUND ONLY (issue #1123). It stops a cook adding a seventh block;
  // it never truncates, hides or refuses a stored strip that already has one. Read
  // against the DRAFT: what governs whether an eighth row can be added is how many
  // rows this editing session is actually building, not a store snapshot that may
  // have moved under it.
  const canAddPhase = $derived(phasesDraft.length < MAX_RECIPE_PHASES);

  // What this entry can do (issue #637) — the predicate, never a comparison
  // against the kind. An outing has no timing to plan, so it is offered no slot
  // and grows no pencil; a stored strip on one still READS, because the zone falls
  // back to its view whenever it is not being edited. The same shape the Added-by
  // zone in the identity card uses for an empty roster.
  const offersEditing = $derived(editing && isCookable(kindOf(recipe)));

  // Seeds the draft from the CURRENT store — the only two callers are `onOpen`
  // (a zone opening onto whatever is stored now) and the `id`-tracking effect
  // below (this instance reused for a different document). Value-cloned: the
  // draft is mutated only through `setPhases`, never in place, but cloning here
  // is what stops a straight reference to the store's own array from being
  // restyled as "the draft".
  function seedDraft(): void {
    phasesDraft = storedPhases.map((p) => ({ ...p }));
    timingSummaryDraft = storedTimingSummary;
  }

  // Belt-and-suspenders over the page's own `editing = false` on an id change
  // (`RecipeViewPage.svelte`'s `lastRecipeId` effect): that already closes every
  // zone before this component could be asked to show a different document
  // while active, but this instance would otherwise have no way to tell "a
  // concurrent write to MY document" (ignore it) from "I have been handed a
  // DIFFERENT document" (reseed) if it were ever reused without that guard
  // running first. `RecipePhaseEditor.test.ts` pins this directly, by holding
  // `editing: true` across the swap.
  let draftRecipeId: string | undefined;
  $effect(() => {
    if (recipe.id === draftRecipeId) return;
    draftRecipeId = recipe.id;
    seedDraft();
  });

  function setPhases(next: RecipePhase[]): void {
    phasesDraft = next;
    // A hand edit invalidates the model's paired sentence (#1332 review,
    // should-fix 2) — `timingSummary` and `phases` are written by
    // `reconcileRecipePhases` as one pair (`docs/recipe-module.md`'s single
    // funnel), and this write path is not that funnel. Clearing it here rather
    // than leaving it to drift is what keeps the strip from ever showing a
    // sentence the list it sits above no longer supports.
    timingSummaryDraft = null;
    onEdit({
      ...recipe,
      metadata: { ...recipe.metadata, phases: next, timingSummary: null },
    });
  }

  function addPhase(): void {
    setPhases([...phasesDraft, { label: '', handsOnMinutes: 0, handsOffMinutes: 0 }]);
  }

  function removePhase(index: number): void {
    setPhases(phasesDraft.filter((_, i) => i !== index));
  }

  function updatePhase(index: number, patch: Partial<RecipePhase>): void {
    setPhases(phasesDraft.map((p, i) => (i === index ? { ...p, ...patch } : p)));
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
  //
  // Also where the draft is seeded for THIS open: `seedDraft` first, so
  // `phasesDraft` reflects whatever is stored right now (including anything
  // written while the zone was closed), and only then does the empty-strip
  // check decide whether to add the first row.
  function openPhaseEditor(): void {
    seedDraft();
    if (phasesDraft.length === 0) addPhase();
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
  filled={storedTotals.hasPhases}
  label="Edit timing"
  slotLabel="Add a phase"
  testId="recipe-edit-phases"
  class="w-full"
  onOpen={openPhaseEditor}
>
  {#snippet view()}
    <div class="min-w-0 flex-1">
      <RecipePhaseTimeline phases={storedPhases} timingSummary={storedTimingSummary} />
    </div>
  {/snippet}
  {#snippet edit(close)}
    <div class="flex w-full flex-col gap-3" data-testid="recipe-phase-rows">
      {#if activeTotals.hasPhases}
        <RecipePhaseTimeline phases={phasesDraft} timingSummary={timingSummaryDraft} />
      {/if}
      <!-- Keyed by POSITION, as the timeline's own blocks are: a phase has no id,
           and two phases may honestly share a label ("Rest" twice). Each row's
           boxes are re-fed from the DRAFT on every render, so a reorder moves the
           figures rather than the components, and a concurrent write to the
           stored document moves nothing here at all (#1332 review, blocking 1). -->
      {#each phasesDraft as phase, i (i)}
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
            <ReorderControl items={phasesDraft} index={i} noun="phase" onReorder={setPhases} />
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
