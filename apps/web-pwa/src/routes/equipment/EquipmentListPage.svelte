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
  import { isCanonIconRenderable, undrawnEquipment } from '@salt/domain';
  import type { EquipmentItem } from '@salt/domain';
  import {
    equipment,
    equipmentIcons,
    equipmentIconFor,
    equipmentThumbnailFor,
    equipmentIconVersionFor,
    isLoadingEquipment,
    removeEquipmentItems,
  } from '../../lib/equipmentService.js';
  import { kitchenTools, toolPicture } from '../../lib/kitchenToolService.js';
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

  // ONE PRESS TO THE GATE, NOT AROUND IT (issue #1458 Phase 1; Daniel's ruling
  // on the review of the first cut of this page). #1458 asks for one press from
  // the list, and an earlier version of this button took that literally: it sent
  // the record's STORED description straight to `drawEquipmentIcon`, in place,
  // with nobody having read it. Review found the reachable failure — rename a
  // never-drawn record while its brief re-author is in flight or has failed, the
  // row still offers Draw, and pressing it draws the OLD name's description onto
  // the NEW name's record, then stamps `sourceName = briefSourceName` so
  // `equipmentIconAwaitingApproval` reads false and nothing says the picture is
  // wrong. That press was impossible before this page existed, because the only
  // Draw button in the app sat beside the editable description on the record's
  // own page (#877's gate). Daniel's ruling keeps it there: the friction #1458
  // removes is HUNTING for which record has no picture, never the screen that
  // shows you the wording. So this button does not draw — it is a one-press
  // route TO the gate, the same answer #1465 already gives for a pictureless row
  // noticed on a recipe (`KitPicturePicker.svelte`'s `handleDrawNew`, which hands
  // over to this same route rather than re-hosting the panel). The button is
  // absent until a description exists, because sending someone to an empty panel
  // is not a request worth the press.
  function briefFor(item: EquipmentItem): string {
    return equipmentIconFor($equipmentIcons, item.id)?.subjectBrief.trim() ?? '';
  }

  function handleDraw(item: EquipmentItem): void {
    push(`/equipment/${item.id}`);
  }

  // A borrowed picture is a reference, not a copy (#1465 Phase 3), and until now
  // this page read it only to decide `undrawnEquipment`'s verdict — never to
  // RENDER it. That left a borrower showing the same bare tile a real gap shows,
  // on the one page the "Not drawn yet" marker lives on, which made the marker's
  // own justification ("a row that shows a picture is not missing one") false
  // here. This is the same one-hop reference chase `kitIcons.ts` does for a kit
  // entry, but not a second copy of IT: an equipment item here is already a
  // known record, never a label to resolve, so there is no second answer to
  // "which of your things is this row" (`kitIcons.ts` and `resolveKitEntryItem`
  // are untouched — that identity question does not arise here at all).
  function pictureFor(item: EquipmentItem): {
    thumbnail: string | null;
    version: string | number | undefined;
  } {
    const own = equipmentThumbnailFor($equipmentIcons, item.id);
    if (isCanonIconRenderable(own)) {
      return { thumbnail: own, version: equipmentIconVersionFor($equipmentIcons, item.id) };
    }
    return borrowedPictureFor(item.borrowedPicture);
  }

  function borrowedPictureFor(borrowed: EquipmentItem['borrowedPicture']): {
    thumbnail: string | null;
    version: string | number | undefined;
  } {
    if (!borrowed) return { thumbnail: null, version: undefined };
    if (borrowed.family === 'equipment') {
      const thumbnail = equipmentThumbnailFor($equipmentIcons, borrowed.id);
      if (!isCanonIconRenderable(thumbnail)) return { thumbnail: null, version: undefined };
      return { thumbnail, version: equipmentIconVersionFor($equipmentIcons, borrowed.id) };
    }
    const tool = $kitchenTools.find((t) => t.id === borrowed.id);
    const picture = tool ? toolPicture(tool) : null;
    return { thumbnail: picture?.thumbnail ?? null, version: picture?.version };
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
          {@const picture = pictureFor(item)}
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
              text column straight while art is still generating. `pictureFor`
              resolves a borrowed picture (#1465 Phase 3) so a borrower does not
              render as the same bare tile a real gap does.
            -->
              <CanonIcon
                thumbnail={picture.thumbnail}
                name={item.name}
                size={40}
                version={picture.version}
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
