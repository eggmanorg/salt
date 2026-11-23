<!-- spec: ui-spec-v04.md §9 v0.4; ui-spec-v05.md §1 v0.5 (fill) -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import Spinner from '../../primitives/Spinner/Spinner.svelte';
  import EmptyState from '../../primitives/EmptyState/EmptyState.svelte';
  import ErrorState from '../../primitives/ErrorState/ErrorState.svelte';
  import Button from '../../primitives/Button/Button.svelte';
  import Icon from '../../primitives/Icon/Icon.svelte';
  import Sheet from '../../primitives/Sheet/Sheet.svelte';
  import SheetContent from '../../primitives/Sheet/SheetContent.svelte';
  import SheetHeader from '../../primitives/Dialog/DialogHeader.svelte';
  import SheetTitle from '../../primitives/Dialog/DialogTitle.svelte';
  import { LIST_PAGE_CONTEXT } from './ListPage.context.js';
  import type { ListPageProps } from './ListPage.types';

  let {
    title,
    titleSlot,
    description,
    toolbar,
    selectionBar,
    selectionMode = $bindable(false),
    bulkActions,
    selectionCount = 0,
    actions,
    isLoading = false,
    isError = false,
    isEmpty = false,
    loading,
    error,
    empty,
    fill = false,
    children,
    class: className,
    ...restProps
  }: ListPageProps = $props();

  LIST_PAGE_CONTEXT.set({
    get selectionMode() {
      return selectionMode;
    },
    exitSelectionMode: () => {
      selectionMode = false;
    },
  });

  // The contextual bottom action bar takes over the BottomNav area while the user
  // is selecting. It appears only once there is at least one selected item.
  const showActionBar = $derived(
    selectionMode && selectionCount > 0 && !!bulkActions && bulkActions.length > 0,
  );

  // Which picker action's target sheet is open (by action id), or null.
  let openPickerId = $state<string | null>(null);
</script>

<!--
  pb-24 while the action bar is shown reserves space so the last rows aren't
  hidden behind the fixed bar. cn (tailwind-merge) lets it override a caller's
  pb-* / p-* on the bottom edge only.

  `fill` (ui-spec-v05 §1) makes the page occupy the shell's content area rather
  than grow with its content, so a child can own the scrolling. `h-full` resolves
  against AppShell's <main>, which has a definite height; `min-h-0` is what lets
  the content div actually shrink inside the flex column instead of being floored
  at its intrinsic height. Since <main> is overflow-y-auto it then has nothing to
  scroll — no change to AppShell, and no pixel arithmetic anywhere.
-->
<section
  class={cn('flex flex-col gap-4', className, showActionBar && 'pb-24', fill && 'h-full min-h-0')}
  {...restProps}
>
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      {#if titleSlot}
        {@render titleSlot()}
      {:else}
        <h1 class="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      {/if}
      {#if description}
        <p class="text-sm text-muted-foreground">{description}</p>
      {/if}
    </div>
    {#if actions || selectionBar}
      <div class="flex items-center gap-2 shrink-0">
        {#if selectionBar}
          {#if selectionMode}
            <Button variant="outline" size="sm" onclick={() => (selectionMode = false)}>
              Done
            </Button>
          {:else}
            <Button variant="outline" size="sm" onclick={() => (selectionMode = true)}>
              Select
            </Button>
          {/if}
        {/if}
        {#if actions}
          {@render actions()}
        {/if}
      </div>
    {/if}
  </header>

  {#if toolbar}
    <div class="flex flex-wrap items-center gap-2">
      {@render toolbar()}
    </div>
  {/if}

  <div class={cn('min-h-0', fill && 'flex flex-1 flex-col')}>
    {#if isLoading}
      {#if loading}
        {@render loading()}
      {:else}
        <div class="flex items-center justify-center py-12">
          <Spinner size={24} />
        </div>
      {/if}
    {:else if isError}
      {#if error}
        {@render error()}
      {:else}
        <ErrorState />
      {/if}
    {:else if isEmpty}
      {#if empty}
        {@render empty()}
      {:else}
        <EmptyState title="Nothing here yet" />
      {/if}
    {:else}
      {#if selectionMode && selectionBar}
        <div
          class="mb-4 flex items-center justify-between px-3 py-2 rounded border border-border bg-muted/40"
        >
          {@render selectionBar()}
        </div>
      {/if}
      {#if children}
        {@render children()}
      {/if}
    {/if}
  </div>
</section>

<!--
  Contextual bulk-action bar. While selecting, it occupies the bottom slot and
  covers the app's BottomNav (z-30 over the nav's z-10) — Android-style
  contextual action mode, replacing the nav rather than stacking above it.
-->
{#if showActionBar && bulkActions}
  <div
    class="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
    role="toolbar"
    aria-label="Bulk actions"
    data-testid="list-page-bulk-bar"
  >
    <div class="mx-auto flex w-full max-w-lg items-stretch">
      {#each bulkActions as action (action.id)}
        <button
          type="button"
          class={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs transition-colors disabled:opacity-40',
            action.kind !== 'picker' && action.variant === 'destructive'
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground hover:bg-accent',
          )}
          disabled={action.disabled}
          onclick={() => {
            if (action.kind === 'picker') openPickerId = action.id;
            else action.onSelect();
          }}
          data-testid={action.testId ?? 'list-page-bulk-action'}
          data-action-id={action.id}
        >
          <Icon name={action.icon} size={20} />
          {action.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Target-picker sheets (one per picker action, opened by id). -->
  {#each bulkActions as action (action.id)}
    {#if action.kind === 'picker'}
      <Sheet
        side="bottom"
        open={openPickerId === action.id}
        onOpenChange={(v) => {
          if (!v && openPickerId === action.id) openPickerId = null;
        }}
      >
        <SheetContent class="flex flex-col gap-2 p-4 pb-8">
          <SheetHeader>
            <SheetTitle>{action.sheetTitle ?? action.label}</SheetTitle>
          </SheetHeader>
          <div class="flex flex-col">
            {#each action.targets as target (target.id)}
              <button
                type="button"
                class="w-full rounded px-3 py-3 text-left text-sm transition-colors hover:bg-accent disabled:opacity-40"
                disabled={action.disabled}
                onclick={() => {
                  openPickerId = null;
                  action.onPick(target.id);
                }}
                data-testid={action.optionTestId ?? 'list-page-bulk-picker-option'}
                data-target-id={target.id}
              >
                {target.label}
              </button>
            {/each}
          </div>
        </SheetContent>
      </Sheet>
    {/if}
  {/each}
{/if}
