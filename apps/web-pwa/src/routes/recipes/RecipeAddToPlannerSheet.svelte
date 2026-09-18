<script lang="ts">
  import {
    Button,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { addCalendarDays, type Recipe } from '@salt/domain';
  import { formatDayKey } from '../../lib/dateFormat.js';
  import { todayIso } from '../../lib/today.js';
  import { addRecipeToDay } from '../../lib/mealPlanService.js';
  import { addToast } from '../../lib/toastStore.js';

  // "Add to planner", from the recipe page (issue #1438).
  //
  // A LIST OF NIGHTS, not a month grid. The question this sheet answers is
  // "which night am I cooking this on", and a grid of bare numbers makes you
  // decode a column position into a weekday before you can start. One night per
  // row, named in words, in the order they will happen.
  //
  // Still hand-rolled rather than `<input type="date">`, and that half of the old
  // argument is unchanged: the native control hands the whole interaction to the
  // OS, so the same app shows a wheel on iOS, a Material dialog on Android and a
  // drop-down on desktop — none of them ours, and none of them able to say what
  // is already planned on a night. This is one control on every device, built
  // from Salt primitives.
  //
  // `firstDayOfWeek` is NOT read here any more, and its absence is the point. A
  // list has no week rows to lay out, so nothing in this sheet depends on where
  // the household's week starts. It still decides which `mealPlanWeeks` document
  // a night belongs to — but that is `mealPlanService`'s business, on the write
  // and on any read, and never this component's.
  //
  // Picking a night SELECTS it; the footer button commits. The old comment argued
  // that from grid density, and a list row is a much larger target, so that
  // argument no longer holds and is not the reason. The reasons that do: the
  // write is not undoable from this sheet (the only way back is the planner); a
  // tall scrolling list invites the tap-while-still-settling misfire that a dense
  // grid invites by proximity; and the footer reading the night back in full
  // words is the one moment the user sees what is about to happen stated plainly.

  // How far back the list reaches. Recording what was actually eaten is a
  // legitimate thing to do — the month grid allowed it and nothing here takes it
  // away — but a picker for choosing a night to cook does not need last March.
  const PAST_NIGHTS = 7;
  // The window opens a fortnight ahead and grows by a fortnight, to a ceiling.
  // Planning genuinely far out is the planner's own job: it navigates week by
  // week and has the whole week's context, which is what you want out there.
  const WINDOW_STEP = 14;
  const MAX_AHEAD = 56;

  interface Props {
    recipe: Recipe;
    open: boolean;
  }
  let { recipe, open = $bindable() }: Props = $props();

  let selected = $state(todayIso());
  // How many nights past today the window currently reaches.
  let aheadDays = $state(WINDOW_STEP);
  let busy = $state(false);

  let listEl = $state<HTMLElement | null>(null);
  // Set on open, cleared once tonight's row has been scrolled to. A flag rather
  // than an effect over `nights`, because extending the window must not yank the
  // scroll position back to tonight underneath the reader.
  let pinPending = $state(false);

  // Re-seed on each open: a sheet reopened tomorrow must not still be offering
  // yesterday, and a window the user scrolled out to is not where the next
  // recipe's planning starts.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      selected = todayIso();
      aheadDays = WINDOW_STEP;
      pinPending = true;
    }
    wasOpen = open;
  });

  const today = $derived(todayIso());

  // Oldest first, so the nights run in the order they happen and tonight sits a
  // short scroll down from the top. Nothing above tonight is hidden or disabled.
  const nights = $derived.by(() => {
    const out: string[] = [];
    const last = addCalendarDays(today, aheadDays);
    let d = addCalendarDays(today, -PAST_NIGHTS);
    while (d <= last) {
      out.push(d);
      d = addCalendarDays(d, 1);
    }
    return out;
  });

  const canExtend = $derived(aheadDays < MAX_AHEAD);

  // Scroll tonight to the top of the list once it is on screen. `scrollTop`
  // against the list's own box rather than `scrollIntoView`, which would also
  // scroll every scrollable ancestor — including the page behind the sheet.
  $effect(() => {
    if (!pinPending || !listEl) return;
    const row = listEl.querySelector<HTMLElement>(`[data-date="${today}"]`);
    if (!row) return;
    listEl.scrollTop = row.offsetTop;
    pinPending = false;
  });

  const selectedLabel = $derived(fullLabel(selected));

  function nightLabel(date: string): string {
    return formatDayKey(date, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function fullLabel(date: string): string {
    return formatDayKey(date, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async function handleConfirm(): Promise<void> {
    busy = true;
    const result = await addRecipeToDay(selected, recipe);
    busy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to add to the planner.', 'destructive');
      return;
    }
    open = false;
    addToast(
      result.value === 'already-there'
        ? `Already planned for ${selectedLabel}.`
        : `Added to ${selectedLabel}.`,
      'success',
    );
  }
</script>

<Sheet
  bind:open
  side="bottom"
  onOpenChange={(v) => {
    if (!v) busy = false;
  }}
>
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Add to planner</SheetTitle>
    </SheetHeader>

    <p class="-mt-2 truncate text-sm text-muted-foreground" data-testid="planner-add-recipe-title">
      {recipe.title}
    </p>

    <div
      class="relative max-h-[50vh] flex-1 overflow-y-auto"
      bind:this={listEl}
      data-testid="planner-add-nights"
    >
      <ul class="flex flex-col gap-1">
        {#each nights as date (date)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm transition-colors
                     {date === selected
                ? 'bg-primary font-semibold text-primary-foreground'
                : date < today
                  ? 'text-muted-foreground hover:bg-accent'
                  : 'hover:bg-accent'}"
              aria-pressed={date === selected}
              aria-current={date === today ? 'date' : undefined}
              aria-label={fullLabel(date)}
              onclick={() => (selected = date)}
              disabled={busy}
              data-testid="planner-add-night"
              data-date={date}
            >
              <span class="whitespace-nowrap">
                {#if date === today}<span class="font-semibold">Tonight</span> ·
                {/if}{nightLabel(date)}
              </span>
            </button>
          </li>
        {/each}
      </ul>

      {#if canExtend}
        <div class="pt-1">
          <Button
            variant="ghost"
            size="sm"
            class="w-full"
            onclick={() => (aheadDays = Math.min(aheadDays + WINDOW_STEP, MAX_AHEAD))}
            disabled={busy}
            data-testid="planner-add-more"
          >
            More nights
          </Button>
        </div>
      {/if}
    </div>

    <SheetFooter class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}
        >Cancel</Button
      >
      <Button
        size="sm"
        onclick={handleConfirm}
        loading={busy}
        disabled={busy}
        data-testid="recipe-add-to-planner-confirm"
      >
        Add to {selectedLabel}
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
