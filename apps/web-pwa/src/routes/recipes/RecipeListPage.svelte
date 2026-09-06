<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    EmptyState,
    Icon,
    ListPage,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { trackUsageEvent } from '@salt/observability';
  import { recipeHeroUrl, recipeMatchIssueCount, type Recipe } from '@salt/domain';
  import {
    recipes,
    isLoadingRecipes,
    stashImportedDraft,
    takePendingImportUrl,
  } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { currentMember } from '../../lib/membersService.js';
  import { canonItems, isLoadingAisles } from '../../lib/canonService.js';
  import { canonIndex, matchMarkersReady } from '../../lib/canonIndex.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import { phaseMinutes } from './recipeTiming.js';
  import { productForms, isLoadingProductForms } from '../../lib/productFormService.js';
  import {
    KIND_COPY,
    KIND_SECTIONS,
    LIST_SECTIONS,
    PRIMARY_LIST_SECTIONS,
    SECTION_COPY,
    sectionOf,
    sectionTakesIngredients,
    type ListSection,
  } from './recipeKind.js';
  import RecipeImportPhotoDialog from './RecipeImportPhotoDialog.svelte';
  import RecipeImportUrlDialog from './RecipeImportUrlDialog.svelte';

  function ingredientCount(recipe: Recipe): number {
    return recipe.ingredients.reduce((n, g) => n + g.items.length, 0);
  }

  // ─── How long it takes, on the card and in the sort (issue #1122) ────────────
  // The phase sum, and nothing else — one rule shared with the recipe page, the
  // component rows and the cook plan (`recipeTiming.ts`), so a recipe cannot read
  // 45 min here and 2 hr there. Issue #1213 removed the stored-total fallback
  // that used to sit under it; a recipe with no strip now carries no
  // chip, which in practice is only the placeholders and outings that never had
  // one.
  //
  // The chip and the sort go through the SAME function on purpose: a list sorted
  // Quickest by one number and labelled with another is a list that looks broken,
  // and that was the state the three stored fields left it in.
  function cardMinutes(recipe: Recipe): number | null {
    return phaseMinutes(recipe);
  }

  // Untimed recipes sort last, exactly as they did when the sort read one field.
  function quickestMinutes(recipe: Recipe): number {
    return cardMinutes(recipe) ?? Infinity;
  }

  function cardTimeLabel(recipe: Recipe): string | null {
    const phase = cardMinutes(recipe);
    return phase === null ? null : formatMinutes(phase);
  }

  // ─── Silent match problems (the card pip) ────────────────────────────────────
  // A line matched to a canon item since deleted, or measured in ml/g against a
  // thing sold by the count with no product form to bridge it (issue #855). Both
  // read as perfectly matched on the recipe and buy the wrong thing, which is why
  // they get a marker on the LIST: the whole point is knowing which recipe to
  // open. A never-matched line is deliberately NOT counted — see the domain query.
  //
  // Index and gate both come from `lib/canonIndex.ts`, which carries the whole
  // of the reasoning. The gate in particular is shared with RecipeViewPage's row
  // markers, which must answer it identically or the card and the recipe
  // disagree (issue #867).
  const canonById = $derived(canonIndex($canonItems));

  const matchIssuesKnown = $derived(
    matchMarkersReady($isLoadingAisles, $isLoadingProductForms, $canonItems.length),
  );

  function matchIssueCount(recipe: Recipe): number {
    return matchIssuesKnown ? recipeMatchIssueCount(recipe, canonById, $productForms) : 0;
  }

  // The hero rule itself is `recipeHeroUrl` in `@salt/domain` (issue #933). What
  // is local and worth keeping: `imageHidden` is retired (inert, kept for
  // back-compat) and no longer read, mirroring the detail page — a hero shows
  // whenever an image URL exists.

  // ─── Search / sort / filter ───────────────────────────────────────────────────
  // The whole recipes collection is subscribed in memory (recipeService), so all
  // of this is a pure client-side pipeline — no extra Firestore reads or indexes.
  type SortBy = 'title' | 'recent' | 'quickest' | 'fewest';
  const SORT_LABELS: Record<SortBy, string> = {
    title: 'A–Z',
    recent: 'Recently added',
    quickest: 'Quickest',
    fewest: 'Fewest ingredients',
  };

  let searchText = $state('');
  let sortBy = $state<SortBy>('title');
  let activeTags = $state<string[]>([]);

  // ─── Authorship (issue #845) ──────────────────────────────────────────────────
  // Two independent toggles, like tags and unlike the single-select sections: a
  // dish you added AND last edited satisfies both at once. Attribution is audit
  // only — this narrows what you are looking at and gates nothing.
  let addedByMe = $state(false);
  let editedByMe = $state(false);

  // ─── Section ──────────────────────────────────────────────────────────────────
  // Which SECTION of the library you are looking at (issue #637) — deliberately
  // not a filter. It is single-select, it always has exactly one value, and it
  // is never cleared: "Clear filters" drops your search and tags but leaves you
  // exactly where you were standing. The default keeps the page as it was —
  // Recipes, and only recipes.
  //
  // A section is not the same thing as a kind (issue #752): Meals is a shelf for
  // entries that have gained components, whatever kind they are. `sectionOf` owns
  // that mapping — which shelf an entry stands on is an identity question, not a
  // capability one, which is what makes it a sanctioned direct comparison.
  let sectionFilter = $state<ListSection>('recipe');

  const sectionCopy = $derived(SECTION_COPY[sectionFilter]);

  function selectSection(section: ListSection): void {
    if (section === sectionFilter) return;
    sectionFilter = section;
    // Tags are per-section vocabulary: "baking" means nothing among takeaways,
    // and carrying it across would land you on an empty page you did not ask
    // for. The search box is different — a word you typed is still what you are
    // looking for, so it survives the switch.
    //
    // The authorship chips (issue #845) survive it too, and for the same reason
    // the search box does: "mine" is not per-section vocabulary — it means the
    // same thing on every shelf, so dropping it when you walk to the next one
    // would be a surprise rather than a tidy-up.
    activeTags = [];
    showAllTags = false;
  }

  // Popover open state for the "New" and sort menus, plus the two chip-row
  // expanders (sections, tags).
  let newMenuOpen = $state(false);
  let sortMenuOpen = $state(false);
  let showAllTags = $state(false);
  let showAllSections = $state(false);

  // Collapsed, the row offers the primary sections only; the rest sit behind a
  // "+N more" chip in the tag row's idiom. The section you are STANDING in is
  // pinned in regardless — collapsing must never hide the chip that says where
  // you are, and single-select means there is always exactly one to pin.
  const shownSections = $derived.by(() => {
    if (showAllSections) return LIST_SECTIONS;
    const primary = LIST_SECTIONS.filter((s) => PRIMARY_LIST_SECTIONS.includes(s));
    return primary.includes(sectionFilter) ? primary : [...primary, sectionFilter];
  });

  const hiddenSectionCount = $derived(LIST_SECTIONS.length - shownSections.length);

  const query = $derived(searchText.trim().toLowerCase());

  function matchesSearch(r: Recipe): boolean {
    if (query === '') return true;
    return (
      r.title.toLowerCase().includes(query) ||
      r.metadata.tags.some((t) => t.toLowerCase().includes(query))
    );
  }

  // AND-narrowing: a recipe must carry every selected tag ("quick" + "vegetarian").
  function matchesTags(r: Recipe): boolean {
    return activeTags.every((t) => r.metadata.tags.includes(t));
  }

  // What `createdBy` / `lastEditedBy` actually hold: a snapshot of `Member.name`
  // taken at write time, never a uid — so "mine" is a name comparison and needs
  // no resolver. Empty while the roster is still loading, and for a signed-in
  // email that is not on it; the chips are inert in that state rather than
  // matching every unattributed ('') recipe, and the row is not offered at all.
  const myName = $derived($currentMember?.name ?? '');

  // AND-narrowing again, and independently of each other: both chips on means a
  // dish you added and are also the last to have touched.
  function matchesAuthors(r: Recipe): boolean {
    if (myName === '') return true;
    if (addedByMe && r.createdBy !== myName) return false;
    if (editedByMe && r.lastEditedBy !== myName) return false;
    return true;
  }

  // Offered only when the library actually holds more than one name (issue
  // #845). Straight after the backfill every recipe is one person's, and a
  // filter whose only possible answer is "everything" is dead chrome. Counted
  // over the WHOLE library rather than `visible`, or the row would vanish the
  // moment a filter narrowed the grid to a single author — pulling the control
  // out from under the finger that just used it.
  const distinctAuthorCount = $derived.by(() => {
    const names = new Set<string>();
    for (const r of $recipes) {
      if (r.createdBy !== '') names.add(r.createdBy);
      if (r.lastEditedBy !== '') names.add(r.lastEditedBy);
    }
    return names.size;
  });

  const showAuthorFilters = $derived(myName !== '' && distinctAuthorCount > 1);

  // Section first, deliberately: `rankedTags` counts over `visible`, so putting
  // the section ahead of the other predicates re-facets the tag chips to the
  // current section for free — no second pass, no separate per-section index.
  const visible = $derived(
    $recipes
      .filter(
        (r) =>
          sectionOf(r) === sectionFilter && matchesSearch(r) && matchesTags(r) && matchesAuthors(r),
      )
      .sort((a, b) => {
        switch (sortBy) {
          case 'recent':
            return b.createdAt.localeCompare(a.createdAt);
          case 'quickest':
            return quickestMinutes(a) - quickestMinutes(b);
          case 'fewest':
            return ingredientCount(a) - ingredientCount(b);
          case 'title':
          default:
            return a.title.localeCompare(b.title);
        }
      }),
  );

  // The section is NOT part of this. Clearing filters must not teleport you back
  // to Recipes, and "· filtered" must not appear merely because you are looking
  // at When you CBA.
  const hasFilters = $derived(query !== '' || activeTags.length > 0 || addedByMe || editedByMe);

  // Ingredients are a capability, so this asks the domain rather than the kind.
  // Every card in `visible` shares `sectionFilter`, so one answer covers the grid.
  const showIngredientCount = $derived(sectionTakesIngredients(sectionFilter));

  // Tags offered as filter chips: those present on the currently displayed
  // recipes, so the choices narrow as you filter (a faceted drill-down) rather
  // than always listing every tag in the library. Ranked by how often each tag
  // occurs in the current view (most-used first, alpha tie-break) so the most
  // relevant chips lead — the count drives ordering only and is never shown.
  // Active tags are pinned in so they stay deselectable even if the result set
  // momentarily empties.
  const TAG_LIMIT = 10;

  const rankedTags = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const r of visible) {
      for (const t of r.metadata.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const t of activeTags) if (!counts.has(t)) counts.set(t, 0);
    return [...counts.keys()].sort((a, b) => {
      const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return byCount !== 0 ? byCount : a.localeCompare(b);
    });
  });

  // Collapsed by default to the top TAG_LIMIT, expandable via a "+N" chip. Any
  // active tag past the cut is kept visible so it stays deselectable.
  const shownTags = $derived.by(() => {
    if (showAllTags || rankedTags.length <= TAG_LIMIT) return rankedTags;
    const top = rankedTags.slice(0, TAG_LIMIT);
    return [...top, ...activeTags.filter((t) => !top.includes(t))];
  });

  const hiddenTagCount = $derived(rankedTags.length - shownTags.length);

  function toggleTag(tag: string): void {
    activeTags = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
  }

  function clearFilters(): void {
    searchText = '';
    activeTags = [];
    addedByMe = false;
    editedByMe = false;
  }

  // ─── Import from URL ──────────────────────────────────────────────────────────
  // The field, the call and the signed-out recovery all live in
  // RecipeImportUrlDialog (issue #752, Phase 3) — this page owns only the way in
  // and the way out, exactly as it does for photo import below.
  let showImport = $state(false);

  // A URL rescued from an import that died on a signed-out session — see
  // stashPendingImportUrl. Reading it here reopens the sheet with the link
  // already in place, so signing back in costs the user nothing. Stays on THIS
  // page: the stash is single-use module state and the page that owns the way in
  // is the page that drains it. Also the share-target's landing (shareTarget.ts).
  const rescuedUrl = takePendingImportUrl();
  if (rescuedUrl !== null) showImport = true;

  function handleUrlImported(recipe: Recipe): void {
    // The callable already persisted the recipe (issue #616), flagged as not yet
    // reviewed — so this routes into the EXISTING recipe's editor, not
    // /recipes/new. The draft is still stashed so the editor paints immediately
    // instead of waiting for the Firestore listener to deliver a doc the server
    // just wrote. If navigation itself fails, surface it rather than silently
    // closing the form: the recipe exists either way, so the user isn't stranded.
    trackUsageEvent('recipe.created', {
      recipe_id: recipe.id,
      recipe_kind: recipe.kind,
      recipe_method: 'url',
    });
    stashImportedDraft(recipe);
    try {
      push(`/recipes/${recipe.id}/edit`);
      showImport = false;
    } catch {
      addToast('Could not open the editor — please try again.', 'destructive');
    }
  }

  // ─── Import from photo (issue #649) ───────────────────────────────────────────
  // This page owns only the way in and the way out. Capturing, framing, the page
  // strip and the extraction call all live in RecipeImportPhotoDialog; it hands
  // back the persisted draft and we do exactly what the URL path does with one.
  let showPhotoImport = $state(false);

  function handlePhotoImported(recipe: Recipe): void {
    // Same hand-off as the URL path (issue #616): the callable has ALREADY
    // persisted the recipe flagged as not yet reviewed, so this routes into that
    // recipe's editor rather than /recipes/new. The draft is stashed so the
    // editor paints immediately instead of waiting for the Firestore listener.
    trackUsageEvent('recipe.created', {
      recipe_id: recipe.id,
      recipe_kind: recipe.kind,
      recipe_method: 'photo',
    });
    stashImportedDraft(recipe);
    try {
      push(`/recipes/${recipe.id}/edit`);
      showPhotoImport = false;
    } catch {
      addToast('Could not open the editor — please try again.', 'destructive');
    }
  }
</script>

<ListPage
  title="Recipes"
  isLoading={$isLoadingRecipes}
  isEmpty={$recipes.length === 0}
  class="p-4 sm:p-6"
>
  {#snippet actions()}
    <Popover bind:open={newMenuOpen}>
      <PopoverTrigger>
        {#snippet children()}
          <button
            type="button"
            class="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            data-testid="recipe-new-btn"
            aria-label="New recipe"
          >
            <Icon name="Plus" size={16} />
            New
            <Icon name="ChevronDown" size={14} class="opacity-80" />
          </button>
        {/snippet}
      </PopoverTrigger>
      <PopoverContent align="end" class="min-w-48 p-1">
        <PopoverMenuItem
          icon="Link"
          onclick={() => {
            newMenuOpen = false;
            showImport = true;
          }}
          data-testid="recipe-new-import"
        >
          Import URL
        </PopoverMenuItem>
        <PopoverMenuItem
          icon="Camera"
          onclick={() => {
            newMenuOpen = false;
            showPhotoImport = true;
          }}
          data-testid="recipe-new-import-photo"
        >
          Import from photo
        </PopoverMenuItem>
        <PopoverMenuItem
          icon="Sparkles"
          onclick={() => {
            newMenuOpen = false;
            push('/chat');
          }}
          data-testid="recipe-new-chat"
        >
          Chat with AI
        </PopoverMenuItem>
        <PopoverMenuItem
          icon="Pencil"
          onclick={() => {
            newMenuOpen = false;
            push('/recipes/new');
          }}
          data-testid="recipe-new-manual"
        >
          Manual
        </PopoverMenuItem>
        <!-- One entry per non-recipe section (issue #637) — "When you CBA", then
             Cocktails. Derived from KIND_SECTIONS rather than written out per kind
             so a section and its way in can never disagree about which kinds
             exist. `recipe` is sliced off because its entry is the "Manual" button
             above, which routes to the bare /recipes/new an e2e spec pins.
             The kind is set by the route and never again — there is no selector in
             the editor, because an outing does not become a recipe. -->
        {#each KIND_SECTIONS.slice(1) as kind (kind)}
          <PopoverMenuItem
            icon={KIND_COPY[kind].menuIcon}
            onclick={() => {
              newMenuOpen = false;
              push(`/recipes/new/${kind}`);
            }}
            data-testid="recipe-new-{kind}"
          >
            {KIND_COPY[kind].label}
          </PopoverMenuItem>
        {/each}
      </PopoverContent>
    </Popover>
  {/snippet}

  {#snippet empty()}
    <EmptyState title="No recipes yet.">
      {#snippet actions()}
        <!-- The inner wrapper stays: EmptyState's own actions row is
             `flex items-center gap-2` and does not wrap, and three buttons do
             not fit a phone on one line. -->
        <div class="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onclick={() => (showImport = true)}
            data-testid="recipe-import-url-toggle-empty"
          >
            {#snippet leading()}<Icon name="Link" size={16} />{/snippet}
            Import from URL
          </Button>
          <!-- A peer of the URL button, deliberately: an empty library is exactly
             where someone stands holding a cookbook, and offering only a URL box
             there says photo import does not exist. -->
          <Button
            variant="outline"
            size="sm"
            onclick={() => (showPhotoImport = true)}
            data-testid="recipe-import-photo-toggle-empty"
          >
            {#snippet leading()}<Icon name="Camera" size={16} />{/snippet}
            Import from photo
          </Button>
          <Button size="sm" onclick={() => push('/recipes/new')}>Create your first recipe</Button>
        </div>
      {/snippet}
    </EmptyState>
  {/snippet}

  {#snippet children()}
    <!-- Section chips (issues #637, #752). Every section is always offered,
         including an empty one: you have to be able to walk into "When you CBA"
         and SEE that there is nothing there yet, otherwise the only signal that
         the section exists is a New-menu entry — and Meals has no New-menu entry
         at all, so its chip is the only thing that says the shelf is there.
         The same `Chip` the tags and authorship rows use (ui-spec-v09 §8.23),
         adapted to single-select — exactly one is pressed at all times, which is
         a property of what this row's click does, not of the chip (§8.24.2).
         Collapsed to the primary sections by default and expanded by the same
         "+N more" expander the tags use. -->
    <ChipGroup class="mb-3" ariaLabel="Section" data-testid="recipe-kind-filters">
      {#each shownSections as section (section)}
        <Chip
          pressed={section === sectionFilter}
          onclick={() => selectSection(section)}
          data-testid="recipe-kind-filter"
          data-kind={section}
        >
          {SECTION_COPY[section].label}
        </Chip>
      {/each}
      {#if hiddenSectionCount > 0}
        <Chip
          variant="expander"
          onclick={() => (showAllSections = true)}
          data-testid="recipe-kind-show-all"
        >
          +{hiddenSectionCount} more
        </Chip>
      {:else if showAllSections}
        <Chip
          variant="expander"
          onclick={() => (showAllSections = false)}
          data-testid="recipe-kind-show-less"
        >
          Show less
        </Chip>
      {/if}
    </ChipGroup>

    <!-- Search + sort toolbar: search fills the row, sort collapses to an icon -->
    <div class="mb-3 flex items-center gap-2">
      <div class="relative min-w-0 flex-1">
        <Icon
          name="Search"
          size={16}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          class="w-full rounded border border-input bg-background py-2 pl-9 pr-3 text-sm"
          placeholder="Search recipes…"
          type="search"
          bind:value={searchText}
          data-testid="recipe-search-input"
        />
      </div>
      <Popover bind:open={sortMenuOpen}>
        <PopoverTrigger>
          {#snippet children()}
            <button
              type="button"
              class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground transition-colors hover:bg-accent"
              data-testid="recipe-sort-trigger"
              aria-label="Sort recipes"
              title={`Sort: ${SORT_LABELS[sortBy]}`}
            >
              <Icon name="ArrowUpDown" size={16} />
            </button>
          {/snippet}
        </PopoverTrigger>
        <PopoverContent align="end" class="min-w-52 p-1">
          <p class="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sort by
          </p>
          {#each Object.entries(SORT_LABELS) as [value, label] (value)}
            <PopoverMenuItem
              icon="Check"
              iconVisible={sortBy === value}
              onclick={() => {
                sortBy = value as SortBy;
                sortMenuOpen = false;
              }}
              data-testid="recipe-sort-option"
              data-sort={value}
            >
              {label}
            </PopoverMenuItem>
          {/each}
        </PopoverContent>
      </Popover>
    </div>

    <!-- Authorship filter chips (issue #845). The tag row's idiom — two
         independent toggles — sitting ABOVE the tags because these two are a
         fixed pair while the tag vocabulary below them re-facets and can run to
         ten chips plus an expander. Rendered only when the library holds more
         than one name; with one author it could only ever answer "everything". -->
    {#if showAuthorFilters}
      <ChipGroup class="mb-3" ariaLabel="Authorship" data-testid="recipe-author-filters">
        <Chip
          pressed={addedByMe}
          onclick={() => (addedByMe = !addedByMe)}
          data-testid="recipe-author-filter"
          data-author="added"
        >
          Added by me
        </Chip>
        <Chip
          pressed={editedByMe}
          onclick={() => (editedByMe = !editedByMe)}
          data-testid="recipe-author-filter"
          data-author="edited"
        >
          Edited by me
        </Chip>
      </ChipGroup>
    {/if}

    <!-- Tag filter chips — the current view's tags, ranked by usage: top 10 by
         default, expandable via a "+N more" chip. -->
    {#if rankedTags.length > 0}
      <!-- Deliberately unnamed: this row ships today with no `role` and no
           accessible name, unlike the two above it. ui-spec-v09 §8.24.4 records
           that gap and preserves it — naming it here would be an accessibility
           change inside a refactor whose acceptance criterion is that nothing
           changes. -->
      <ChipGroup class="mb-3" data-testid="recipe-tag-filters">
        {#each shownTags as tag (tag)}
          <Chip
            pressed={activeTags.includes(tag)}
            onclick={() => toggleTag(tag)}
            data-testid="recipe-tag-filter"
            data-tag={tag}
          >
            #{tag}
          </Chip>
        {/each}
        {#if hiddenTagCount > 0}
          <Chip
            variant="expander"
            onclick={() => (showAllTags = true)}
            data-testid="recipe-tag-show-all"
          >
            +{hiddenTagCount} more
          </Chip>
        {:else if showAllTags && rankedTags.length > TAG_LIMIT}
          <Chip
            variant="expander"
            onclick={() => (showAllTags = false)}
            data-testid="recipe-tag-show-less"
          >
            Show less
          </Chip>
        {/if}
      </ChipGroup>
    {/if}

    <!-- Result count -->
    <div class="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
      <span data-testid="recipe-result-count">
        {visible.length}
        {visible.length === 1 ? sectionCopy.one : sectionCopy.many}
        {#if hasFilters}<span class="text-muted-foreground/70">· filtered</span>{/if}
      </span>
      {#if hasFilters}
        <button
          type="button"
          class="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          onclick={clearFilters}
          data-testid="recipe-clear-filters"
        >
          <Icon name="X" size={12} /> Clear
        </button>
      {/if}
    </div>

    {#if visible.length === 0 && hasFilters}
      <EmptyState title={sectionCopy.noMatchText} data-testid="recipe-no-matches">
        {#snippet icon()}<Icon name="Search" size={24} />{/snippet}
        {#snippet actions()}
          <Button variant="outline" size="sm" onclick={clearFilters}>Clear filters</Button>
        {/snippet}
      </EmptyState>
    {:else if visible.length === 0}
      <!-- An empty SECTION, not a failed filter — there is nothing to clear, so
           offering a "Clear filters" button here would be a dead end. -->
      <EmptyState title={sectionCopy.emptyText} data-testid="recipe-kind-empty">
        {#snippet icon()}<Icon name={sectionCopy.thumbIcon} size={24} />{/snippet}
      </EmptyState>
    {:else}
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="recipe-list">
        {#each visible as recipe (recipe.id)}
          {@const url = recipeHeroUrl(recipe)}
          {@const count = ingredientCount(recipe)}
          {@const tags = recipe.metadata.tags}
          {@const issues = matchIssueCount(recipe)}
          <li>
            <button
              class="group flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onclick={() => push(`/recipes/${recipe.id}`)}
              data-testid="recipe-list-item"
              data-recipe-id={recipe.id}
            >
              <div class="relative aspect-[3/2] w-full overflow-hidden bg-muted">
                <!--
                  Not-yet-read AI import (issue #616). Marker only — the whole card
                  is already a button, so clearing it happens on the recipe itself.
                  `review` chip, the same role the canon/product-form queues wear.
                -->
                {#if recipe.needs_approval}
                  <span
                    class="absolute left-2 top-2 z-10 rounded-full bg-review/20 px-2 py-0.5 text-xs font-medium text-review-text"
                    data-testid="recipe-unreviewed-badge"
                  >
                    Unreviewed
                  </span>
                {/if}
                <!--
                  Match pip (opposite corner to Unreviewed, so a recipe can carry
                  both without them colliding). Marker only, like that chip: the
                  card is already a button, and the fixing happens on the line
                  itself via the ingredient match sheet.

                  `warning`, not `review` like the chip beside it — a wrong match
                  is a problem, where "unreviewed" is only unread. It grounds on
                  `warning-text` rather than `warning` because the numeral is
                  white: white clears 3.91:1 on `warning` and 7.19:1 on
                  `warning-text`, and a numeral is text (#993).
                -->
                {#if issues > 0}
                  <span
                    class="absolute right-2 top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-warning-text px-1.5 text-xs font-semibold text-white shadow"
                    title={`${issues} ${issues === 1 ? 'ingredient is' : 'ingredients are'} matched to the wrong thing`}
                    data-testid="recipe-match-issue-pip"
                  >
                    {issues}
                    <span class="sr-only">
                      {issues === 1 ? 'ingredient needs' : 'ingredients need'} re-matching
                    </span>
                  </span>
                {/if}
                {#if url}
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
                    class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                    data-testid="recipe-list-thumb"
                  />
                {:else}
                  <div
                    class="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-muted/40 text-muted-foreground/60"
                    data-testid="recipe-list-thumb-fallback"
                  >
                    <Icon name={sectionCopy.thumbIcon} size={32} />
                  </div>
                {/if}
              </div>

              <div class="flex flex-1 flex-col gap-1.5 p-3">
                <h3 class="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                  {recipe.title}
                </h3>

                <div
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                >
                  {#if cardTimeLabel(recipe) !== null}
                    <span class="inline-flex items-center gap-1">
                      <Icon name="Clock" size={12} />
                      {cardTimeLabel(recipe)}
                    </span>
                  {/if}
                  {#if recipe.metadata.servings !== null}
                    <span class="inline-flex items-center gap-1">
                      <Icon name="Users" size={12} />
                      {recipe.metadata.servings}
                    </span>
                  {/if}
                  {#if showIngredientCount}
                    <span class="inline-flex items-center gap-1">
                      <Icon name="Carrot" size={12} />
                      {count}
                    </span>
                  {/if}
                </div>

                {#if tags.length > 0}
                  <div class="mt-0.5 flex flex-wrap items-center gap-1">
                    {#each tags.slice(0, 3) as tag (tag)}
                      <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        #{tag}
                      </span>
                    {/each}
                    {#if tags.length > 3}
                      <span class="text-xs text-muted-foreground/70">+{tags.length - 3}</span>
                    {/if}
                  </div>
                {/if}
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</ListPage>

<!-- Both are reachable from the New menu and from the empty state, so they are
     mounted outside ListPage's snippets — one dialog each, one piece of state
     each, and no second copy of the form for the two entry points to drift. -->
<RecipeImportUrlDialog
  bind:open={showImport}
  initialUrl={rescuedUrl ?? ''}
  onImported={handleUrlImported}
/>
<RecipeImportPhotoDialog bind:open={showPhotoImport} onImported={handlePhotoImported} />
