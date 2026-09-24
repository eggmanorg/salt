<script lang="ts">
  import {
    Button,
    Icon,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { addCalendarDays, weekStartFor, type MealPlanWeek, type Recipe } from '@salt/domain';
  import { formatDayKey } from '../../lib/dateFormat.js';
  import { todayIso } from '../../lib/today.js';
  import {
    addRecipeToDay,
    firstDayOfWeek,
    loadWeekForDisplay,
    mealPlanConfigLoaded,
  } from '../../lib/mealPlanService.js';
  import { currentMember, members } from '../../lib/membersService.js';
  import { recipesById } from '../../lib/recipeService.js';
  import { resolveRecipeIds } from '../../lib/attachedRecipes.js';
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
  // `firstDayOfWeek` no longer lays anything out here, and that is the point: a
  // list has no week rows, so nothing this sheet DRAWS depends on where the
  // household's week starts. It is still read, for one thing — which
  // `mealPlanWeeks` document a night's summary has to come out of, and it
  // answers 'mon' until the config snapshot lands and the sheet can be opened
  // before that.
  //
  // Reactivity alone does NOT make that window safe (issue #1448 review,
  // finding 1 — a false invariant this comment used to assert). Reactivity
  // repairs the rows once config arrives; it does nothing about the read
  // issued BEFORE that, which lands on a document keyed by the fallback rather
  // than the household's real setting. `loadMealPlanWeek` answering "no such
  // document" for that wrong key is a legitimate, successful read — not a
  // pending one and not a `Failure` — so it cannot be told apart from a
  // genuinely empty week by its shape alone. `known` is therefore gated on
  // `mealPlanConfigLoaded` as well as on the snapshot: a row stays in the
  // not-yet-known state until the read it is showing was made under a
  // SETTLED `firstDayOfWeek`, never a defaulted one.
  //
  // Each row says what is already on that night and who is cooking it, which is
  // most of why the list beats a grid: choosing a free night stops being
  // guesswork. Those reads are DISPLAY ONLY — see `loadWeekForDisplay`, which
  // states in full why nothing read here may reach the service's week cache. The
  // write path is untouched by them and still reads for itself.
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

  // The week documents the visible window spans, keyed by start date. Absent
  // means "not in hand yet"; `'unavailable'` means the read failed. Both draw
  // the same placeholder, because both are the same thing to the reader — we do
  // not know. What neither may draw is _Nothing planned_, which would be a
  // confident lie about the one fact the row exists to tell.
  type WeekSnapshot = MealPlanWeek | null | 'unavailable';
  let weekSnapshots = $state<Record<string, WeekSnapshot>>({});
  // Which starts have been asked for, so extending the window reads the weeks it
  // newly needs and no others. Deliberately not `$state`: it gates the request
  // effect and must never retrigger it.
  let requested = new Set<string>();

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
      // A summary is a snapshot taken when the sheet opened. A sheet reopened
      // later takes a fresh one rather than showing what the last one saw.
      weekSnapshots = {};
      requested = new Set();
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

  // The two or three week documents the visible nights live in.
  const weekStarts = $derived([...new Set(nights.map((d) => weekStartFor(d, $firstDayOfWeek)))]);

  $effect(() => {
    if (!open) return;
    for (const start of weekStarts) {
      if (requested.has(start)) continue;
      requested.add(start);
      void loadWeekForDisplay(start).then((read) => {
        weekSnapshots = {
          ...weekSnapshots,
          [start]: read.kind === 'ok' ? read.value : 'unavailable',
        };
      });
    }
  });

  interface NightRow {
    date: string;
    /** Tonight — the row the list opens on, and the only one named in words twice. */
    isToday: boolean;
    /** The night's document is in hand. False while reading, and after a failed read. */
    known: boolean;
    /** The meal, or _Nothing planned_. Empty while `known` is false. */
    meal: string;
    /** The cook line, or null on a night with nothing planned — nothing to cook. */
    cook: string | null;
    /** All of the above in one string: an `aria-label` replaces a button's content. */
    label: string;
  }

  // Every visible night, and what it already holds.
  //
  // The meal is `day.note`'s first line, failing that the titles of the night's
  // attached recipes, failing that _Nothing planned_. Deliberately NOT the
  // planner row's `mealFirstLine || 'Nothing planned'`: that would read _Nothing
  // planned_ for a night this very recipe is already on, which is the worst lie
  // this particular control could tell.
  //
  // The cook is `day.chefs`, in the planner row's own vocabulary, plus
  // _Cooking_ for a taken night the roster cannot name yet, which the planner
  // row leaves blank — you, the cook's name, or _No cook_ on a planned night
  // nobody has taken. A night whose `chefs` the roster cannot currently name
  // (still loading, or the member was removed) reads _Cooking_ here: someone
  // has it, and _No cook_ would say otherwise.
  // Whether anyone has it is `chefs.length`, as `MealDayEditor`'s `hasCook` is,
  // never whether `$members` resolved a name. "Am I
  // cooking" is `chefs.includes(currentMember.id)` and nothing else, the same
  // sentence the Kitchen's `isMine` is (`personalViewService.ts`): a projection
  // over family-shared data, storing nothing per user and gating nothing. With
  // no current member — cold launch, or an email not on the roster — nothing is
  // marked as yours and the cooks are still named, because naming needs no
  // current member and guessing at one would be a second definition of the fact.
  const rows = $derived.by<NightRow[]>(() => {
    const me = $currentMember;
    return nights.map((date) => {
      const snapshot = weekSnapshots[weekStartFor(date, $firstDayOfWeek)];
      // A snapshot answered under the 'mon' fallback is a read of the WRONG
      // document whenever the household is not actually Monday-first — see the
      // header comment. Until the config doc has settled, no row may claim to
      // know what is on it, no matter what the (mis-keyed) read came back with.
      const known = $mealPlanConfigLoaded && snapshot !== undefined && snapshot !== 'unavailable';
      const week = snapshot === undefined || snapshot === 'unavailable' ? null : snapshot;
      const day = week?.days[date];
      const note = day?.note.split('\n')[0]?.trim() ?? '';
      const titles = day ? resolveRecipeIds(day.recipeIds, $recipesById).map((r) => r.title) : [];
      const planned = note || titles.join(', ');
      const chefs = day?.chefs ?? [];
      const named = $members
        .filter((m) => chefs.includes(m.id) && m.id !== me?.id)
        .map((m) => m.name);
      const cooks = [...(me && chefs.includes(me.id) ? ['You'] : []), ...named];
      const meal = known ? planned || 'Nothing planned' : '';
      const cook = planned
        ? cooks.length
          ? cooks.join(' & ')
          : chefs.length
            ? 'Cooking'
            : 'No cook'
        : null;
      return {
        date,
        isToday: date === today,
        known,
        meal,
        cook,
        label: [fullLabel(date), meal, cook === 'No cook' ? 'no cook' : cook && `cooking: ${cook}`]
          .filter((part): part is string => typeof part === 'string' && part !== '')
          .join(', '),
      };
    });
  });

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
    const result = await addRecipeToDay(selected, recipe, $recipesById);
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
  onOpenChange={() => {
    // A dismissal clears the in-flight flag: the recipe page reopens this sheet
    // rather than remounting it, so a stale `busy` would arrive with everything
    // disabled. The argument is ignored on purpose — `open` comes from the
    // caller, so the only change this ever hears is a close, and "nothing is in
    // flight" is the right answer for an open too.
    busy = false;
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
        {#each rows as row (row.date)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm transition-colors
                     {row.date === selected
                ? 'bg-primary font-semibold text-primary-foreground'
                : row.date < today
                  ? 'text-muted-foreground hover:bg-accent'
                  : 'hover:bg-accent'}"
              aria-pressed={row.date === selected}
              aria-current={row.isToday ? 'date' : undefined}
              aria-label={row.label}
              onclick={() => (selected = row.date)}
              disabled={busy}
              data-testid="planner-add-night"
              data-date={row.date}
            >
              <span class="shrink-0 whitespace-nowrap">
                {#if row.isToday}<span class="font-semibold">Tonight</span> ·
                {/if}{nightLabel(row.date)}
              </span>

              {#if row.known}
                <span
                  class="min-w-0 flex-1 truncate {row.cook === null && row.date !== selected
                    ? 'text-muted-foreground'
                    : ''}"
                  data-testid="planner-add-night-meal"
                >
                  {row.meal}
                </span>
              {:else}
                <!-- The week is not in hand — reading, or the read failed. Either
                     way the row is still pickable: the write does its own read. -->
                <span class="min-w-0 flex-1" data-testid="planner-add-night-unknown">
                  <span class="block h-2.5 w-20 animate-pulse rounded bg-muted-foreground/25"
                  ></span>
                </span>
              {/if}

              {#if row.cook !== null}
                <span
                  class="flex shrink-0 items-center gap-1.5 text-xs {row.date === selected
                    ? ''
                    : 'text-muted-foreground'}"
                  data-testid="planner-add-night-cook"
                >
                  <Icon name="ChefHat" size={15} />
                  {row.cook}
                </span>
              {/if}
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
