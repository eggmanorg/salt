<script lang="ts">
  import {
    Button,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import { ChefHat, X } from '@lucide/svelte';
  import { push } from 'svelte-spa-router';
  import {
    recipeHeroUrl,
    expandForPlanner,
    isPlannable,
    memberInitials,
    mergePlannerRecipeIds,
    pickPlaceholder,
    takesIngredients,
    type Day,
    type Member,
    type Recipe,
    type RecipeKind,
  } from '@salt/domain';
  import type { WeatherDaySummary } from '@salt/domain/schemas';
  import { onDestroy } from 'svelte';
  import { flushMealPlanWrites } from '../../lib/mealPlanService.js';
  import WeatherSummary from './WeatherSummary.svelte';
  import { KIND_COPY, kindOf } from '../recipes/recipeKind.js';
  import { recipeIndex, resolveRecipeIds } from '../../lib/attachedRecipes.js';
  import { quarterHourOptions } from '../../lib/timeOptions.js';

  // The DETAIL of a single Day — everything you can edit about an evening, with
  // no opinion about where it is rendered. Three stacked blocks, top→bottom:
  // (1) forecast strip, (2) Dinner (meal + attached recipes + picker),
  // (3) At the table (roster, guests, eating count).
  //
  // Split out of MealDayEditor (#663, Phase 1), which keeps the collapsed ledger
  // row and the bottom sheet and renders this inside it. Every prop and callback
  // is passed straight through, so this component knows nothing about day keys:
  // the page supplies handlers already bound to the right date/weekday. Members
  // resolve live; an unknown memberId renders as removable, never blocking.
  // See docs/meal-planning.md.
  //
  // `weather` (issue #382, Phase 3) is the OPTIONAL per-day evening forecast. The
  // PARENT does the in-window gating: the dated weekly page passes
  // `forecast?.days[date]` (present only for concrete in-window days), while the
  // weekday-keyed template editor never passes it — so weather renders only on
  // in-window dated days and is blank for past/far-future days and the template.
  interface Props {
    day: Day;
    members: Member[];
    // Full recipe list, resolved live so attached ids render their current title
    // (never denormalised onto the plan doc). Missing/deleted ids are skipped.
    // Optional: the weekday-keyed template editor omits it and stays recipe-free.
    recipes?: readonly Recipe[];
    // The same recipes indexed by id, for resolving `day.recipeIds` (#940).
    // Supplied by the page from `recipeService`'s derived index so one map is
    // shared by every row. Optional for the same reason `recipes` is.
    // `| undefined` so the sheet can forward its own optional prop straight
    // through under exactOptionalPropertyTypes, as `weather` does.
    recipesById?: ReadonlyMap<string, Recipe> | undefined;
    testid: string;
    // `| undefined` so the parent can pass `forecast?.days[date]` directly under
    // exactOptionalPropertyTypes (noUncheckedIndexedAccess makes it optional).
    weather?: WeatherDaySummary | undefined;
    // The concrete day this detail is for, `YYYY-MM-DD` (issue #652, Phase 2). The
    // one thing the placeholder attach needs that nothing else in here has.
    // Optional, and its absence is the gate — the weekday-keyed template editor
    // has no dates at all, so it never attaches anything, the same way it renders
    // no picker.
    //
    // `| undefined` here and on the two optional callbacks below, for the same
    // reason `weather` carries it: MealDayEditor holds them as its own optional
    // props and hands them straight down, which under exactOptionalPropertyTypes
    // is passing `T | undefined` rather than omitting the attribute.
    dateKey?: string | undefined;
    // Extra classes for the root, so THE HOST OWNS ITS OWN SCROLLING CONSTRAINT.
    // The detail is just a stack of blocks; whether it is capped in height and
    // scrolls (the sheet) or flows to its natural length (anywhere else) is a
    // fact about the container, not about the day.
    class?: string;
    onNoteChange: (note: string) => void;
    onChefToggle: (memberId: string) => void;
    onAttendeeToggle: (memberId: string) => void;
    onAttendeeHomeTime: (memberId: string, homeTime: string | null) => void;
    onAttendeeNote: (memberId: string, note: string) => void;
    onGuestsChange: (guests: number) => void;
    // Optional: present only in the dated week editor. When absent (the template
    // editor) the recipe picker and chips are not rendered — recipe-free.
    onRecipesChange?: ((recipeIds: string[]) => void) | undefined;
    // Optional: present only in the dated week editor. When provided, each attached
    // recipe row gains an "Add to shop" action that hands the FULL recipe up to the
    // page, which owns the RecipeAddToListSheet + default-list guard (Phase 4, #469).
    // Absent in the recipe-free template editor, so it gains no shopping UI — all
    // shopping imports stay out of this shared component.
    onRecipeAddToList?: ((recipe: Recipe) => void) | undefined;
  }
  let {
    day,
    members,
    recipes = [],
    recipesById,
    testid,
    weather,
    dateKey,
    class: className = '',
    onNoteChange,
    onChefToggle,
    onAttendeeToggle,
    onAttendeeHomeTime,
    onAttendeeNote,
    onGuestsChange,
    onRecipesChange,
    onRecipeAddToList,
  }: Props = $props();

  // ─── Attached recipes (issue #17) ──────────────────────────────────────────
  // One resolution, shared by five consumers — `lib/attachedRecipes.ts` carries
  // the reasoning, including the fallback index and why an id with no matching
  // recipe is skipped rather than rendered as a broken row.
  //
  // NOTE the `{#each}` below is KEYED on `r.id`, so this list must not be handed
  // a day whose `recipeIds` contain a duplicate. Nothing in the app can produce
  // one — the picker excludes what is already attached — and the resolution
  // deliberately preserves duplicates rather than hiding that.
  const lookup = $derived(recipeIndex(recipesById, recipes));
  const attachedRecipes = $derived(resolveRecipeIds(day.recipeIds, lookup));
  // Picker options exclude already-attached recipes so the same dish can't be
  // added twice, and anything that cannot occupy a dinner slot — a cocktail is
  // not dinner (issue #637). The gate is `isPlannable`, never a comparison
  // against a kind: a fourth kind decides whether it belongs here in the domain
  // capability table, not in this file. Items are {value: id, label: title},
  // matching the canon picker.
  const recipePickerItems: ComboboxItemType[] = $derived(
    recipes
      .filter((r) => isPlannable(kindOf(r)) && !day.recipeIds.includes(r.id))
      .map((r) => ({ value: r.id, label: r.title })),
  );
  // Kind by id, so a picker row can wear the badge that says what it is. A
  // separate projection because `ComboboxItemType` is the shared primitive's
  // contract ({value,label}) and must not grow a Salt-specific field — the badge
  // is composed here, in the app, out of the item's own `value`.
  const kindById = $derived(new Map<string, RecipeKind>(recipes.map((r) => [r.id, kindOf(r)])));
  function recipeFilter(input: string, item: ComboboxItemType): boolean {
    return item.label.toLowerCase().includes(input.trim().toLowerCase());
  }
  // Remount key: bumped after each add so the Combobox input clears (it only
  // syncs its label from `value` at mount — same reason RecipeEditPage keys it).
  let recipePickerKey = $state(0);
  function addRecipe(id: string): void {
    if (!id || day.recipeIds.includes(id)) return;
    // Auto-fill the empty meal field with the recipe's title (Phase 3, #469). The
    // title is a live UI value (resolved from `recipes`, never denormalised onto
    // the plan), so this stays purely in the app-layer handler using the existing
    // `onNoteChange` — no title knowledge leaks into the domain or any mutator.
    // Guard on `day.note` AT ATTACH TIME: `onNoteChange` is fire-and-forget and
    // `day.note` only updates once the store re-emits, so a non-empty note is
    // never overwritten and the first attached recipe wins.
    //
    // Picking a MEAL attaches the whole dinner (#752, Phase 2): the meal, then
    // its component dishes, deduped against what the night already carries. The
    // meal leads, which is what makes the note above read "Sunday roast" and the
    // day's card wear the meal's photograph — both mechanics are untouched.
    // Frozen here: editing the meal later never rewrites this night.
    //
    // An ordinary recipe expands to just itself, so there is no meal branch and
    // nothing changed for a night planned one dish at a time.
    //
    // The picker's own options are built FROM `recipes` and it is `restrict`ed,
    // so an id that resolves to nothing cannot come from here; bailing is simply
    // the honest answer to a value we cannot expand.
    const picked = recipes.find((r) => r.id === id);
    if (!picked) return;
    if (!day.note.trim()) onNoteChange?.(picked.title);
    onRecipesChange?.(mergePlannerRecipeIds(day.recipeIds, expandForPlanner(picked)));
    recipePickerKey += 1;
  }
  function removeRecipe(id: string): void {
    onRecipesChange?.(day.recipeIds.filter((r) => r !== id));
  }

  // ─── The note-only night gets a photograph too (#652, Phase 2) ─────────────
  // A night planned in a sentence — "roast chicken dinner", no recipe attached
  // and none ever coming, because nobody writes a recipe for roast chicken — is
  // as planned as any other, but in the week it is a thin line of text between
  // full cards, so it reads as a gap in the ledger. So a PLACEHOLDER is attached
  // to it: an ordinary recipe document whose hero says "a good dinner is planned"
  // without claiming a particular dish. It lands in `day.recipeIds` like anything
  // else, which is what makes the mechanism legible — it is a row you can see and
  // remove, in the list just above, not a picture that appears for reasons you
  // cannot inspect.
  //
  // ON BLUR, never in an `$effect`. An effect reconciling "has a note, has no
  // recipe" would fire across every rendered day — seven to fourteen of them —
  // and each one is a whole-week `setDoc` through `persistWeek`. Blur is one
  // write per user action, exactly the shape of the note re-seed beside it.
  //
  // The pick is FROZEN here. `pickPlaceholder` reads the evening's forecast once,
  // at the real moment the day was planned, and the id it returns is stored;
  // nothing re-evaluates it afterwards, so the picture cannot drift as the
  // forecast ages out of its ~14-day horizon.
  //
  // No `kind` branch, and none needed: we hand over every recipe we hold and the
  // domain filters to placeholders itself (and skips any whose hero generation
  // failed — a card with no photograph is worse than the text it replaced).
  // `null` means "nothing to attach", including before a single placeholder has
  // been built, and the day simply stays a block of text.
  function attachPlaceholder(): void {
    if (!dateKey || !onRecipesChange || day.recipeIds.length > 0) return;
    const id = pickPlaceholder(recipes, dateKey, weather);
    if (id) onRecipesChange([id]);
  }

  // Display-time cache-bust for the recipe thumbnail (mirrors RecipeListPage,
  // issue #460): a regenerated hero reuses the same Storage URL, so bust it with
  // the per-regeneration nonce (`imageRequestedAt`, falling back to `updatedAt`).
  // Null when there is no image — the row then shows the kind's fallback
  // pictogram.
  //
  // `imageHidden` is deliberately NOT consulted. The field is retired: neither
  // RecipeListPage nor RecipeViewPage reads it any more, so a document still
  // carrying a legacy `true` would blank the planner thumbnail while the same
  // photo showed on every other screen. The schema field stays (production data
  // holds it); this was its last reader in web-pwa.
  // The rule itself is `recipeHeroUrl` in `@salt/domain` (issue #933); the
  // paragraph above is the part that is local to the planner.
  // Tapping a row's thumbnail/title opens that recipe's full view page. Hash
  // routing (svelte-spa-router), identical to RecipeListPage's card click; the
  // Remove button stops propagation so it never triggers navigation.
  function openRecipe(id: string): void {
    push(`/recipes/${id}`);
  }

  // Home time is optional and picked as ONE dropdown (#640, Phase 2) rather than a
  // native <input type="time">, which renders a different control on every OS
  // (spinner / wheel / free-text) and makes the minutes an unwanted scroll through
  // all 60 values. This field answers "when are you home for dinner", so the list
  // is deliberately short and whole: the dinner window on the quarter hour,
  // 17:00–22:45 (24 entries), plus "No time" to clear. One tap, one choice — the
  // times on offer are exactly what the old [HH]:[MM] pair could produce. Empty
  // value = no home time set: the trigger reads "No time" while the Select's own
  // value seeds to the dinner default so an opened list lands on ~18:30 rather
  // than at the top. Stored 24h "HH:MM" matches the summary chip. A legacy value
  // off the quarter hour or outside the window is displayed VERBATIM in the
  // trigger (never silently reset); it simply isn't in the list, so re-picking
  // means moving into the window.
  const DINNER_TIME = '18:30';
  const TIME_OPTIONS = quarterHourOptions(17, 24);

  // Picking "No time" (value '') clears to null; every other option is already a
  // whole "HH:MM" and stores verbatim.
  const commitTime = (memberId: string, t: string): void => {
    onAttendeeHomeTime(memberId, t === '' ? null : t);
  };

  // ─── The personal note lives behind an affordance (#640, Phase 3) ──────────
  // A member is ONE LINE. The per-person note is the rare exception ("portion for
  // tomorrow"), so it costs one extra tap to write and nothing to ignore — but a
  // note that already exists is never hidden: it renders unprompted, and its
  // affordance is tinted, so nobody has to go looking. Which notes are open is
  // in-memory only (Rule 3) and per member — a plain record, keyed by memberId,
  // deliberately not persisted anywhere. An entry is absent until the member's
  // affordance is tapped; absent means "whatever the note itself implies", so the
  // toggle is handed the state it is flipping rather than reading the record.
  let notesOpen = $state<Record<string, boolean>>({});
  function toggleNote(id: string, shown: boolean): void {
    notesOpen[id] = !shown;
  }

  const isAttending = (id: string): boolean => day.attendees.some((a) => a.memberId === id);
  const isChef = (id: string): boolean => day.chefs.includes(id);
  const attendeeOf = (id: string) => day.attendees.find((a) => a.memberId === id);

  // Attendees referencing someone no longer in the roster — rendered removable so
  // the document is never silently corrupted.
  const unknownAttendees = $derived(
    day.attendees.filter((a) => !members.some((m) => m.id === a.memberId)),
  );
  const attendingCount = $derived(day.attendees.length + day.guests);

  // Auto-grow the multiline meal field to fit its content. Re-runs whenever the
  // note changes (typing, or load-template swapping the value in).
  let noteEl: HTMLTextAreaElement | undefined = $state();
  $effect(() => {
    const _note = day.note; // track
    if (noteEl) {
      noteEl.style.height = 'auto';
      noteEl.style.height = `${noteEl.scrollHeight}px`;
    }
  });

  // Write timing lives in the service (issue #940) — this component still owns
  // no day keys and no write shape, only the two moments at which "the user has
  // stopped typing" is known here and nowhere else: leaving a field, and the
  // sheet going away. The debounce alone would lose the last edit when the sheet
  // is dismissed inside its window; blur alone never fires for Playwright's
  // `fill()`. Hence both, and hence the one service import in an otherwise
  // prop-driven component.
  onDestroy(() => void flushMealPlanWrites());
</script>

<!-- Detail (Phase 2, #469): three stacked blocks, top→bottom —
     (1) forecast strip, (2) Dinner (meal + recipes), (3) At the table (roster).
     Flatter and shorter than the old form: the forecast leads, and the roster
     is one tidy row per member (avatar = eating toggle, chef-hat = cooking),
     with shift/late times revealed only for people who are eating. -->
<div class="flex flex-col gap-4 {className}" data-testid={`${testid}-detail`}>
  <!-- 1. Forecast strip: the evening forecast leads the detail. Real-week only
       — gated on `weather`, so the weekday template editor and out-of-horizon
       days render nothing (parent passes no weather there). Keeps WeatherSummary's
       tap-tooltip metric chips. -->
  {#if weather}
    <WeatherSummary {weather} testid={`${testid}-weather`} />
  {/if}

  <!-- 2. Dinner: the meal field and any attached recipes, grouped. -->
  <div class="flex flex-col gap-2">
    <label class="text-xs font-medium text-muted-foreground" for={`${testid}-note`}>Dinner</label>
    <textarea
      bind:this={noteEl}
      id={`${testid}-note`}
      rows="1"
      class="w-full resize-none overflow-hidden rounded-md border bg-background px-3 py-2 text-sm"
      placeholder="What's for dinner?"
      value={day.note}
      oninput={(e) => onNoteChange(e.currentTarget.value)}
      onblur={(e) => {
        // Re-seed an emptied meal field from the first attached recipe. The
        // attach-time seed (see `addRecipe`) only fires once, so clearing the
        // text used to leave a day with a recipe and no meal. BLUR, not input:
        // while the caret is in the field the text is the user's — they may be
        // mid-way through replacing it — so the refill waits until they leave
        // it empty. Read the DOM value, not `day.note`: `onNoteChange` is
        // fire-and-forget and the prop lags the store re-emit. Guard on
        // `attachedRecipes` so a since-deleted recipe id can't seed nothing.
        if (!e.currentTarget.value.trim() && attachedRecipes[0])
          onNoteChange(attachedRecipes[0].title);
        // …and the mirror image (#652, Phase 2): a day left with a MEAL and
        // no recipe gets a placeholder, so it carries a card like every
        // other planned night. Same event, and mutually exclusive with the
        // re-seed above — that one needs the field empty, this one needs it
        // written. Read the DOM value here too, for the same reason.
        else if (e.currentTarget.value.trim()) attachPlaceholder();
        // Last, so the re-seed / placeholder edits queued just above ride out
        // with the note itself in one document write (issue #940).
        void flushMealPlanWrites();
      }}
      data-testid={`${testid}-note`}></textarea>

    <!-- Attached recipes (issue #17): the chosen recipes as thumbnail rows, then
       a quiet "Add a recipe" picker at the foot. Selecting a recipe APPENDS its
       id; the picker remounts (keyed) so its input clears, ready for the next
       add. Rendered only in the week editor (onRecipesChange present); the
       weekday template editor omits the prop and stays recipe-free. -->
    {#if onRecipesChange}
      <div class="flex flex-col gap-1.5" data-testid={`${testid}-recipes`}>
        {#each attachedRecipes as r (r.id)}
          {@const url = recipeHeroUrl(r)}
          {@const kind = kindOf(r)}
          <div
            class="flex items-center justify-between gap-2 rounded border px-2 py-1.5"
            data-testid={`${testid}-recipe-row-${r.id}`}
          >
            <!-- Thumbnail + title open the recipe's full view. One button owns the
               leading thumbnail and the title so the whole area is the tap
               target; the Remove button (a sibling, not nested) keeps its own
               handler and never triggers navigation. -->
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left"
              onclick={() => openRecipe(r.id)}
              data-testid={`${testid}-recipe-open-${r.id}`}
            >
              <span class="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                {#if url}
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    class="h-full w-full object-cover"
                    data-testid={`${testid}-recipe-thumb-${r.id}`}
                  />
                {:else}
                  <span
                    class="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-muted/40 text-muted-foreground/60"
                    data-testid={`${testid}-recipe-thumb-fallback-${r.id}`}
                  >
                    <!-- The kind's own pictogram, so a photo-less takeaway
                         reads as a takeaway rather than a pot. Copy/icon
                         selection only — no behaviour hangs off this. -->
                    <Icon name={KIND_COPY[kind].thumbIcon} size={18} />
                  </span>
                {/if}
              </span>
              <span class="min-w-0 truncate text-sm">{r.title}</span>
            </button>
            <!-- Add to shop (Phase 4, #469): hand the full recipe up to the page,
               which guards the default list then opens RecipeAddToListSheet.
               Rendered only when the parent supplies the callback — the template
               editor omits it and so stays shopping-free.
               Also gated on `takesIngredients` (#637): a takeaway has nothing
               to buy, so the action simply isn't offered rather than opening a
               sheet with an empty plan. -->
            {#if onRecipeAddToList && takesIngredients(kind)}
              <Button
                variant="ghost"
                size="sm"
                onclick={(e) => {
                  e.stopPropagation();
                  onRecipeAddToList?.(r);
                }}
                aria-label={`Add ${r.title} to shopping list`}
                data-testid={`${testid}-recipe-addshop-${r.id}`}
              >
                <Icon name="ShoppingCart" size={16} />
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="sm"
              onclick={(e) => {
                e.stopPropagation();
                removeRecipe(r.id);
              }}
              aria-label={`Remove ${r.title}`}
              data-testid={`${testid}-recipe-remove-${r.id}`}
            >
              <X class="h-4 w-4" />
            </Button>
          </div>
        {/each}
        {#key recipePickerKey}
          <Combobox
            items={recipePickerItems}
            value=""
            filterFn={recipeFilter}
            restrict
            placeholder="Add a recipe or idea…"
            onValueChange={addRecipe}
          >
            <ComboboxField>
              <ComboboxInput data-testid={`${testid}-recipe-picker`} />
              <ComboboxTrigger />
            </ComboboxField>
            <ComboboxContent>
              {#snippet children({ filteredItems })}
                {#each filteredItems as item, i (item.value)}
                  {@const kind = kindById.get(item.value) ?? 'recipe'}
                  <!-- A "When you CBA" option sits in the same list as the
                       recipes and is told apart by a small quiet chip. The
                       badge is COPY: `KIND_COPY[kind].label` names it, and
                       `recipe` — the norm — wears nothing, so the picker
                       looks exactly as it does today for anyone who never
                       adds an alternative. The chip is inside the option, so
                       it is part of the option's accessible name too and a
                       screen reader hears "Takeaway — Indian, When you CBA".
                       `ComboboxItem`'s `children` snippet takes no arguments,
                       so this closes over the loop's own `item`. -->
                  <ComboboxItem {item} index={i} class="gap-2">
                    {#snippet children()}
                      <span class="min-w-0 flex-1 truncate">{item.label}</span>
                      {#if kind !== 'recipe'}
                        <span
                          class="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {KIND_COPY[kind].label}
                        </span>
                      {/if}
                    {/snippet}
                  </ComboboxItem>
                {/each}
                {#if filteredItems.length === 0}
                  <ComboboxEmpty>Nothing found</ComboboxEmpty>
                {/if}
              {/snippet}
            </ComboboxContent>
          </Combobox>
        {/key}
      </div>
    {/if}
  </div>

  <!-- 3. At the table: A MEMBER IS ONE LINE (#640, Phase 3). Avatar, name,
     home time and chef hat all sit on a single row; the free-text personal
     note — the rare thing, wanted on maybe one person on maybe one evening —
     hides behind a small affordance beside the chef hat. On an ordinary
     evening with nobody noted the whole table fits without scrolling.
     The avatar toggles EATING (a checkbox — tap to opt in/out); the chef-hat
     toggles COOKING, independent of eating (a chef need not eat). Home time
     and the note affordance show only for members who are eating. Unknown
     attendees stay removable; guests are a small +/- stepper at the foot. -->
  <div class="flex flex-col gap-2">
    <span class="text-xs font-medium text-muted-foreground">At the table</span>
    {#each members as m (m.id)}
      {@const a = attendeeOf(m.id)}
      {@const attending = isAttending(m.id)}
      {@const note = a?.note ?? ''}
      <!-- Untouched (`undefined`) ⇒ open iff a note is already written, so an
         existing note is never hidden; once the member's affordance has been
         tapped that explicit choice wins in both directions. -->
      {@const noteShown = attending && (notesOpen[m.id] ?? note !== '')}
      <div class="flex flex-col gap-1" data-testid={`${testid}-attendee-${m.id}`}>
        <div class="flex items-center gap-2">
          <!-- Avatar = eating toggle. `role="checkbox"` + aria-checked keep it an
             accessible toggle and satisfy the roster tests; filled when eating,
             muted when not. The testid wraps it so `within(attend).getByRole`
             resolves the avatar. -->
          <span data-testid={`${testid}-attend-${m.id}`}>
            <button
              type="button"
              role="checkbox"
              aria-checked={attending}
              aria-label={m.name}
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors
              {attending
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground/60 hover:bg-muted/70'}"
              onclick={() => onAttendeeToggle(m.id)}
            >
              {memberInitials(m.name)}
            </button>
          </span>
          <span
            class="min-w-0 flex-1 truncate text-sm {attending
              ? 'font-medium text-foreground'
              : 'text-muted-foreground'}"
          >
            {m.name}
          </span>
          {#if attending}
            <!-- Home time as one quarter-hour dropdown (#640, Phase 2), now on
               the member's own line. `value` seeds to the dinner default so a
               blank field opens at ~18:30 (not at the top of the window), while
               the trigger reads "No time" until a real value is set. -->
            <Select value={a?.homeTime || DINNER_TIME} onValueChange={(v) => commitTime(m.id, v)}>
              <SelectTrigger
                class="h-8 w-20 shrink-0 justify-center px-1 tabular-nums {a?.homeTime
                  ? ''
                  : 'text-muted-foreground'}"
                aria-label={`${m.name} home time`}
                data-testid={`${testid}-time-${m.id}`}
              >
                {a?.homeTime || 'No time'}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No time</SelectItem>
                {#each TIME_OPTIONS as t (t)}
                  <SelectItem value={t}>{t}</SelectItem>
                {/each}
              </SelectContent>
            </Select>
            <!-- The note affordance. Empty note = a quiet outline the eye skips;
               a note already written = filled in the primary tint, so "someone
               has said something about tonight" reads off the closed row without
               opening anything. -->
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors
              {note !== ''
                ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-input bg-background text-muted-foreground hover:bg-muted'}"
              onclick={() => toggleNote(m.id, noteShown)}
              aria-expanded={noteShown}
              aria-label={note !== '' ? `${m.name} note: ${note}` : `Add a note for ${m.name}`}
              data-testid={`${testid}-attnote-toggle-${m.id}`}
            >
              <Icon name="StickyNote" size={16} />
            </button>
          {/if}
          <!-- Chef-hat = cooking toggle, independent of eating. Plain button so both
             states are fully Tailwind: selected = the pale terracotta `tertiary-tint`
             ground with its own legible ink, unselected = clear neutral. It reads as
             a peer of the note toggle above rather than as an alarm — the two are the
             same kind of "someone has said something about tonight" mark, in the two
             accents the theme keeps for them. Selected is asserted by class in
             MealPlanWeekPage.test.ts. -->
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors
            {isChef(m.id)
              ? 'border-tertiary-tint bg-tertiary-tint text-tertiary-tint-foreground hover:bg-tertiary-tint/70'
              : 'border-input bg-background text-muted-foreground hover:bg-muted'}"
            onclick={() => onChefToggle(m.id)}
            aria-pressed={isChef(m.id)}
            aria-label={`${m.name} is cooking`}
            data-testid={`${testid}-chef-${m.id}`}
          >
            <ChefHat class="h-4 w-4" />
          </button>
        </div>
        {#if noteShown}
          <!-- The note itself, on its own line under the name (ml-11 = the avatar
             plus the row gap). Still fire-and-forget per keystroke — the parent
             owns the write, and since #940 the service coalesces the burst into
             one document write, which blur flushes. Opening it here pins the row
             so clearing the text mid-edit cannot yank the field out from under
             the caret. -->
          <input
            class="ml-11 h-8 rounded-md border bg-background px-2 text-sm"
            placeholder="Add a note (e.g. portion for tomorrow)"
            value={note}
            oninput={(e) => {
              notesOpen[m.id] = true;
              onAttendeeNote(m.id, e.currentTarget.value);
            }}
            onblur={() => void flushMealPlanWrites()}
            aria-label={`${m.name} note`}
            data-testid={`${testid}-attnote-${m.id}`}
          />
        {/if}
      </div>
    {/each}

    {#each unknownAttendees as a (a.memberId)}
      <div
        class="flex items-center justify-between gap-2 rounded border border-dashed px-2 py-1.5"
        data-testid={`${testid}-unknown-${a.memberId}`}
      >
        <span class="truncate text-sm text-muted-foreground">
          Unknown member ({a.memberId})
        </span>
        <Button
          variant="ghost"
          size="sm"
          onclick={() => onAttendeeToggle(a.memberId)}
          data-testid={`${testid}-unknown-remove-${a.memberId}`}
        >
          Remove
        </Button>
      </div>
    {/each}

    <!-- Occasional unnamed guests: a small +/- stepper at the foot. -->
    <div class="flex items-center gap-2 pt-1" data-testid={`${testid}-guests`}>
      <span class="flex-1 text-sm text-muted-foreground">Guests</span>
      <Button
        variant="outline"
        size="sm"
        disabled={day.guests <= 0}
        onclick={() => onGuestsChange(day.guests - 1)}
        aria-label="Fewer guests"
        data-testid={`${testid}-guests-dec`}
      >
        −
      </Button>
      <span class="w-6 text-center text-sm tabular-nums" data-testid={`${testid}-guests-count`}>
        {day.guests}
      </span>
      <Button
        variant="outline"
        size="sm"
        onclick={() => onGuestsChange(day.guests + 1)}
        aria-label="More guests"
        data-testid={`${testid}-guests-inc`}
      >
        +
      </Button>
    </div>

    <p class="text-xs text-muted-foreground">
      {attendingCount}
      {attendingCount === 1 ? 'person' : 'people'} eating
    </p>
  </div>
</div>
