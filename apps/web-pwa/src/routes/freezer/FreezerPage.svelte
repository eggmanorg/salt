<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    ErrorState,
    ListPage,
  } from '@salt/ui-components';
  import {
    formatBagNumber,
    displayAmount,
    itemAge,
    recipeHeroUrl,
    itemsByShelf,
    emptyFreezerConfig,
    nextBagNumber,
    oldestFirst,
    type FreezerItem,
  } from '@salt/domain';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { formatPackWeight } from '../../lib/quantityDisplay.js';
  import {
    freezerConfigState,
    freezerItemsState,
    initFreezerSync,
    removeFreezerItem,
    takeOneFreezerPack,
  } from '../../lib/freezerService.js';
  import { recipesById } from '../../lib/recipeService.js';
  import FreezerItemSheet from './FreezerItemSheet.svelte';
  import ManageFreezersSheet from './ManageFreezersSheet.svelte';

  // The freezer (epic #795) — `/freezer`.
  //
  // What is in each freezer and where (issue #1684): every freezer, each of its
  // shelves, and the items on it — or, switched to oldest-first, every item by
  // how long it has been in. Anything whose freezer or shelf has been removed
  // from the setup sits under Not placed at the top until someone moves it.
  // Setting the freezers up is the Manage freezers sheet (issue #1682); adding,
  // editing, moving and removing an item is the item sheet. Each row takes one
  // pack out with −1; taking the last one asks whether to remove the entry.
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
  // The item whose last pack was just taken, while the remove question is open.
  let lastOne = $state<FreezerItem | null>(null);
  let confirmOpen = $state(false);
  let takeError = $state<string | null>(null);

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
  // What an absent document means, for the reads below; nothing writes it from here.
  const setup = $derived(config ?? emptyFreezerConfig(''));
  const filed = $derived(itemsByShelf(items, setup));
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
    const shown = displayAmount(amount);
    if (shown === 0) return 'none left';
    return `${shown} ${shown === 1 ? 'pack' : 'packs'}`;
  }

  // "4 × 500 g" when the bag has a weight per pack (issue #1712); one written
  // before weights, or one with none left, reads as the count alone.
  function title(item: FreezerItem): string {
    const shown = displayAmount(item.amount);
    const count =
      item.packWeight && shown > 0
        ? `${shown} × ${formatPackWeight(item.packWeight)}`
        : packs(item.amount);
    return `#${formatBagNumber(item.number)} ${item.name} — ${count}`;
  }

  async function takeOne(item: FreezerItem): Promise<void> {
    const result = await takeOneFreezerPack(item.number);
    if (result.kind === 'err') {
      takeError =
        result.error.kind === 'NotFound'
          ? 'That has just been taken out on another phone.'
          : "Couldn't take that out yet. Try again.";
      return;
    }
    takeError = null;
    if (result.value.last) {
      lastOne = result.value.item;
      confirmOpen = true;
    }
  }

  async function removeLastOne(item: FreezerItem): Promise<void> {
    confirmOpen = false;
    await removeFreezerItem(item.number);
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
  {@const recipe = item.recipeId === null ? undefined : $recipesById.get(item.recipeId)}
  {@const hero = recipe ? recipeHeroUrl(recipe) : null}
  <li class="flex items-center gap-2">
    {#if recipe}
      <a
        href={`#/recipes/${recipe.id}`}
        class="shrink-0"
        aria-label={`Open ${recipe.title}`}
        data-testid="freezer-item-recipe-link"
      >
        {#if hero}
          <img src={hero} alt="" class="h-10 w-10 rounded object-cover" />
        {:else}
          <span class="block h-10 w-10 rounded bg-muted"></span>
        {/if}
      </a>
    {/if}
    <button
      type="button"
      class="salt-focus-ring-inset flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1.5 text-left hover:bg-muted"
      onclick={() => openEdit(item)}
      data-testid="freezer-item"
      data-number={item.number}
    >
      <span class="text-sm">{title(item)}</span>
      <span class="text-xs text-muted-foreground" data-testid="freezer-item-meta">
        {meta(item, showPlace)}
      </span>
    </button>
    <Button
      variant="outline"
      size="sm"
      ariaLabel={`Take one pack of ${item.name}`}
      onclick={() => void takeOne(item)}
      data-testid="freezer-item-take"
    >
      −1
    </Button>
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
      {#if takeError}
        <p class="mb-3 text-sm text-destructive" role="alert" data-testid="freezer-take-error">
          {takeError}
        </p>
      {/if}
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
    suggestedNumber={nextBagNumber(items, setup)}
    suppliers={config?.suppliers ?? []}
  />
  <ManageFreezersSheet
    bind:open={manageOpen}
    stock={filed.freezers}
    suppliers={config?.suppliers ?? []}
  />

  {#if lastOne}
    {@const target = lastOne}
    <Dialog bind:open={confirmOpen}>
      <DialogContent>
        <div class="flex flex-col gap-4" data-testid="freezer-last-one">
          <DialogHeader>
            <DialogTitle>That was the last one</DialogTitle>
            <DialogDescription>
              {`Take #${formatBagNumber(target.number)} ${target.name} off the list?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onclick={() => (confirmOpen = false)}
              data-testid="freezer-last-one-keep"
            >
              Keep it
            </Button>
            <Button
              onclick={() => void removeLastOne(target)}
              data-testid="freezer-last-one-remove"
            >
              Remove
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  {/if}
</FeatureGuard>
