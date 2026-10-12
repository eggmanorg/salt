<script lang="ts">
  import { Button, EmptyState, ErrorState, ListPage } from '@salt/ui-components';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { freezerConfigState, initFreezerSync } from '../../lib/freezerService.js';
  import ManageFreezersSheet from './ManageFreezersSheet.svelte';

  // The freezer (epic #795, issue #1682) — `/freezer`.
  //
  // The places before anything goes in them: each freezer the household has set
  // up, with its shelves. There is no stock yet — putting things in is #1684 — so
  // every shelf is empty and the page says so.
  //
  // An ordinary AppShell list page, inside the normal chrome: no `fill`, no
  // selection mode, no entry in fullViewport.ts. The one thing to do here is set
  // the freezers up, which happens in the sheet.

  // The config, for as long as the page is open — page-owned rather than started
  // at boot (see freezerService.ts for what that does and does not keep from a
  // person the flag hides it from).
  $effect(() => initFreezerSync());

  let manageOpen = $state(false);

  const status = $derived($freezerConfigState.status);
  const freezers = $derived(
    $freezerConfigState.status === 'loaded' ? ($freezerConfigState.config?.freezers ?? []) : [],
  );
</script>

<!-- Still being built (epic #795): everyone outside the test group is sent home and
     sees nothing at all — no denial copy (see lib/featureGate.ts). -->
<FeatureGuard feature="freezer">
  <ListPage
    title="Freezer"
    description="What's in each freezer, and where."
    isLoading={status === 'loading'}
    isError={status === 'failed'}
    isEmpty={freezers.length === 0}
    class="p-4 sm:p-6"
    data-testid="freezer-page"
  >
    {#snippet actions()}
      {#if freezers.length > 0}
        <Button
          variant="outline"
          size="sm"
          onclick={() => (manageOpen = true)}
          data-testid="freezer-manage"
        >
          Manage freezers
        </Button>
      {/if}
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
      <p class="mb-3 text-sm text-muted-foreground" data-testid="freezer-contents-empty">
        Nothing in the freezer yet.
      </p>
      <ul class="flex flex-col gap-4" data-testid="freezer-list">
        {#each freezers as freezer (freezer.id)}
          <li
            class="rounded border border-border bg-card p-3"
            data-testid="freezer-card"
            data-freezer-id={freezer.id}
          >
            <h2 class="mb-2 font-medium" data-testid="freezer-card-name">{freezer.name}</h2>
            {#if freezer.shelves.length === 0}
              <p class="text-sm text-muted-foreground">No shelves.</p>
            {:else}
              <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {#each freezer.shelves as shelf, i (i)}
                  <li
                    class="rounded border border-dashed border-border px-3 py-2"
                    data-testid="freezer-shelf"
                  >
                    <span class="block text-sm font-medium">Shelf {shelf}</span>
                    <span class="block text-xs text-muted-foreground">Empty</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/snippet}
  </ListPage>

  <ManageFreezersSheet bind:open={manageOpen} {freezers} />
</FeatureGuard>
