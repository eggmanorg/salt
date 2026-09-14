<script lang="ts">
  import { Button, Chip, ChipGroup, EmptyState, Icon, ListPage } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { addToast } from '../../lib/toastStore.js';
  import { createLibraryPage, initLibrarySync, libraryPages } from '../../lib/libraryService.js';

  // The library (epic #1372, Phase 1) — `/library`.
  //
  // The kitchen facts that are not recipes: which Weck jars are in the cupboard and
  // how much kraut each holds, the Control Freak temperatures proven right here, a
  // sous vide chart lifted off a website.
  //
  // THERE IS NO FOLDER TREE. A page is filed by its tags, so "Fermentation" and
  // "Sous vide" are filters rather than places and a page about fermenting sausage
  // can be both. The tag row and the search box are the whole of the navigation,
  // and both are CLIENT-SIDE over a delivered list of tens of documents — which is
  // why the subscription carries no query and the collection needs no index.
  //
  // An ordinary AppShell list page: no `fill` (nothing here owns its own scrolling
  // — ui-spec-v05 §1.5), no selection mode, no bulk actions. The only write on this
  // screen is minting a page, which immediately leaves for it.

  // The collection, for as long as the surface is open. `undefined` is the
  // not-loaded state; an empty array is loaded-and-nothing-written, which is a
  // different sentence and gets the empty snippet rather than the spinner.
  $effect(() => initLibrarySync());

  let searchText = $state('');
  let activeTags = $state<string[]>([]);
  let creating = $state(false);

  const pages = $derived($libraryPages ?? []);

  // Every tag anybody has used, alphabetical. Re-derived from the pages rather than
  // stored anywhere: a tag exists exactly as long as a page carries it, so there is
  // no vocabulary to curate and nothing to leave behind when the last page drops one.
  const allTags = $derived([...new Set(pages.flatMap((p) => p.tags))].sort());

  const query = $derived(searchText.trim().toLowerCase());

  // Search is over TITLES only, deliberately. A body is a document, and a substring
  // match inside one answers "some page mentions this word" — which is not what a
  // list of titles can then show you. Bodies become searchable when there is
  // something to show for a hit inside one.
  const visible = $derived(
    pages
      .filter((p) => query === '' || p.title.toLowerCase().includes(query))
      // AND across the chosen tags, not OR: chips narrow, which is what a filter row
      // reads as — "Fermentation" plus "Sous vide" means pages that are both.
      .filter((p) => activeTags.every((t) => p.tags.includes(t)))
      // Newest EDITED first. A reference library has no natural order and the thing
      // you touched last is overwhelmingly the thing you want again. Sorted on a
      // copy — `filter` already made one, but saying so here is what keeps this
      // true if a filter above it is ever dropped.
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

  function toggleTag(tag: string): void {
    activeTags = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
  }

  // A new page is minted with a placeholder title and opened straight away, rather
  // than asking for a title in a dialog first. The page's own title is editable in
  // place, so a dialog would be a second way to do a thing this feature already
  // does — and an empty page is the cheapest thing in the library to throw away.
  async function handleCreate(): Promise<void> {
    creating = true;
    const result = await createLibraryPage('Untitled page');
    creating = false;
    if (result.kind === 'err') {
      addToast("Couldn't create that page.", 'destructive');
      return;
    }
    push(`/library/${result.value.id}`);
  }

  // Tag chips are worth a row only once there is something to choose between.
  const showTagFilters = $derived(allTags.length > 1);
</script>

<!-- The library is still being built (issue #831): everyone outside the test group
     is redirected home and sees nothing at all — no denial copy, because a message
     would announce a feature they are not meant to know exists yet. Cosmetic only;
     the boundary is not here (see lib/featureGate.ts). -->
<FeatureGuard feature="library">
  <ListPage
    title="Library"
    description="The kitchen facts that aren't recipes."
    isLoading={$libraryPages === undefined}
    isEmpty={pages.length === 0}
    class="p-4 sm:p-6"
    data-testid="library-list-page"
  >
    {#snippet actions()}
      <Button
        size="sm"
        onclick={() => void handleCreate()}
        loading={creating}
        disabled={creating}
        data-testid="library-new-page"
      >
        New page
      </Button>
    {/snippet}

    {#snippet empty()}
      <EmptyState
        title="Nothing in the library yet."
        description="Jar capacities, proven temperatures, a sous vide chart — anything worth writing down that isn't a recipe."
        data-testid="library-empty"
      />
    {/snippet}

    {#snippet children()}
      {#if showTagFilters}
        <ChipGroup class="mb-3" ariaLabel="Tags" data-testid="library-tag-filters">
          {#each allTags as tag (tag)}
            <Chip
              variant="filter"
              pressed={activeTags.includes(tag)}
              onclick={() => toggleTag(tag)}
              data-testid="library-tag-filter"
              data-tag={tag}
            >
              {tag}
            </Chip>
          {/each}
        </ChipGroup>
      {/if}

      <div class="relative mb-3 min-w-0">
        <Icon
          name="Search"
          size={16}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          class="w-full rounded border border-input bg-background py-2 pl-9 pr-3 text-sm"
          placeholder="Search titles…"
          type="search"
          bind:value={searchText}
          data-testid="library-search-input"
        />
      </div>

      {#if visible.length === 0}
        <!-- Distinct from the template's `empty`, which means the library itself is
             empty. This one means your filters matched nothing, and it says so
             rather than reading as "you have written nothing". -->
        <p class="py-8 text-center text-sm text-muted-foreground" data-testid="library-no-matches">
          No pages match.
        </p>
      {:else}
        <ul class="flex flex-col gap-2" data-testid="library-list">
          {#each visible as page (page.id)}
            <li>
              <!-- The whole card is the target: a page has exactly one thing you can
                   do with it from here, so a separate affordance would be a smaller
                   tap area for no additional choice. -->
              <button
                type="button"
                class="flex w-full flex-col gap-1 rounded border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent"
                onclick={() => push(`/library/${page.id}`)}
                data-testid="library-card"
                data-page-id={page.id}
              >
                <span class="min-w-0 truncate font-medium" data-testid="library-card-title">
                  {page.title}
                </span>
                {#if page.tags.length > 0}
                  <span class="flex flex-wrap gap-1">
                    {#each page.tags as tag (tag)}
                      <Chip variant="tag" data-testid="library-card-tag">{tag}</Chip>
                    {/each}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </ListPage>
</FeatureGuard>
