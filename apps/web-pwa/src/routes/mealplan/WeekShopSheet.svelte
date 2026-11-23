<script lang="ts">
  import {
    Button,
    Checkbox,
    Icon,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { recipeHeroUrl, hasComponents, type Recipe } from '@salt/domain';
  import { formatDayKey } from '../../lib/dateFormat.js';
  import { KIND_COPY, kindOf } from '../recipes/recipeKind.js';

  // ─── Shop the week: which nights? (issue #724, Phase 1) ────────────────────
  //
  // The FIRST of the two sheets this flow raises. It picks the recipes; the
  // review — servings, per-ingredient Add/Check, Buy/Make — stays entirely with
  // `RecipeAddToListSheet`, which the page then drives once per pick. Nothing
  // about the shopping list is decided here: this sheet returns a subset of what
  // it was given and forgets it.
  //
  // Meals change what a ROW is and nothing else (#752, Phase 2): a meal speaks
  // for the dishes of its own night, so they fold under it as one line with one
  // tick. What comes back out is still the flat list of entries it was given, in
  // the order the rows offered them — the review queue is untouched.
  //
  // It takes the entries ready-made rather than reaching for the week itself.
  // WHICH week is a fact about where the deck is snapped to, and that belongs to
  // the page (viewport geometry, never a component's business); which recipes may
  // be shopped for is `takesIngredients`, applied there too. So this component is
  // presentation and selection, and both are testable without a deck.

  // One row: a recipe and the night it is planned for. A recipe attached to two
  // nights is two rows, which is why the date is half of a row's identity.
  interface Entry {
    readonly date: string;
    readonly recipe: Recipe;
  }

  // What a row actually is once meals are in play (#752, Phase 2): a lead entry,
  // plus the entries in the SAME NIGHT that it has adopted because it names them
  // as its components. An ordinary recipe is a group of one, which is why nothing
  // below has a meal branch in it.
  interface Group {
    readonly lead: Entry;
    readonly adopted: readonly Entry[];
  }

  interface Props {
    open: boolean;
    // In day order, already filtered to nights from today onward and to entries
    // that can be shopped for. Empty is a legitimate state — it is what a week
    // entirely in the past looks like — and gets its own copy below.
    entries: readonly Entry[];
    // The picks, in the order they were offered. The page owns closing the sheet:
    // the review queue starts as this returns, and the two must not overlap.
    onConfirm: (picked: readonly Entry[]) => void;
  }
  let { open = $bindable(), entries, onConfirm }: Props = $props();

  // Ticked-by-default is expressed as ABSENCE, not as a seeded map of trues: the
  // record only ever holds the rows that have been unticked, so an entry that
  // arrives while the sheet is open (a Firestore snapshot landing under it)
  // starts ticked like every other, and reopening is a one-line reset.
  //
  // In memory only, and deliberately (Rule 3): which nights are ticked is a fact
  // about this glance at the planner, exactly like which day is open.
  let unticked = $state<Record<string, boolean>>({});

  // A GROUP is ticked, not an entry — one meal, one tick, so a group can never
  // end up half on the list. Keyed on the lead, which is unique within its night
  // for the same reason a row was: the date is half of the identity.
  function keyOf(entry: Entry): string {
    return `${entry.date}::${entry.recipe.id}`;
  }

  function isPicked(group: Group): boolean {
    return !unticked[keyOf(group.lead)];
  }

  // Reset on the open transition, never on close: a sheet that cleared as it left
  // would flash an all-ticked list on the way out.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) unticked = {};
    wasOpen = open;
  });

  // Rows grouped under their night. The entries arrive in day order, so this is a
  // fold rather than a sort — and a night with two recipes keeps both, in the
  // order the day holds them.
  const nights = $derived.by(() => {
    const out: { date: string; entries: Entry[] }[] = [];
    for (const entry of entries) {
      const last = out.at(-1);
      if (last?.date === entry.date) last.entries.push(entry);
      else out.push({ date: entry.date, entries: [entry] });
    }
    return out.map((night) => ({ date: night.date, groups: groupNight(night.entries) }));
  });

  // Fold one night's entries into rows: a meal ADOPTS the entries beside it that
  // it names, and they stop being rows of their own (#752, Phase 2).
  //
  // Adoption is over the WHOLE night, not just what follows the meal: a night can
  // hold the gravy before the roast (add the gravy alone, then add the meal) and
  // the two still belong together. It is one level, like everything else about
  // components — a meal adopts the dishes it names, never their dishes.
  //
  // Three conditions, and each one is an edge case from the issue:
  //   • already claimed → a component named by two meals in the same night
  //     belongs to the FIRST of them, in document order, deterministically;
  //   • a claimer is never claimed → a meal that has already adopted something
  //     stays a row, so nothing it adopted can vanish with it;
  //   • never itself → a self-reference is refused at the source, but a row that
  //     swallowed itself would be worse than inert.
  // Together they make the result a PARTITION: every entry the sheet was handed
  // appears exactly once, as a lead or under exactly one lead.
  function groupNight(nightEntries: readonly Entry[]): Group[] {
    const adoptedBy = new Map<Entry, Entry[]>();
    const claimed = new Set<Entry>();
    for (const lead of nightEntries) {
      if (claimed.has(lead) || !hasComponents(lead.recipe)) continue;
      const names = new Set(lead.recipe.componentRecipeIds);
      const adopted = nightEntries.filter(
        (e) => e !== lead && !claimed.has(e) && !adoptedBy.has(e) && names.has(e.recipe.id),
      );
      if (adopted.length === 0) continue;
      adoptedBy.set(lead, adopted);
      for (const e of adopted) claimed.add(e);
    }
    return nightEntries
      .filter((e) => !claimed.has(e))
      .map((lead) => ({ lead, adopted: adoptedBy.get(lead) ?? [] }));
  }

  // The picks, FLAT and in the order the rows were offered — meal first, then the
  // dishes it adopted. The page drives one review sheet per entry in this list, so
  // the confirm button's count below is a promise about how many sheets follow;
  // flattening here is what keeps that promise true without the queue learning
  // anything about meals.
  const picked = $derived(
    nights.flatMap((night) =>
      night.groups.filter(isPicked).flatMap((group) => [group.lead, ...group.adopted]),
    ),
  );

  // The date, named the way the planner names a day elsewhere. Formatted from the
  // UTC date, like the page's own labels — a `YYYY-MM-DD` key parsed as local time
  // is a day earlier west of Greenwich.
  function nightLabel(date: string): string {
    return formatDayKey(date, { weekday: 'long', day: 'numeric', month: 'short' });
  }
</script>

<!-- `side="bottom"` explicitly: the primitive defaults to 'right', and this is a
     phone-first sheet. The height cap that stops a fortnight of dinners running
     off the bottom of the screen, taking the confirm button with it, now comes
     from that variant (#930) — but the internal scroll is still this component's
     own job, on the list below, because `SheetContent` carries no overflow.
     Same shape as RecipeAddToListSheet, which is the sheet this one hands over
     to. -->
<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Shop the week</SheetTitle>
    </SheetHeader>

    <div class="flex flex-col gap-3 overflow-y-auto" data-testid="shop-week-list">
      {#if nights.length === 0}
        <!-- A week with nothing left is not a failure and not an error: it is
             Sunday night, or a week you have scrolled back to. Say so plainly
             rather than showing an empty list under a dead confirm button. -->
        <!-- Deliberately NOT an `EmptyState` (#930 Phase 9). That primitive is a
           dashed-border PANEL with an `<h3>` title — a page saying "this place
           holds nothing". This is one sentence inside a bottom sheet, with no
           title to head it, nothing to explain and nothing to do next; a
           bordered box around it would read as a second surface inside the
           sheet's own. -->
        <p
          class="px-1 py-6 text-center text-sm text-muted-foreground"
          data-testid="shop-week-empty"
        >
          Nothing left to shop for in this week.
        </p>
      {/if}
      {#each nights as night (night.date)}
        <div class="flex flex-col gap-1.5">
          <p
            class="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            data-testid={`shop-week-night-${night.date}`}
          >
            {nightLabel(night.date)}
          </p>
          {#each night.groups as group (group.lead.recipe.id)}
            {@const entry = group.lead}
            {@const url = recipeHeroUrl(entry.recipe)}
            <div
              class="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-sm"
              data-testid={`shop-week-row-${night.date}-${entry.recipe.id}`}
            >
              <!-- The tick leads the row, as it does on an equipment accessory:
                   a column of boxes down the left edge is what makes "all of
                   these are on, untick the ones you don't want" readable at a
                   glance.
                   `labelledBy` rather than `aria-label`: the primitive spreads
                   unknown attributes onto its WRAPPER, so an `aria-label` here
                   would name a plain <div> and leave the control itself unnamed.
                   The title is already on screen a few pixels away — pointing at
                   it is both the accessible name and the honest one. -->
              <Checkbox
                checked={isPicked(group)}
                onCheckedChange={(v) => (unticked[keyOf(entry)] = v !== true)}
                labelledBy={`shop-week-title-${night.date}-${entry.recipe.id}`}
                data-testid={`shop-week-tick-${night.date}-${entry.recipe.id}`}
              />
              <span class="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                {#if url}
                  <img src={url} alt="" loading="lazy" class="h-full w-full object-cover" />
                {:else}
                  <span
                    class="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-muted/40 text-muted-foreground/60"
                  >
                    <!-- The kind's own pictogram — copy and pictures only, no
                         behaviour hangs off it (a cocktail is offered here like
                         any other entry that takes ingredients). -->
                    <Icon name={KIND_COPY[kindOf(entry.recipe)].thumbIcon} size={18} />
                  </span>
                {/if}
              </span>
              <!-- A meal is ONE line and one tick: its own name, then how many
                   dishes of the night it is speaking for. The adopted dishes are
                   deliberately not rows — the tick above covers all of them, and
                   listing them again would offer a choice the row does not make.
                   The suffix appears only when it says something: a meal whose
                   dishes are planned for a different night is just a recipe here. -->
              <span
                id={`shop-week-title-${night.date}-${entry.recipe.id}`}
                class="min-w-0 flex-1 truncate"
              >
                {entry.recipe.title}{group.adopted.length > 0 ? ` · ${group.adopted.length}` : ''}
              </span>
            </div>
          {/each}
        </div>
      {/each}
    </div>

    <SheetFooter class="flex justify-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        onclick={() => (open = false)}
        data-testid="shop-week-cancel"
      >
        Cancel
      </Button>
      <!-- Naming the count is the promise the flow then keeps: press it and that
           many review sheets follow, one at a time. Nothing ticked is nothing to
           do — the same rule the review sheet's own confirm follows. -->
      <Button
        size="sm"
        onclick={() => onConfirm(picked)}
        disabled={picked.length === 0}
        data-testid="shop-week-confirm"
      >
        Review {picked.length} recipe{picked.length === 1 ? '' : 's'}
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
