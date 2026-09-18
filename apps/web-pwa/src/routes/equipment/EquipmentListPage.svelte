<script lang="ts">
  import {
    Button,
    CanonIcon,
    ListPage,
    SelectableList,
    SelectAllCheckbox,
    Spinner,
    createListSelection,
    type BulkAction,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { undrawnEquipment } from '@salt/domain';
  import type { EquipmentItem } from '@salt/domain';
  import {
    equipment,
    equipmentIcons,
    equipmentIconFor,
    equipmentThumbnailFor,
    equipmentIconVersionFor,
    drawEquipmentIcon,
    isLoadingEquipment,
    removeEquipmentItems,
  } from '../../lib/equipmentService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { createDeferredDelete } from '../../lib/deferredDelete.svelte.js';

  let selectionMode = $state(false);

  const deferredDelete = createDeferredDelete();

  const items = $derived($equipment?.items ?? []);
  const sorted = $derived([...items].sort((a, b) => a.name.localeCompare(b.name)));
  const visibleItems = $derived(deferredDelete.visible(sorted));

  const allIds = $derived(visibleItems.map((i) => i.id));
  const selection = createListSelection({
    getAllIds: () => allIds,
    isSelectionMode: () => selectionMode,
  });

  function handleBulkDelete(): void {
    if (selection.count === 0) return;
    const ids = selection.ids;
    selectionMode = false; // exiting selection mode clears the selection
    deferredDelete.request(ids, async (delIds) => {
      const result = await removeEquipmentItems([...delIds]);
      if (result.kind !== 'ok') addToast('Failed to delete items.', 'destructive');
    });
  }

  // ─── The gap, said out loud (issue #1458, Phase 1) ──────────────────────────
  //
  // A record with no picture rendered as the same pale placeholder tile as one
  // whose art is still generating, so two of production's 22 records sat undrawn
  // for months and nothing on any screen said so. The marker is the statement;
  // `undrawnEquipment` is the predicate, and its header says what "no picture"
  // means now that a record can borrow one.
  const undrawnIds = $derived(new Set(undrawnEquipment(items, $equipmentIcons).map((i) => i.id)));

  // ONE PRESS, AND IT DRAWS FROM THE STORED DESCRIPTION — this is not a second
  // host for the review panel. #1465 settled that there is deliberately only one
  // ("Draw one for it" hands over to the record's page, docs/canon-icons.md), and
  // #877's gate is that a PERSON presses Draw, never that a picture appears on
  // its own. What this row cannot do is show and correct the sentence first; that
  // loop stays on the record's page, and a wrong picture is redrawn there. The
  // button is absent until a description exists, because a draw with no brief is
  // not a request the callable should have to interpret.
  let drawingId = $state<string | null>(null);

  function briefFor(item: EquipmentItem): string {
    return equipmentIconFor($equipmentIcons, item.id)?.subjectBrief.trim() ?? '';
  }

  // No empty-brief and no already-drawing guard of its own, for the reason
  // `EquipmentEntryIconDialog` states: the button is the whole gate. It does not
  // render at all unless `briefFor` returns a sentence, it is `disabled` while any
  // row is drawing — which `Button` enforces by refusing the click, not merely by
  // styling — and this is its only caller. A second caller would need both back.
  async function handleDraw(item: EquipmentItem): Promise<void> {
    const brief = briefFor(item);
    drawingId = item.id;
    const result = await drawEquipmentIcon(item.id, brief);
    drawingId = null;
    if (result.kind === 'ok') {
      addToast('Drew the picture.', 'success');
    } else if (result.error.kind === 'ValidationError') {
      addToast('Drawing is switched off for this environment.', 'destructive');
    } else {
      addToast('Failed to draw the picture.', 'destructive');
    }
  }

  const bulkActions = $derived<BulkAction[]>([
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      variant: 'destructive',
      testId: 'equipment-bulk-delete',
      onSelect: handleBulkDelete,
    },
  ]);
</script>

<ListPage
  title="Equipment"
  description="Your equipment manifest."
  isLoading={$isLoadingEquipment}
  isEmpty={visibleItems.length === 0}
  class="p-4 sm:p-6"
  bind:selectionMode
  selectionCount={selection.count}
  {bulkActions}
>
  {#snippet actions()}
    <Button size="sm" onclick={() => push('/equipment/new')}>Add equipment</Button>
  {/snippet}

  {#snippet selectionBar()}
    <SelectAllCheckbox {selection} />
  {/snippet}

  {#snippet children()}
    <div data-testid="equipment-list">
      <SelectableList
        items={visibleItems}
        {selection}
        getRowCheckboxLabel={(item) => `Select ${item.name}`}
      >
        {#snippet row(item)}
          {@const undrawn = undrawnIds.has(item.id)}
          <div class="flex w-full items-center gap-2">
            <button
              class="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-medium hover:underline"
              onclick={() => push(`/equipment/${item.id}`)}
              data-testid="equipment-list-item"
              data-equipment-id={item.id}
            >
              <!--
              40px, the primary-list-row rung (ui-spec-v04 §14.6.1) and the size
              the asset's `contentMax: 108` framing is tuned for. An item with no picture yet renders the pale
              placeholder tile from the same component, which is what holds the
              text column straight while art is still generating.
            -->
              <CanonIcon
                thumbnail={equipmentThumbnailFor($equipmentIcons, item.id)}
                name={item.name}
                size={40}
                version={equipmentIconVersionFor($equipmentIcons, item.id)}
              />
              <span class="min-w-0 flex-1">
                {item.name}
                {#if undrawn}
                  <!--
                    The same rung as the accessory and rule counters beside it: a
                    fact about the row, not a warning. What it replaces is silence
                    — an empty tile that read as "still generating" whatever the
                    truth was.
                  -->
                  <span class="ml-2 text-xs text-muted-foreground" data-testid="equipment-undrawn">
                    Not drawn yet
                  </span>
                {/if}
                {#if item.accessories.length > 0}
                  <span class="ml-2 text-xs text-muted-foreground">
                    {item.accessories.length} accessor{item.accessories.length === 1 ? 'y' : 'ies'}
                  </span>
                {/if}
                {#if item.rules.length > 0}
                  <span class="ml-2 text-xs text-muted-foreground">
                    {item.rules.length} rule{item.rules.length === 1 ? '' : 's'}
                  </span>
                {/if}
              </span>
            </button>
            {#if undrawn && briefFor(item)}
              <Button
                size="sm"
                variant="outline"
                loading={drawingId === item.id}
                disabled={drawingId !== null}
                ariaLabel={`Draw ${item.name}`}
                onclick={() => handleDraw(item)}
                data-testid="equipment-draw"
                data-equipment-id={item.id}
              >
                Draw
              </Button>
            {/if}
          </div>
        {/snippet}
      </SelectableList>
    </div>
  {/snippet}
</ListPage>

{#if $isLoadingEquipment}
  <div class="flex items-center justify-center py-8">
    <Spinner size={24} />
  </div>
{/if}
