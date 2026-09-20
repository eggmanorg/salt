<script lang="ts">
  import { Button, CanonIcon, Icon } from '@salt/ui-components';
  import type { Ingredient } from '@salt/domain';
  import type { GuidedCheckInDoc, GuidedStepNoteDoc } from '@salt/domain/schemas';
  import { ingredientIcons, ingredientLabel } from '../../lib/cookIngredientIcons.js';
  import { kitIcons } from '../../lib/kitIcons.js';
  import IngredientText from './IngredientText.svelte';
  import GuidedPlanLine from './GuidedPlanLine.svelte';

  // WHAT THE PLAN ADDS UNDER ONE STEP, drawn once for both screens that draw it
  // (issue #1453): the guided cook deck, and the review screen the plan is read on
  // before it is ever cooked from.
  //
  // The review screen claims to show a step "exactly as the cook will see it". One
  // component rendering both is what makes that claim MECHANICAL rather than a
  // sentence in a PR body (CLAUDE.md rule 12) — a copy would drift the first time
  // the cook deck changed. The boundary of the claim is worth stating precisely:
  // it covers THE NOTE ROWS below, not the whole screen. The cook deck's timer,
  // kit row, step chrome and geometry are its own, and the review screen does not
  // show them.
  //
  // `edit` absent is the cook: every row is text, nothing is tappable, and this
  // renders exactly what GuidedCookPage rendered inline before the extraction.
  // `edit` present turns each row into a line you tap to change, and adds the
  // "+ setup / + cue" row for the lines the plan left unsaid. There is no mode
  // flag anywhere: the presence of the handlers IS the difference.

  interface GuidedStepNotesEdit {
    /**
     * The step's timer, in minutes — null when it has none. A reminder hangs off
     * a timer, so a step without one is never offered the "+ reminder" row.
     */
    timerMinutes: number | null;
    onSetContainer: (value: string | null) => void;
    onSetSetup: (value: string | null) => void;
    onSetCue: (value: string | null) => void;
    onSetCheckIn: (index: number, checkIn: GuidedCheckInDoc) => void;
    onAddCheckIn: (checkIn: GuidedCheckInDoc) => void;
    onRemoveCheckIn: (index: number) => void;
  }

  let {
    note,
    containerContents,
    loose,
    checkIns,
    scale = 1,
    edit,
  }: {
    note: GuidedStepNoteDoc | null;
    /** What is in the bowl this step names. Empty when no job fills that name. */
    containerContents: readonly Ingredient[];
    /** Used here, out of no bowl this step names. */
    loose: readonly Ingredient[];
    /** The step's reminders — empty on a step whose timer is gone. */
    checkIns: readonly GuidedCheckInDoc[];
    scale?: number;
    edit?: GuidedStepNotesEdit | undefined;
  } = $props();

  // Which absent line the "+" row has just opened. Purely local: an add that is
  // abandoned writes nothing, so there is no half-made line anywhere but here.
  let adding = $state<'container' | 'setup' | 'cue' | null>(null);

  // A reminder being composed. NOT written until it has words — the document
  // never holds a reminder that says nothing, so an abandoned add leaves no trace
  // in the plan. Its minutes default to halfway through the timer, which is the
  // one guess the screen can make that is always inside it.
  let pending = $state<{ atMinutes: number; text: string } | null>(null);

  const said = $derived({
    container: note?.container?.trim() ?? '',
    setup: note?.setup?.trim() ?? '',
    cue: note?.cue?.trim() ?? '',
  });

  const anything = $derived(
    loose.length > 0 ||
      said.container !== '' ||
      said.setup !== '' ||
      said.cue !== '' ||
      checkIns.length > 0,
  );

  function startReminder(): void {
    const minutes = edit?.timerMinutes ?? null;
    if (minutes === null) return;
    pending = { atMinutes: Math.max(1, Math.round(minutes / 2)), text: '' };
  }

  // A reminder's minutes, as typed. Anything that is not a positive number is
  // ignored rather than rejected — there is no save to refuse, and the line the
  // user was looking at simply stays as it was.
  function parseMinutes(raw: string): number | null {
    const minutes = Number(raw.trim());
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  }
</script>

<!-- The row shapes below are the cook deck's, moved wholesale: the same classes,
     the same testids, the same order. Anything that changes here changes on both
     screens, which is the point of the file. -->
{#snippet body(text: string)}
  <span class="whitespace-pre-wrap text-base text-muted-foreground">{text}</span>
{/snippet}

{#snippet glyph(name: 'Flame' | 'Ear' | 'Bell', label: string, tint: string)}
  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md {tint}">
    <Icon {name} size={17} ariaLabel={label} />
  </span>
{/snippet}

{#if edit || anything}
  <ul
    class="flex flex-col gap-2.5 border-l-2 border-secondary/40 pl-4"
    data-testid="guided-step-notes"
  >
    {#if said.container !== '' || adding === 'container'}
      <li class="flex flex-col gap-2" data-testid="guided-step-note-container">
        <span class="flex items-start gap-3">
          {#if said.container !== ''}
            <!-- The same drawn vessel as the mise card's header (issue #882),
                 resolved from the step's own words so the two surfaces cannot
                 disagree about which bowl this is. -->
            <CanonIcon
              thumbnail={$kitIcons.kitIconFor(said.container)}
              version={$kitIcons.kitIconVersionFor(said.container)}
              name={said.container}
              size={32}
            />
          {/if}
          {#if edit}
            <GuidedPlanLine
              class="min-w-0 flex-1"
              value={said.container}
              ariaLabel="the bowl this step wants"
              placeholder="onion bowl"
              startOpen={adding === 'container'}
              onCommit={(v) => edit.onSetContainer(v === '' ? null : v)}
              onClose={() => (adding = null)}
            >
              {@render body(said.container)}
            </GuidedPlanLine>
          {:else}
            {@render body(said.container)}
          {/if}
        </span>
        <!-- What is actually in it, nested UNDER the name: the name is the handle
             the cook already knows from the prep screen, and the contents are the
             amounts that screen showed. Empty when no job fills this name, in
             which case the row above is all there is. -->
        {#if containerContents.length > 0}
          <ul class="ml-10 flex flex-col gap-1.5">
            {#each containerContents as ingredient (ingredient.id)}
              <li class="flex items-center gap-2" data-testid="guided-step-container-contents">
                <CanonIcon
                  thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                  name={ingredientLabel(ingredient)}
                  version={$ingredientIcons.iconVersionFor(ingredient)}
                  size={32}
                />
                <span class="min-w-0 flex-1 text-base">
                  <IngredientText {ingredient} {scale} />
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/if}

    <!-- Used here, out of no bowl. Plain cook mode reprints every ingredient at
         the step that first uses it; this is that list with the bowl's own
         contents taken out, so nothing is said twice and nothing goes unsaid.
         Never editable on either screen — it is the RECIPE's, not the plan's. -->
    {#each loose as ingredient (ingredient.id)}
      <li class="flex items-center gap-3" data-testid="guided-step-loose">
        <span
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary/10 text-secondary"
        >
          <Icon name="Plus" size={17} ariaLabel="Also" />
        </span>
        <CanonIcon
          thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
          name={ingredientLabel(ingredient)}
          version={$ingredientIcons.iconVersionFor(ingredient)}
          size={32}
        />
        <span class="min-w-0 flex-1 text-base">
          <IngredientText {ingredient} {scale} />
        </span>
      </li>
    {/each}

    {#if said.setup !== '' || adding === 'setup'}
      <li class="flex items-start gap-3" data-testid="guided-step-note-setup">
        {@render glyph('Flame', 'Setup', 'bg-tertiary-variant/10 text-tertiary-variant')}
        {#if edit}
          <GuidedPlanLine
            class="min-w-0 flex-1"
            value={said.setup}
            ariaLabel="how the station is set"
            placeholder="small hob burner, medium-low"
            startOpen={adding === 'setup'}
            onCommit={(v) => edit.onSetSetup(v === '' ? null : v)}
            onClose={() => (adding = null)}
          >
            {@render body(said.setup)}
          </GuidedPlanLine>
        {:else}
          {@render body(said.setup)}
        {/if}
      </li>
    {/if}

    {#if said.cue !== '' || adding === 'cue'}
      <li class="flex items-start gap-3" data-testid="guided-step-note-cue">
        {@render glyph('Ear', 'Cue', 'bg-primary/10 text-primary')}
        {#if edit}
          <GuidedPlanLine
            class="min-w-0 flex-1"
            value={said.cue}
            ariaLabel="what to listen or look for"
            placeholder="a very gentle sizzle, not a crackle"
            startOpen={adding === 'cue'}
            onCommit={(v) => edit.onSetCue(v === '' ? null : v)}
            onClose={() => (adding = null)}
          >
            {@render body(said.cue)}
          </GuidedPlanLine>
        {:else}
          {@render body(said.cue)}
        {/if}
      </li>
    {/if}

    {#each checkIns as checkIn, i (i)}
      <li class="flex items-start gap-3" data-testid="guided-step-check-in">
        {@render glyph('Bell', 'Check in', 'bg-secondary/10 text-secondary')}
        <!-- `whitespace-pre-wrap` sits on the AUTHORED TEXT alone, never on a span
             that also holds markup: this row is the only note built from more than
             one interpolation, and on the outer span the source's own newline and
             indentation were preserved verbatim on screen. -->
        <span class="min-w-0 flex-1 text-base text-muted-foreground">
          {#if edit}
            <span class="inline-flex flex-wrap items-baseline gap-1">
              <GuidedPlanLine
                value={String(checkIn.atMinutes)}
                ariaLabel="when this reminder fires"
                numeric
                onCommit={(v) => {
                  const minutes = parseMinutes(v);
                  if (minutes !== null) edit.onSetCheckIn(i, { ...checkIn, atMinutes: minutes });
                }}
              >
                <span class="font-medium text-foreground">{checkIn.atMinutes} min in</span>
              </GuidedPlanLine>
              <span>—</span>
              <GuidedPlanLine
                class="min-w-0 flex-1"
                value={checkIn.text}
                ariaLabel="what the reminder says"
                placeholder="give it a stir, or the bottom will catch"
                onCommit={(v) => edit.onSetCheckIn(i, { ...checkIn, text: v })}
              >
                <span class="whitespace-pre-wrap">{checkIn.text}</span>
              </GuidedPlanLine>
            </span>
          {:else}
            <span class="font-medium text-foreground">{checkIn.atMinutes} min in</span>
            —
            <span class="whitespace-pre-wrap">{checkIn.text}</span>
          {/if}
        </span>
        {#if edit}
          <button
            type="button"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="Remove this reminder"
            onclick={() => edit.onRemoveCheckIn(i)}
            data-testid="guided-plan-check-in-delete"
          >
            <Icon name="Trash2" size={14} />
          </button>
        {/if}
      </li>
    {/each}

    {#if edit && pending}
      <li class="flex items-start gap-3" data-testid="guided-step-check-in-pending">
        {@render glyph('Bell', 'Check in', 'bg-secondary/10 text-secondary')}
        <span class="min-w-0 flex-1 text-base text-muted-foreground">
          <span class="inline-flex flex-wrap items-baseline gap-1">
            <GuidedPlanLine
              value={String(pending.atMinutes)}
              ariaLabel="when this reminder fires"
              numeric
              onCommit={(v) => {
                const minutes = parseMinutes(v);
                if (minutes !== null && pending) pending = { ...pending, atMinutes: minutes };
              }}
            >
              <span class="font-medium text-foreground">{pending.atMinutes} min in</span>
            </GuidedPlanLine>
            <span>—</span>
            <GuidedPlanLine
              class="min-w-0 flex-1"
              value={pending.text}
              ariaLabel="what the reminder says"
              placeholder="give it a stir, or the bottom will catch"
              startOpen
              onCommit={(v) => {
                if (v !== '' && pending)
                  edit.onAddCheckIn({ atMinutes: pending.atMinutes, text: v });
              }}
              onClose={() => (pending = null)}
            >
              <span class="whitespace-pre-wrap">{pending.text}</span>
            </GuidedPlanLine>
          </span>
        </span>
      </li>
    {/if}

    {#if edit}
      <!-- The lines the plan did not say. A blank labelled box with an example in
           it reads as advice the plan is giving; a "+" that opens a line only when
           there is something to say does not. -->
      <li class="flex flex-wrap items-center gap-1">
        {#if said.container === '' && adding !== 'container'}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (adding = 'container')}
            data-testid="guided-plan-add-container"
          >
            {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
            bowl
          </Button>
        {/if}
        {#if said.setup === '' && adding !== 'setup'}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (adding = 'setup')}
            data-testid="guided-plan-add-setup"
          >
            {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
            setup
          </Button>
        {/if}
        {#if said.cue === '' && adding !== 'cue'}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (adding = 'cue')}
            data-testid="guided-plan-add-cue"
          >
            {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
            cue
          </Button>
        {/if}
        {#if edit.timerMinutes !== null && !pending}
          <Button
            size="sm"
            variant="ghost"
            onclick={startReminder}
            data-testid="guided-plan-add-check-in"
          >
            {#snippet leading()}<Icon name="BellPlus" size={14} />{/snippet}
            reminder during the timer
          </Button>
        {/if}
      </li>
    {/if}
  </ul>
{/if}
