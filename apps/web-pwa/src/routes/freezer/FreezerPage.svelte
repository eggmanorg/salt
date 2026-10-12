<script lang="ts">
  import { Button, Chip, ChipGroup, EmptyState, ErrorState, ListPage } from '@salt/ui-components';
  import {
    itemAge,
    itemsByShelf,
    nextFreeNumber,
    oldestFirst,
    type FreezerItem,
  } from '@salt/domain';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import {
    freezerConfigState,
    freezerItemsState,
    initFreezerSync,
  } from '../../lib/freezerService.js';
  import FreezerItemSheet from './FreezerItemSheet.svelte';
  import ManageFreezersSheet from './ManageFreezersSheet.svelte';

  // The freezer (epic #795) — `/freezer`.
  //
  // What is in each freezer and where (issue #1684): every freezer, each of its
  // shelves, and the items on it — or, switched to oldest-first, every item by
  // how long it has been in. Anything whose freezer or shelf has been removed
  // from the setup sits under Not placed at the top until someone moves it.
  // Setting the freezers up is the Manage freezers sheet (issue #1682); adding,
  // editing, moving and removing an item is the item sheet.
  //
  // An ordinary AppShell list page, inside the normal chrome: no `fill`, no
  // selection mode, no entry in fullViewport.ts.

  // Both listeners, for as long as the page is open — page-owned rather than
  // started at boot (see freezerService.ts for what that does and does not keep
  // from a person the flag hides it from).
  $effect(() => initFreezerSync());

  let manageOpen = $state(false);
  let itemOpen = $state(false);
  let editing = $state<FreezerItem | null>(null);
  let view = $state<'shelf' | 'oldest'>('shelf');

  const status = $derived.by(() => {
    const config = $freezerConfigState.status;
    const items = $freezerItemsState.status;
    if (config === 'failed' || items === 'failed') return 'failed';
    if (config === 'loading' || items === 'loading') return 'loading';
    return 'loaded';
  });
  const config = $derived(
    $freezerConfigState.status === 'loaded' ? $freezerConfigState.config : null,
  );
  const freezers = $derived(config?.freezers ?? []);
  const items = $derived($freezerItemsState.status === 'loaded' ? $freezerItemsState.items : []);
  const filed = $derived(
    itemsByShelf(items, config ?? { schemaVersion: 1, updatedAt: '', freezers: [] }),
  );
  // Where each filed item is, by number, for the oldest-first list where the
  // grouping is gone. An item missing from it is under Not placed.
  const places = $derived(
    new Map(
      filed.freezers.flatMap(({ freezer, shelves }) =>
        shelves.flatMap(({ shelf, items: on }) =>
          on.map((i) => [
            i.number,
            shelf === null ? freezer.name : `${freezer.name}, shelf ${shelf}`,
          ]),
        ),
      ),
    ),
  );

  // Read once, when the page opens: ages are whole days, so a page left open
  // across midnight is a day behind until it is opened again — not worth a timer.
  const now = new Date().toISOString();

  function packs(amount: number): string {
    return `${amount} ${amount === 1 ? 'pack' : 'packs'}`;
  }

  function title(item: FreezerItem): string {
    return `#${item.number} ${item.name} — ${packs(item.amount)}`;
  }

  function since(item: FreezerItem): string {
    const day = new Date(item.addedAt).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
    const { days, weeks } = itemAge(item.addedAt, now);
    const age =
      weeks > 0
        ? `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
        : days > 0
          ? `${days} ${days === 1 ? 'day' : 'days'}`
          : 'today';
    return `in since ${day} · ${age}`;
  }

  function meta(item: FreezerItem, showPlace: boolean): string {
    return showPlace ? `${since(item)} · ${places.get(item.number) ?? 'Not placed'}` : since(item);
  }

  function openAdd(): void {
    editing = null;
    itemOpen = true;
  }

  function openEdit(item: FreezerItem): void {
    editing = item;
    itemOpen = true;
  }
</script>

{#snippet row(item: FreezerItem, showPlace: boolean)}
  <li>
    <button
      type="button"
      class="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-muted"
      onclick={() => openEdit(item)}
      data-testid="freezer-item"
      data-number={item.number}
    >
      <span class="text-sm">{title(item)}</span>
      <span class="text-xs text-muted-foreground" data-testid="freezer-item-meta">
        {meta(item, showPlace)}
      </span>
    </button>
  </li>
{/snippet}

<!-- Still being built (epic #795): everyone outside the test group is sent home and
     sees nothing at all — no denial copy (see lib/featureGate.ts). -->
<FeatureGuard feature="freezer">
  <ListPage
    title="Freezer"
    description="What's in each freezer, and where."
    isLoading={status === 'loading'}
    isError={status === 'failed'}
    isEmpty={freezers.length === 0 && items.length === 0}
    class="p-4 sm:p-6"
    data-testid="freezer-page"
  >
    {#snippet actions()}
      {#if freezers.length > 0}
        <Button size="sm" onclick={openAdd} data-testid="freezer-add">Add</Button>
      {/if}
      <Button
        variant="outline"
        size="sm"
        onclick={() => (manageOpen = true)}
        data-testid="freezer-manage"
      >
        Manage freezers
      </Button>
    {/snippet}

    {#snippet error()}
      <ErrorState
        title="Couldn't load the freezers."
        description="Try again in a moment."
        data-testid="freezer-error"
      />
    {/snippet}

    {#snippet empty()}
      <EmptyState
        title="No freezers set up yet."
        description="Name each freezer you have and give it its shelves."
        data-testid="freezer-empty"
      >
        {#snippet actions()}
          <Button onclick={() => (manageOpen = true)} data-testid="freezer-setup">
            Set up a freezer
          </Button>
        {/snippet}
      </EmptyState>
    {/snippet}

    {#snippet children()}
      {#if items.length === 0}
        <p class="mb-3 text-sm text-muted-foreground" data-testid="freezer-contents-empty">
          Nothing in the freezer yet.
        </p>
      {:else}
        <ChipGroup class="mb-3" ariaLabel="Order" data-testid="freezer-view">
          <Chip
            variant="filter"
            pressed={view === 'shelf'}
            onclick={() => (view = 'shelf')}
            data-testid="freezer-view-shelf"
          >
            By shelf
          </Chip>
          <Chip
            variant="filter"
            pressed={view === 'oldest'}
            onclick={() => (view = 'oldest')}
            data-testid="freezer-view-oldest"
          >
            Oldest first
          </Chip>
        </ChipGroup>
      {/if}

      {#if view === 'oldest' && items.length > 0}
        <ul class="flex flex-col gap-1" data-testid="freezer-oldest">
          {#each oldestFirst(items) as item (item.number)}
            {@render row(item, true)}
          {/each}
        </ul>
      {:else}
        <ul class="flex flex-col gap-4" data-testid="freezer-list">
          {#if filed.notPlaced.length > 0}
            <li
              class="rounded border border-dashed border-border bg-card p-3"
              data-testid="freezer-not-placed"
            >
              <h2 class="mb-1 font-medium">Not placed</h2>
              <p class="mb-2 text-xs text-muted-foreground">
                Their freezer or shelf has been removed. Open one to move it.
              </p>
              <ul class="flex flex-col gap-1">
                {#each filed.notPlaced as item (item.number)}
                  {@render row(item, false)}
                {/each}
              </ul>
            </li>
          {/if}
          {#each filed.freezers as stock (stock.freezer.id)}
            <li
              class="rounded border border-border bg-card p-3"
              data-testid="freezer-card"
              data-freezer-id={stock.freezer.id}
            >
              <h2 class="mb-2 font-medium" data-testid="freezer-card-name">
                {stock.freezer.name}
              </h2>
              <ul class="flex flex-col gap-2">
                {#each stock.shelves as shelf, i (i)}
                  <li
                    class="rounded border border-dashed border-border px-3 py-2"
                    data-testid="freezer-shelf"
                  >
                    {#if shelf.shelf !== null}
                      <span class="block text-sm font-medium">{`Shelf ${shelf.shelf}`}</span>
                    {/if}
                    {#if shelf.items.length === 0}
                      <span class="block text-xs text-muted-foreground">Empty</span>
                    {:else}
                      <ul class="flex flex-col gap-1">
                        {#each shelf.items as item (item.number)}
                          {@render row(item, false)}
                        {/each}
                      </ul>
                    {/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
  </ListPage>

  <FreezerItemSheet
    bind:open={itemOpen}
    item={editing}
    {freezers}
    suggestedNumber={nextFreeNumber(items)}
  />
  <ManageFreezersSheet bind:open={manageOpen} stock={filed.freezers} />
</FeatureGuard>
