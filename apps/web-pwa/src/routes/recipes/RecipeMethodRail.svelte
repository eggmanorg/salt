<script lang="ts">
  import {
    Button,
    CanonIcon,
    Card,
    CardContent,
    Icon,
    TextField,
    Textarea,
  } from '@salt/ui-components';
  import {
    hasLiveCanonMatch,
    newStep,
    type Ingredient,
    type Recipe,
    type Step,
  } from '@salt/domain';
  import { kitIcons } from '../../lib/kitIcons.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import EditableZone from './EditableZone.svelte';
  import MinutesField from './MinutesField.svelte';
  import ReorderControl from './ReorderControl.svelte';

  /**
   * The method rail, read and written in the same place (issue #878 for the rail,
   * issue #1319 Phase 4 for the editing).
   *
   * Lifted out of `RecipeViewPage.svelte` unchanged in read mode: the same discs,
   * the same per-gap connectors, the same first-use and kit rows, the same
   * hands-off and timer chips, the same note box, testid for testid. What edit
   * mode adds sits INSIDE that shape rather than replacing it — a step grows a
   * pencil beside its words, a step with no timer and no note grows two dashed
   * slots, and the rail itself grows reorder, remove and `+ Add step`. The step
   * row is the one panel on this page that never had a tap handler, which is why
   * this phase precedes the ingredients (#1319's own ordering).
   *
   * THIS COMPONENT HOLDS A DRAFT, which is `RecipePhaseEditor`'s pattern and not
   * `RecipeMadeFromCard`'s: there is real typing here — a step's words, its timer
   * label, its note — so a snapshot arriving from another phone or from a chat
   * amendment applied in the docked pane must not repaint a box mid-word (#1332
   * review, blocking 1). `stepsDraft` is what every box, every chip and the rail
   * itself DRAW while editing; `recipe.steps` is what read mode draws. The draft
   * is seeded from the store in exactly three places and nowhere else: when edit
   * mode opens, when a zone opens (so a zone opened later sees what was written
   * while it was closed), and when `recipe.id` changes.
   *
   * DRAWING and WRITING read from different places, which is what #1336 review's
   * blocking 1 corrected: every gesture still goes straight out through
   * `onEdit` — there is no Save — but the WRITE is composed off the freshest
   * `recipe.steps`, patching in only what that one gesture owns. `updateStep` (a
   * keystroke in a step's words, its note, or either timer box) patches the
   * named field onto the matching step in `recipe.steps`. The structural
   * gestures — reorder, remove, `Add step` — carry no in-flight text at all
   * (`RecipeMadeFromCard`'s own argument for holding no draft), so they compose
   * straight off `recipe.steps` with no per-field patch either. Neither path
   * ever sends the WHOLE draft back — that was the original bug: one gesture on
   * step 1 used to write `stepsDraft` in full, which silently deleted a
   * concurrent amendment's rewording of step 7.
   *
   * ROUND 2 OF THAT SAME REVIEW (#1336, blocking 1) caught the fix's own
   * overcorrection: `commitWrite` (below) is the only place `onEdit` fires, and
   * every caller used to hand its RESULT straight to `stepsDraft` too — which
   * re-seeded the entire draft from `recipe.steps` on every gesture, undoing
   * the separation this header already claimed. `commitWrite` therefore now
   * does the write and NOTHING else; each gesture separately applies its own
   * operation to `stepsDraft` — `updateStep` patches the one id it names,
   * `addStep`/`removeStep` append/filter that one id, `reorderSteps` reorders
   * the draft's own objects (never fetching replacement content for them) —
   * so a sibling step's draft entry is never touched by a gesture that isn't
   * about it, and neither is the very step a gesture DOES touch, beyond the
   * field that gesture owns.
   *
   * The boundary, stated rather than implied: while a box is open, a
   * concurrent write to this recipe's OWN steps stays out of the rail's own
   * DRAWING until the draft is re-seeded — the step you are not touching still
   * SHOWS what it showed when the box opened, and STAYS showing it through
   * every later gesture, not just until the next one. A concurrent write
   * cannot repaint an open box, full stop — `RecipeMethodRail.test.ts` pins
   * this by rewording the very step a box has open from underneath it and then
   * firing an unrelated gesture, and asserting the box still shows what it
   * showed before either. That is the trade the timing strip already made for
   * repainting, and it is the right one for a surface you type into —
   * visibility lags, the write does not.
   *
   * BLANK STEPS ARE KEPT WHILE EDITING AND DROPPED ON EVERY EXIT FROM EDIT MODE
   * — issue #1319's settled rule, implemented in `blankRows.ts` and composed
   * into the page's `finishEditing`, its id-keyed `$effect` and its `onDestroy`
   * (#1336 review, blocking 2), not here: pruning on a keystroke would delete
   * the row you just added before you could type in it. It carries the ingredient
   * panel's blank rows too, since Phase 5 — one function, both rules.
   *
   * REORDER IS `ReorderControl` AND NOTHING ELSE (#1332's ruling) — no pair of
   * buttons is inlined here.
   */
  let {
    recipe,
    editing,
    onEdit,
    firstUseByStep,
    kitByStep,
    thumbnailFor,
    iconVersionFor,
    ingredientLabel,
    liveCanonIds,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
    /** What each step is the first to call for — the domain query, run by the page. */
    firstUseByStep: ReadonlyMap<string, readonly Ingredient[]>;
    /**
     * What each step is the first to reach for — likewise. Typed off `Recipe`
     * rather than off a name: the domain publishes the query but not its entry
     * type, and inventing an export for one page-local prop is a change to the
     * domain's published surface that this phase has no business making.
     */
    kitByStep: ReadonlyMap<string, readonly Recipe['kit'][number][]>;
    thumbnailFor: (canonId: string | null) => string | null;
    iconVersionFor: (canonId: string | null) => string | number | undefined;
    /** The ingredients panel names its rows the same way; one helper, on the page. */
    ingredientLabel: (ing: Ingredient) => string;
    liveCanonIds: ReadonlySet<string>;
  } = $props();

  // What every box and chip reads while editing. Seeded in `seedDraft` and never
  // re-synced from the store for any other reason — see the header for why.
  let stepsDraft = $state<Step[]>([]);

  // The list the rail draws. Read mode draws what is STORED; edit mode draws the
  // draft, so a box cannot be repainted by a write arriving mid-word.
  const steps = $derived(editing ? stepsDraft : recipe.steps);

  // Value-cloned, timer included: the draft is only ever replaced through
  // `setSteps`, but cloning is what stops a straight reference to the store's own
  // objects from being restyled as "the draft".
  function seedDraft(): void {
    stepsDraft = recipe.steps.map((s) => ({ ...s, timer: s.timer ? { ...s.timer } : null }));
  }

  // Re-seeds on entering edit mode and on the document changing underneath, and on
  // nothing else. The early return is the whole protection: a concurrent write to
  // the SAME recipe re-runs this effect (it reads `recipe`) and leaves through the
  // guard without touching the draft. Keyed on the id STRING plus the mode, never
  // on the `recipe` object — `/recipes/:id` is one route, so a "Made from" tap
  // reuses this instance with a different document (#1326/#1331's recurring
  // finding), while a querystring-only push must change nothing here.
  let seededFor: string | undefined;
  $effect(() => {
    const key = `${recipe.id}|${editing}`;
    if (key === seededFor) return;
    seededFor = key;
    seedDraft();
  });

  // The one place any of these gestures actually reaches `onEdit`. `next` is
  // always composed by the CALLER off `recipe.steps` — never off `stepsDraft` —
  // and this NEVER touches `stepsDraft` itself (#1336 review round 2, blocking
  // 1): re-seeding the whole draft from the write's own result is exactly what
  // let a concurrent rewording of an open box's own step, or any other step,
  // get pulled back in by the very next unrelated gesture. Each caller below
  // updates `stepsDraft` itself, separately, with ONLY the one operation that
  // gesture owns.
  function commitWrite(next: Step[]): void {
    onEdit({ ...recipe, steps: next });
  }

  // A keystroke in one step's words, note, or either timer box. The WRITE
  // patches ONLY the named field(s) onto the matching step in the freshest
  // `recipe.steps` — never the whole draft — so a concurrent write to a
  // SIBLING step (a chat amendment, another phone) is never rolled back by
  // typing in this one. The DRAFT gets the identical patch applied to its own
  // matching step and nothing else, so every other step's draft entry —
  // including one a concurrent write just reworded — is untouched.
  function updateStep(id: string, patch: Partial<Step>): void {
    commitWrite(recipe.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    stepsDraft = stepsDraft.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  // Reorder, remove and `Add step` carry no in-flight text at all — the same
  // argument `RecipeMadeFromCard` makes for holding no draft — so the WRITE
  // composes straight off `recipe.steps`, never off the possibly-stale
  // `stepsDraft`. The DRAFT gets the same structural change applied to its own
  // list — appending the same new step, or filtering the same id — so a
  // sibling step's draft entry, open box included, is never touched.
  function addStep(): void {
    const created = newStep(crypto.randomUUID(), '');
    commitWrite([...recipe.steps, created]);
    stepsDraft = [...stepsDraft, created];
  }

  function removeStep(id: string): void {
    commitWrite(recipe.steps.filter((s) => s.id !== id));
    stepsDraft = stepsDraft.filter((s) => s.id !== id);
  }

  // `ReorderControl` hands back `items` (i.e. `steps`, which while editing IS
  // `stepsDraft`) reordered by one swap. For the WRITE, its CONTENT can be
  // stale — the same draft-vs-store gap every other gesture here has to mind —
  // so only the ORDER OF IDS is taken from it; that order is replayed against
  // the fresh `recipe.steps` objects, and any step the fresh list has that the
  // reordered input didn't (added by a concurrent write since the draft was
  // last seeded) is appended rather than silently dropped. For the DRAFT,
  // `next` is already exactly right as it stands: `ReorderControl.move` only
  // splices POSITIONS, never content, so `next` still holds the draft's own
  // objects — including whatever a still-open box has typed — merely
  // reordered. Assigning it straight to `stepsDraft` reorders the rail without
  // fetching replacement content for a single step.
  function reorderSteps(next: Step[]): void {
    const order = next.map((s) => s.id);
    const byId = new Map(recipe.steps.map((s) => [s.id, s] as const));
    const reordered = order.map((id) => byId.get(id)).filter((s): s is Step => s !== undefined);
    const appended = recipe.steps.filter((s) => !order.includes(s.id));
    commitWrite([...reordered, ...appended]);
    stepsDraft = next;
  }

  // A note is stored as `null` when there is none, never as `''` — that is what
  // makes "this step has a note" a question the dashed slot can answer, and what
  // `dropBlankRows` reads when it decides a wordless step is still worth keeping.
  function setNote(id: string, value: string): void {
    const trimmed = value.trim();
    updateStep(id, { note: trimmed === '' ? null : trimmed });
  }

  // The timer slot is a NOUN (`+ Timer`), so opening it writes nothing — it
  // offers the two boxes a timer is made of, and the first figure typed is what
  // brings one into existence. `+ Add a phase` is an imperative and behaves the
  // other way round; the difference is the label, exactly as `RecipePhaseEditor`
  // records it. So both setters compose a WHOLE timer rather than patching one,
  // which is also what lets a label be typed before a duration.
  function setTimer(id: string, patch: Partial<NonNullable<Step['timer']>>): void {
    // `current` reads the DRAFT deliberately, not `recipe.steps`: this composes
    // what the two timer boxes have typed so far IN THIS SESSION, which is
    // exactly `stepsDraft`'s job (the sibling-step safety is `updateStep`'s,
    // composing the actual write off `recipe.steps` below).
    const current = stepsDraft.find((s) => s.id === id)?.timer ?? null;
    const next = {
      durationMinutes: current?.durationMinutes ?? 0,
      description: current?.description ?? null,
      ...patch,
    };
    // An abandoned `+ Timer` — no minutes ever typed, or typed then cleared back
    // to empty — and no label is not a timer at all. Storing
    // `{ durationMinutes: 0, description: null }` would leave a phantom "0 min"
    // chip in read mode with `Remove timer` the only way out and no reason to go
    // looking (#1336 review, should-fix 4) — and, paired with the blank-row rule
    // now keeping any step with a timer (`blankRows.ts`), a persisted zero
    // timer would keep a wordless step alive forever too. Collapsing back to
    // `null` here is what keeps that state from ever reaching the document.
    updateStep(id, {
      timer: next.durationMinutes === 0 && next.description === null ? null : next,
    });
  }

  function setTimerDescription(id: string, value: string): void {
    const trimmed = value.trim();
    setTimer(id, { description: trimmed === '' ? null : trimmed });
  }

  // Deliberately NOT the phase boxes' `phaseMinutesOrZero`: that one floors and
  // clamps negatives and this one never has (issue #1221). It is the arithmetic
  // the retired editor's `parseNumberOrNull(value) ?? 0` performed, kept so a
  // step timer that accepted `-5` before still does — tying the two rules
  // together is a behaviour change for another issue. Spelled out here because
  // the editor it came from is gone (#1319 Phase 8) and this is now its only
  // home; a second caller is what would earn it a module.
  function stepTimerMinutes(value: string): number {
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }

  // An hour is the point at which a timer stops being something you stand over.
  // Below it you are still in the kitchen; at or above it the step is a wait you
  // plan the evening around, and the two overnight proves in a bread recipe are
  // the whole reason this exists. One threshold, no band in the middle — the same
  // rule `formatMinutes` switches on, so "12 hr" and "Hands-off" always agree.
  const HANDS_OFF_MINUTES = 60;

  function isHandsOff(step: Step): boolean {
    return (step.timer?.durationMinutes ?? 0) >= HANDS_OFF_MINUTES;
  }

  // The chip's words. `formatMinutes` rather than the raw number — this is the
  // markup that genuinely said "720 min".
  //
  // THIS FILE'S TWO UNCOVERABLE BRANCHES are both here, stated rather than left to
  // be found: the `{#if step.timer}` that narrows the type before this is called
  // cannot take its false arm, because `EditableZone` renders a `view` snippet
  // only when `filled` is true and this zone's `filled` IS "the step has a
  // timer"; and the interpolation of this call compiles to `call() ?? ''`, whose
  // fallback a string-returning function never produces. Both came with the markup
  // out of `RecipeViewPage.svelte` rather than being added here.
  function timerChipText(timer: NonNullable<Step['timer']>): string {
    const label = timer.description === null ? '' : ` — ${timer.description}`;
    return `${formatMinutes(timer.durationMinutes)}${label}`;
  }

  function rowNumber(index: number): string {
    return `${index + 1}.`;
  }
</script>

<Card>
  <CardContent class="p-4">
    {#if steps.length === 0}
      <p class="text-sm text-muted-foreground">No steps.</p>
    {/if}
    <!-- The method as a rail (issue #878): a filled disc per step, joined by a
         connector down to the next one, so the sequence is a shape you can take in
         before you read a word of it.

         The rail is drawn PER GAP — one segment from each disc to the one below —
         rather than as a full-height rule behind the column. That is what settles
         the "does a two-step recipe want a rail?" question without a threshold to
         remember: two steps get exactly one short connector, which is the smallest
         mark that says "then this", and a one-step recipe gets no rail at all
         because there is nothing to join. A count rule would make the same page
         draw its steps two different ways depending on how many there are, which
         is a rule the reader has to learn in exchange for nothing. -->
    <ol class="flex flex-col">
      {#each steps as step, idx (step.id)}
        {@const handsOff = isHandsOff(step)}
        {@const firstUse = firstUseByStep.get(step.id) ?? []}
        {@const stepKit = kitByStep.get(step.id) ?? []}
        <li class="relative flex gap-3 pb-5 text-sm last:pb-0" data-testid="recipe-view-step">
          {#if idx < steps.length - 1}
            <span
              class="absolute bottom-0 left-3 top-7 w-px -translate-x-1/2 bg-border"
              aria-hidden="true"
            ></span>
          {/if}
          <!-- Hollow for a step you can walk away from. Shape is never the only
               carrier — the "Hands-off" pill below says it in words, which is what
               a screen reader and a colour-blind cook actually get. -->
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold {handsOff
              ? 'border-2 border-primary bg-card text-primary'
              : 'bg-primary text-primary-foreground'}"
            aria-hidden="true">{idx + 1}</span
          >
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="flex items-start gap-2">
              <EditableZone
                {editing}
                filled={step.text.trim() !== ''}
                label="Edit step"
                slotLabel="Step"
                testId="recipe-edit-step"
                class="min-w-0 flex-1"
                onOpen={seedDraft}
              >
                {#snippet view()}
                  <span class="min-w-0 flex-1" data-testid="recipe-view-step-text">{step.text}</span
                  >
                {/snippet}
                {#snippet edit(close)}
                  <div class="flex w-full flex-col gap-2">
                    <Textarea
                      label="Step"
                      placeholder="Describe this step"
                      value={step.text}
                      onValueChange={(v) => updateStep(step.id, { text: v })}
                      rows={2}
                      autoresize
                      data-testid="recipe-edit-step-field"
                    />
                    <div class="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onclick={close}
                        data-testid="recipe-edit-step-done"
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                {/snippet}
              </EditableZone>
              {#if editing}
                <span class="flex shrink-0 items-start gap-1" data-testid="recipe-edit-step-tools">
                  <span class="sr-only">{rowNumber(idx)}</span>
                  <ReorderControl items={steps} index={idx} noun="step" onReorder={reorderSteps} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => removeStep(step.id)}
                    aria-label="Remove step"
                    data-testid="recipe-edit-step-remove"
                  >
                    <Icon name="Trash2" size={16} />
                  </Button>
                </span>
              {/if}
            </div>

            <!-- What this step is the first to call for, from the
                 `firstUsedInStepId` the recipe already carries. Cook mode has
                 shown this per step since #532; the reading list never did, and
                 the reading list is where you decide whether tonight is the night.

                 The tile is decorative here — the NAME beside it is the accessible
                 content, so a wall of pictograms reads as a list of ingredients
                 rather than as nothing at all. -->
            {#if firstUse.length > 0}
              <ul
                class="flex flex-wrap items-center gap-1.5"
                aria-label="First used in this step"
                data-testid="recipe-view-step-firstuse"
              >
                {#each firstUse as ing (ing.id)}
                  <li class="flex items-center" title={ingredientLabel(ing)}>
                    <span class="flex" aria-hidden="true">
                      <CanonIcon
                        thumbnail={thumbnailFor(ing.canonId)}
                        name={ingredientLabel(ing)}
                        version={iconVersionFor(ing.canonId)}
                        matched={hasLiveCanonMatch(ing, liveCanonIds)}
                        size={32}
                      />
                    </span>
                    <span class="sr-only">{ingredientLabel(ing)}</span>
                  </li>
                {/each}
              </ul>
            {/if}

            <!-- And what to GET OUT for it (issue #882). Beside the first-use row,
                 in the same idiom, because they answer two different questions
                 about the same step: what it is the first to call for, and what it
                 needs in your hand. Two rows that looked alike but said the same
                 thing would be the bug; two rows that look alike and say different
                 things is the point — hence its own `aria-label`, which is the only
                 thing separating them for a screen reader.

                 Listed at the step the tool COMES OUT and not again until it has
                 been put down (the contiguous-run rule in `kitByStep`), so a long
                 braise does not repeat the same casserole under every step.

                 The tile is decorative; the NAME beside it is the accessible
                 content. A label the drawn vocabulary does not know renders its
                 words with no picture — never `CanonIcon`'s bare placeholder tile,
                 which reads as a broken image, and never another tool's drawing. -->
            {#if stepKit.length > 0}
              <ul
                class="flex flex-wrap items-center gap-1.5"
                aria-label="Kit this step calls for"
                data-testid="recipe-view-step-kit"
              >
                {#each stepKit as entry (entry.label)}
                  <li
                    class="flex items-center gap-1"
                    title={entry.label}
                    data-testid="recipe-view-step-kit-item"
                  >
                    {#if $kitIcons.kitIconFor(entry.label)}
                      <span class="flex" aria-hidden="true">
                        <CanonIcon
                          thumbnail={$kitIcons.kitIconFor(entry.label)}
                          version={$kitIcons.kitIconVersionFor(entry.label)}
                          name={entry.label}
                          size={32}
                        />
                      </span>
                      <span class="sr-only">{entry.label}</span>
                    {:else}
                      <!-- No picture, so the words stop being the SR-only label and
                           become the row. -->
                      <span class="text-xs text-muted-foreground">{entry.label}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}

            {#if editing || handsOff || step.timer}
              <!-- Read mode draws this row only when there is something to put in
                   it — an unconditional wrapper here would add one 8px `gap-2` to
                   every step with neither a timer nor the hands-off marker
                   (#1336 review, should-fix 7). Editing keeps the row for the
                   dashed `+ Timer` slot even when both are absent. -->
              <div class="flex flex-wrap items-center gap-1.5">
                {#if handsOff}
                  <!-- Sage: the quiet end of the palette, for the one step marker
                     telling you to walk away rather than to do something, paired
                     against the terracotta timer chip beside it, which is the
                     opposite instruction. (The #878 ribbon keyed its waits to this
                     hue; it went with issue #1213, and the phase timeline that
                     replaced it draws its hands-off time on the teal tint.) -->
                  <span
                    class="inline-flex items-center rounded-full bg-secondary-container px-2 py-0.5 text-xs font-medium text-secondary-container-foreground"
                    data-testid="recipe-view-step-handsoff">Hands-off</span
                  >
                {/if}
                <EditableZone
                  {editing}
                  filled={step.timer !== null}
                  label="Edit timer"
                  slotLabel="Timer"
                  testId="recipe-edit-step-timer"
                  onOpen={seedDraft}
                >
                  {#snippet view()}
                    {#if step.timer}
                      <!-- Terracotta, the palette's accent for a thing that wants
                         attention at a moment (design.md), and `formatMinutes`
                         rather than the raw number — this is the markup that
                         genuinely said "720 min". -->
                      <span
                        class="inline-flex items-center gap-1 rounded-full bg-tertiary-variant/10 px-2 py-0.5 text-xs font-medium text-tertiary-variant"
                        data-testid="recipe-view-step-timer"
                      >
                        <Icon name="Timer" size={12} />
                        {timerChipText(step.timer)}
                      </span>
                    {/if}
                  {/snippet}
                  {#snippet edit(close)}
                    <div class="flex w-full flex-col gap-2">
                      <div class="flex items-end gap-2">
                        <MinutesField
                          label="Minutes"
                          value={step.timer?.durationMinutes ?? 0}
                          parse={stepTimerMinutes}
                          onValueChange={(m) => setTimer(step.id, { durationMinutes: m })}
                          class="w-28"
                          data-testid="recipe-edit-step-timer-minutes"
                        />
                        <TextField
                          label="Timer label"
                          placeholder="e.g. until golden"
                          value={step.timer?.description ?? ''}
                          onValueChange={(v) => setTimerDescription(step.id, v)}
                          class="flex-1"
                          data-testid="recipe-edit-step-timer-label"
                        />
                      </div>
                      <div class="flex justify-between">
                        {#if step.timer}
                          <Button
                            variant="ghost"
                            size="sm"
                            onclick={() => updateStep(step.id, { timer: null })}
                            data-testid="recipe-edit-step-timer-remove"
                          >
                            {#snippet leading()}<Icon name="Trash2" size={16} />{/snippet}
                            Remove timer
                          </Button>
                        {:else}
                          <span></span>
                        {/if}
                        <Button
                          variant="ghost"
                          size="sm"
                          onclick={close}
                          data-testid="recipe-edit-step-timer-done"
                        >
                          Done
                        </Button>
                      </div>
                    </div>
                  {/snippet}
                </EditableZone>
              </div>
            {/if}

            <EditableZone
              {editing}
              filled={step.note !== null}
              label="Edit note"
              slotLabel="Note"
              testId="recipe-edit-step-note"
              class="w-full"
              onOpen={seedDraft}
            >
              {#snippet view()}
                <!-- Terracotta, NOT the amber family. `review` on this page means "a
                     human has not looked at this yet" — the unreviewed-import banner
                     and the guided-plan dot — and a step note is not that: it is a
                     caution about the cooking, written deliberately, and wearing the
                     review colour made it read as an unfinished recipe.

                     No `{#if step.note}` around this: `EditableZone` renders a
                     `view` snippet only when `filled` is true, which for this zone
                     IS "the step has a note", so a guard here would be a branch
                     nothing can reach. -->
                <div
                  class="flex min-w-0 flex-1 items-start gap-2 rounded border border-tertiary-variant/30 bg-tertiary-variant/10 px-3 py-2 text-xs text-tertiary-variant"
                  data-testid="recipe-step-note-content"
                >
                  <Icon name="TriangleAlert" size={13} class="mt-0.5 shrink-0" />
                  <span class="whitespace-pre-wrap">{step.note}</span>
                </div>
              {/snippet}
              {#snippet edit(close)}
                <div class="flex w-full flex-col gap-2">
                  <Textarea
                    label="Note"
                    placeholder="Any note for this step"
                    value={step.note ?? ''}
                    onValueChange={(v) => setNote(step.id, v)}
                    rows={2}
                    autoresize
                    data-testid="recipe-edit-step-note-field"
                  />
                  <div class="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={close}
                      data-testid="recipe-edit-step-note-done"
                    >
                      Done
                    </Button>
                  </div>
                </div>
              {/snippet}
            </EditableZone>
          </div>
        </li>
      {/each}
    </ol>
    {#if editing}
      <!-- `Add step` is an imperative and writes the step it promises, exactly as
           `+ Add a phase` does. Backing straight out therefore leaves a blank step
           on the recipe until Done, which is where `dropBlankRows` takes it off
           again — that is the whole of #1319's blank-row rule, and the reason
           nothing prunes on a keystroke. -->
      <Button variant="outline" size="sm" onclick={addStep} data-testid="recipe-edit-step-add">
        {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
        Add step
      </Button>
    {/if}
  </CardContent>
</Card>
