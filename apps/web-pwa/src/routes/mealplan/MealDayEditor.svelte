<script lang="ts">
  import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { ChefHat, Clock, Utensils } from '@lucide/svelte';
  import {
    recipeHeroUrl,
    weatherIcon,
    temperatureBand,
    type Day,
    type Member,
    type Recipe,
    type TemperatureBand,
  } from '@salt/domain';
  import type { WeatherDaySummary } from '@salt/domain/schemas';
  import { BAND_CLASS } from './temperatureBandClass.js';
  import WeatherIcon from '$lib/weather-icons/WeatherIcon.svelte';
  import MealDayDetail from './MealDayDetail.svelte';
  import { recipeIndex, resolveRecipeIds } from '../../lib/attachedRecipes.js';

  // Editor for a single Day, shared by the weekly page (date-keyed) and the
  // template editor (weekday-keyed).
  //
  // Collapsed it is a LEDGER ROW (#639, Phase 1): a dated rail down the left
  // (weekday over date, today's date in a filled teal disc) and, to its right,
  // the day's card — the recipe photograph as a clean, undamaged rectangle, the
  // meal title beneath it in Epilogue, then one quiet grey meta line (who is
  // cooking · who is eating, by name · any home time actually set). No text over
  // the photo, no scrim, no border, no wash. A day with no photo is not
  // second-class: the card is a text block with the meal one step larger.
  //
  // TAPPING THE ROW OPENS THE DAY IN A BOTTOM SHEET (#640, Phase 1) — the detail
  // is no longer a panel pushed in underneath, which shoved the rest of the week
  // down the deck. `open` is a BINDABLE prop, not row-local state: the PAGE owns
  // which day is open (in memory only — Rule 3), so exactly one day is ever open,
  // and a Firestore snapshot re-render can no longer collapse the day you are
  // editing. It knows nothing about day keys: the parent supplies handlers
  // already bound to the right date/weekday. Members resolve live; an unknown
  // memberId renders as removable, never blocking. See docs/meal-planning.md.
  //
  // What the sheet CONTAINS lives in `MealDayDetail` (#663, Phase 1): this file
  // owns the row and the sheet, and every prop and callback below that the detail
  // needs is handed straight through.
  //
  // `weather` (issue #382, Phase 3) is the OPTIONAL per-day evening forecast. The
  // PARENT does the in-window gating: the dated weekly page passes
  // `forecast?.days[date]` (present only for concrete in-window days), while the
  // weekday-keyed template editor never passes it — so weather renders only on
  // in-window dated days and is blank for past/far-future days and the template.
  interface Props {
    label: string;
    sublabel?: string;
    // The day's sheet heading. `label`/`sublabel` are sized for the RAIL — "THU"
    // over "30" — so the planner passes the day written out in full here
    // ("Thursday 30 July") rather than widening the rail. Optional: the template
    // editor's `label` is already the whole weekday, so it says nothing extra and
    // the fallback below is exactly right.
    sheetTitle?: string;
    // Which day is open is owned by the PAGE, not the row (#640): bindable so the
    // parent can hold one `openDay` for the whole week and get one-at-a-time for
    // free. In memory only — never persisted (Rule 3).
    open?: boolean;
    day: Day;
    members: Member[];
    // Full recipe list, resolved live so attached ids render their current title
    // (never denormalised onto the plan doc). Missing/deleted ids are skipped.
    // Optional: the weekday-keyed template editor omits it and stays recipe-free.
    recipes?: readonly Recipe[];
    // The same recipes indexed by id (#940). See `MealDayDetail`.
    recipesById?: ReadonlyMap<string, Recipe> | undefined;
    testid: string;
    // Today's row wears its date in a filled teal disc, so the eye lands on it
    // without reading. Date-only, so the weekday-keyed template editor omits it.
    isToday?: boolean;
    // `| undefined` so the parent can pass `forecast?.days[date]` directly under
    // exactOptionalPropertyTypes (noUncheckedIndexedAccess makes it optional).
    weather?: WeatherDaySummary | undefined;
    // The concrete day this row is for, `YYYY-MM-DD` (issue #652, Phase 2). The
    // one thing the placeholder attach needs that nothing else in here has: the
    // rail's `sublabel` is a bare day number and `label` a weekday word. Optional,
    // and its absence is the gate — the weekday-keyed template editor has no dates
    // at all, so it never attaches anything, the same way it renders no picker.
    dateKey?: string;
    onNoteChange: (note: string) => void;
    onChefToggle: (memberId: string) => void;
    onAttendeeToggle: (memberId: string) => void;
    onAttendeeHomeTime: (memberId: string, homeTime: string | null) => void;
    onAttendeeNote: (memberId: string, note: string) => void;
    onGuestsChange: (guests: number) => void;
    // Optional: present only in the dated week editor. When absent (the template
    // editor) the recipe picker and chips are not rendered — recipe-free.
    onRecipesChange?: (recipeIds: string[]) => void;
    // Optional: present only in the dated week editor. When provided, each attached
    // recipe row gains an "Add to shop" action that hands the FULL recipe up to the
    // page, which owns the RecipeAddToListSheet + default-list guard (Phase 4, #469).
    // Absent in the recipe-free template editor, so it gains no shopping UI — all
    // shopping imports stay out of this shared component.
    onRecipeAddToList?: (recipe: Recipe) => void;
  }
  let {
    label,
    sublabel,
    sheetTitle,
    open = $bindable(false),
    day,
    members,
    recipes = [],
    recipesById,
    testid,
    isToday = false,
    weather,
    dateKey,
    onNoteChange,
    onChefToggle,
    onAttendeeToggle,
    onAttendeeHomeTime,
    onAttendeeNote,
    onGuestsChange,
    onRecipesChange,
    onRecipeAddToList,
  }: Props = $props();

  // The sheet's heading. Falls back to the rail's own words, which is the whole
  // answer for the template editor ("Monday") and a sane one anywhere else.
  const heading = $derived(sheetTitle ?? `${label}${sublabel ? ` ${sublabel}` : ''}`);

  // ─── Attached recipes (issue #17) ──────────────────────────────────────────
  // Five consumers now share this resolution, so it lives in
  // `lib/attachedRecipes.ts` — which carries the reasoning, including why an id
  // with no matching recipe is skipped rather than rendered. The comment that
  // used to stand here argued FOR keeping the copy, on a count of two consumers;
  // at five that argument no longer holds (issue #1055).
  const lookup = $derived(recipeIndex(recipesById, recipes));
  const attachedRecipes = $derived(resolveRecipeIds(day.recipeIds, lookup));

  // Display-time cache-bust for the row thumbnail (mirrors RecipeListPage, issue
  // #460): a regenerated hero reuses the same Storage URL, so bust it with the
  // per-regeneration nonce (`imageRequestedAt`, falling back to `updatedAt`). Null
  // when there is no image — the row then shows the kind's fallback pictogram.
  //
  // `imageHidden` is deliberately NOT consulted. The field is retired: neither
  // RecipeListPage nor RecipeViewPage reads it any more, so a document still
  // carrying a legacy `true` would blank the planner thumbnail while the same
  // photo showed on every other screen. The schema field stays (production data
  // holds it); this was its last reader in web-pwa.
  // The rule itself is `recipeHeroUrl` in `@salt/domain` (issue #933); the
  // paragraph above is the part that is local to the planner.

  // The day's weather pictogram (issue #387), resolved from the forecast's
  // weatherCode/isDay. Null for absent/unknown codes — and, crucially, null for
  // every day the parent gives no `weather` (past, out-of-horizon, the template
  // row), so the watermark below simply doesn't render for them: graceful
  // absence identical to today's no-weather behaviour, no placeholder box.
  const icon = $derived(weather ? weatherIcon(weather) : null);

  const isAttending = (id: string): boolean => day.attendees.some((a) => a.memberId === id);
  const isChef = (id: string): boolean => day.chefs.includes(id);
  const attendeeOf = (id: string) => day.attendees.find((a) => a.memberId === id);

  const attendingCount = $derived(day.attendees.length + day.guests);

  // `day.chefs` empty ⇒ the row's meta line opens with a "No cook" flag so an
  // unassigned day still stands out in an otherwise uniformly grey line.
  const hasCook = $derived(day.chefs.length > 0);

  // The meal's FIRST line only for the collapsed row — the meal field is a
  // multi-line textarea, but the row shows a single truncating title. Empty →
  // the muted "Nothing planned" line. It says nothing is PLANNED rather than
  // that no meal is set because, since #652, every planned night carries a
  // photograph — so this row is now the only kind of day without one, and it
  // should read as the hole in the week that it is.
  const mealFirstLine = $derived(day.note.split('\n')[0]?.trim() ?? '');

  // ─── The row's photograph (#639) ───────────────────────────────────────────
  // The first attached recipe that actually has a visible hero. Null on a day
  // with no recipe (or none with a photo) — the card then becomes a text block
  // with the meal one step larger, deliberately NOT a placeholder tile.
  const photoUrl = $derived(
    attachedRecipes.map((r) => recipeHeroUrl(r)).find((u): u is string => u !== null) ?? null,
  );

  // Nothing has been decided for this day yet — not a note, not a recipe. That is
  // the ONE state the week wants you to notice: it is the work still to do.
  //
  // Deliberately NOT "has no photograph". A night whose whole plan is the word
  // "Leftovers" is as planned as one with a hero shot; it just has no picture
  // yet, and dressing it as an unanswered question would be a lie about the week.
  // Whether a note-only night eventually earns art of its own is a separate
  // question (placeholder heroes) — this flag stays about the PLAN.
  const needsPlanning = $derived(!mealFirstLine && attachedRecipes.length === 0);

  // ─── The row's cook-and-table line (#639, reshaped in #640) ────────────────
  // Two facts, one at each end: who is cooking, and who is at the table.
  // It used to be one sentence naming every eater, which with five in the house —
  // two of them here only part of the week — was the longest and least stable
  // thing in the row, so #639 reduced it to a head count. The names are back, but
  // only when the line can hold them (see `namesFit`): a number is what a narrow
  // row falls back to, not what it settles for.
  const cookNames = $derived(members.filter((m) => isChef(m.id)).map((m) => m.name));
  const homeTimes = $derived(
    members
      .filter((m) => isAttending(m.id))
      .map((m) => ({ name: m.name, at: attendeeOf(m.id)?.homeTime ?? null }))
      .filter((x): x is { name: string; at: string } => x.at !== null && x.at !== '')
      .map((x) => `${x.name} ${x.at}`),
  );

  // Who is eating, named. Guests have no names to give, so they stay a tally on
  // the end — "Daniel, Sam +2" — which is also the only honest thing to render.
  const eaterNames = $derived(members.filter((m) => isAttending(m.id)).map((m) => m.name));
  const eaterLabel = $derived(
    [eaterNames.join(', '), day.guests > 0 ? `+${day.guests}` : ''].filter(Boolean).join(' '),
  );

  // Names, or the number? The line's parts are already ranked — the cook and any
  // late arrival never truncate, because "who is cooking" and "someone is not
  // here yet" are the facts you scan for — so the eaters are what has to give, and
  // giving means falling back to the count rather than trailing off in an ellipsis.
  //
  // Decided on the LENGTH OF THE TEXT rather than by measuring the box. Measuring
  // would mean rendering the names, discovering they overflow and swapping them
  // for the count — which changes the width, which re-admits the names: a loop
  // that only stops with a hidden twin of the line to measure against, in fourteen
  // rows at once. The budget below is that measurement done once — the line holds
  // 38 characters of its own 12px type on a 393px phone, four fewer when the clock
  // chip is in it — and it is a decision to TRY, not a promise, because the names
  // still carry `truncate`. Guess high on a narrower handset and a long name
  // clips, which is the same graceful end the cook name has always had.
  const META_CHAR_BUDGET = 36;
  const CLOCK_CHIP_CHARS = 4;
  const namesFit = $derived(
    eaterNames.length > 0 &&
      (hasCook ? cookNames.join(' & ').length : 'No cook'.length) +
        homeTimes.join(', ').length +
        (homeTimes.length ? CLOCK_CHIP_CHARS : 0) +
        eaterLabel.length <=
        META_CHAR_BUDGET,
  );

  // Evening-window temperature band (drives the header temp colour, cool→warm).
  // The ramp itself is shared with WeatherSummary (`temperatureBandClass.ts`);
  // it used to be written out here byte-identically. Null whenever there's no
  // forecast for this day.
  const band = $derived<TemperatureBand | null>(weather ? temperatureBand(weather.tempHigh) : null);
</script>

<!-- One day = one object in the list (#639). What draws the object's edge depends
     on what the day HAS: a photograph is its own boundary, and a day without one
     gets a bordered card instead. Either way the rail on the left and the 24px the
     page puts between rows do the rest. -->
<div data-testid={testid}>
  <!-- The two rows of the card, defined once and rendered into either the scrim
       over the photograph or the bare text block, so a change lands in both.
       Every colour is passed in, because the ink is a fact about the GROUND the
       row sits on (near-black photograph vs the page) and nothing else differs. -->
  {#snippet mealLine(sizeCls: string, inkCls: string, mutedCls: string)}
    <span
      class="line-clamp-2 text-center font-display font-semibold leading-snug {sizeCls} {mealFirstLine
        ? inkCls
        : mutedCls}"
      data-testid={`${testid}-meal`}
    >
      {mealFirstLine || 'Nothing planned'}
    </span>
  {/snippet}

  <!-- Cook on the left, the table on the right, and the row's priority written
       into the flex: the cook and any home time are shrink-0 and never truncate,
       so the ONE thing that can give way is the head count — which is already a
       number. Who is actually eating is named in the sheet, a tap away. -->
  {#snippet tableLine(inkCls: string, noCookCls: string)}
    <span class="flex items-center gap-2.5 text-xs {inkCls}" data-testid={`${testid}-meta`}>
      <span class="flex min-w-0 shrink items-center gap-1.5">
        <ChefHat class="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
        {#if hasCook}
          <span class="truncate">{cookNames.join(' & ')}</span>
        {:else}
          <span class="whitespace-nowrap {noCookCls}" data-testid={`${testid}-no-cook`}>
            No cook
          </span>
        {/if}
      </span>
      <span class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        {#if namesFit}
          <span class="truncate" data-testid={`${testid}-eaters`}>{eaterLabel}</span>
        {:else}
          <span class="shrink-0 font-semibold tabular-nums">{attendingCount}</span>
        {/if}
        <Utensils class="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
        {#if homeTimes.length}
          <span class="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <Clock class="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
            {homeTimes.join(', ')}
          </span>
        {/if}
      </span>
    </span>
  {/snippet}

  <!-- The collapsed row (#639, Phase 1): dated rail | photograph → title → meta.
       The whole row is the tap target; tapping raises the day's sheet (#640).
       No `aria-expanded`: nothing expands in place any more, and the dialog the
       sheet opens carries its own ARIA set (role, modality, labelled by its
       title). Markup otherwise untouched. -->
  <button
    type="button"
    class="flex w-full gap-3 text-left"
    onclick={() => (open = true)}
    data-testid={`${testid}-summary`}
  >
    <!-- The dated rail: weekday over date, an edge to run the eye down. Today's
         date sits in a filled teal disc (the primary token), so "where am I in
         the week" is answered without reading. The evening forecast rides at the
         foot of the rail — gated on `weather` (not `icon`), so an older cached
         doc with no pictogram still shows its temperature; the glyph self-hides
         when the code is absent. -->
    <!-- The rail is narrow when it carries a date disc (the planner, where a tight
         column is the point). The template editor has no dates, so its rail holds a
         bare weekday word — "Wednesday" wraps at w-14, hence the wider track. -->
    <div class="flex {sublabel ? 'w-14' : 'w-20'} shrink-0 flex-col items-center gap-1">
      <span
        class="text-center text-xs font-semibold uppercase leading-tight tracking-wider text-muted-foreground"
      >
        {label}
      </span>
      {#if sublabel}
        <span
          class="flex h-8 min-w-8 items-center justify-center rounded-full px-1 text-base font-semibold leading-none tabular-nums {isToday
            ? 'bg-primary text-primary-foreground'
            : 'text-foreground'}"
          data-testid={`${testid}-date`}
        >
          {sublabel}
        </span>
      {/if}
      {#if weather}
        <span class="flex flex-col items-center" data-testid={`${testid}-weather-header`}>
          {#if icon}
            <WeatherIcon {icon} class="h-8 w-8" />
          {/if}
          <span
            class="text-xs leading-none tabular-nums {band ? BAND_CLASS[band] : ''}"
            data-testid={`${testid}-header-temp`}
          >
            <span class="font-semibold">{weather.tempHigh}°</span><span
              class="font-normal opacity-80">/{weather.tempLow}°</span
            >
          </span>
        </span>
      {/if}
    </div>

    <!-- The day's card. The two rows RIDE THE FOOT of the photograph rather than
         sitting under it: the row gives back the height the text used to cost and
         the picture gets a wider 1.6:1 crop in the same space. A day with no photo
         is not second-class — the same two rows in a bordered card, with the meal
         one step larger and in the page's own ink. Both cases render from the
         snippets below, so the two layouts cannot drift apart. -->
    <div class="flex min-w-0 flex-1 flex-col">
      {#if photoUrl}
        <div class="relative overflow-hidden rounded-lg">
          <img
            src={photoUrl}
            alt=""
            loading="lazy"
            class="aspect-[1.6] w-full object-cover"
            data-testid={`${testid}-photo`}
          />
          <!-- The scrim is readability, not decoration: opaque at the foot and
               clear before the middle, so no more of the dish is veiled than the
               two rows actually need. -->
          <!-- `gap-1.5`, not `gap-0.5`: the title and the cook-and-table line are
               two different facts, and at 2px apart they read as one block of text
               laid over the dish. The ink is off-white rather than white — pure
               white against a near-black scrim is harder than anything else on the
               page and made the title shout over its own photograph. -->
          <div
            class="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-black/100 via-black/60 to-transparent px-3 py-2.5"
          >
            {@render mealLine('text-base', 'text-white/90', 'text-white/70')}
            {@render tableLine(
              'text-white/75',
              'rounded bg-destructive px-1.5 font-medium text-destructive-foreground',
            )}
          </div>
        </div>
      {:else}
        <!-- A day with no photograph is still a CARD. Unboxed, it had no bottom
             edge of its own, so two such days in a row ran together and the rail
             beside them — which is taller than two lines of text — finished below
             the words it belongs to, leaving the weather glyph adrift under the
             previous day. The box gives the row an edge and a floor.
             `min-h-[6.5rem]` is the rail's own height (weekday 14 + date disc 32 +
             glyph 32 + temperature 10, plus the gaps) and a little over, so the
             whole of the date column is held inside the card rather than hanging
             out of the bottom of it. The cook-and-table line sits at the FOOT and
             the meal centres in what is left, so the card carries its two facts in
             the same places the photograph does — the eye finds the cook on the
             bottom edge of every row in the week, picture or no picture. -->
        <div
          class="flex min-h-[6.5rem] flex-col gap-2 rounded-lg border px-3 py-2.5 {needsPlanning
            ? 'border-dashed border-muted-foreground/40 bg-muted/50'
            : 'border-border bg-card'}"
          data-testid={`${testid}-card`}
        >
          <span class="flex min-w-0 flex-1 items-center justify-center">
            {@render mealLine('text-lg', 'text-foreground', 'text-muted-foreground')}
          </span>
          {@render tableLine('text-muted-foreground', 'text-destructive')}
        </div>
      {/if}
    </div>
  </button>

  <!-- The day opens in a bottom sheet (#640, Phase 1). The deck moves its column
       with a transform, which creates a containing block — so an in-row `fixed`
       panel would be trapped by it. `portal` is left at its default ('body'),
       which is what puts the sheet over the whole dimmed week. Scrim, focus trap,
       scroll lock, Escape and outside-click dismissal all come from the Dialog
       underneath; there is no drag-to-dismiss. -->
  <Sheet bind:open side="bottom">
    <!-- Two documented overrides of the bottom variant (#930): `dvh` rather than
         the primitive's `vh`, because this sheet is tall enough for a mobile URL
         bar to matter; and a tighter `gap-3`. The home-bar padding this file
         used to write by hand is now the variant's, and is gone from here. -->
    <SheetContent class="max-h-[85dvh] gap-3">
      <SheetHeader>
        <SheetTitle>{heading}</SheetTitle>
      </SheetHeader>

      <!-- The base sheet class carries no max-height and no overflow, so the
           scrolling region is constrained HERE, by the host: the header and
           footer stay put and only the day's detail moves. -->
      <MealDayDetail
        class="max-h-[70dvh] overflow-y-auto"
        {day}
        {members}
        {recipes}
        {recipesById}
        {testid}
        {weather}
        {dateKey}
        {onNoteChange}
        {onChefToggle}
        {onAttendeeToggle}
        {onAttendeeHomeTime}
        {onAttendeeNote}
        {onGuestsChange}
        {onRecipesChange}
        {onRecipeAddToList}
      />

      <!-- Every edit above is already saved (fire-and-forget through the parent's
           handlers), so the footer has nothing to confirm — only a way out that
           does not require finding the scrim. -->
      <SheetFooter>
        <SheetClose class="h-9 w-auto rounded-md border border-input px-4 text-sm font-medium">
          Done
        </SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</div>
