<script lang="ts">
  import { goBack } from '../../lib/nav.js';
  import AdminGuard from '../admin/AdminGuard.svelte';
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    ListPage,
    RadioGroup,
    RadioGroupItem,
    RowSelectCheckbox,
    Select,
    SelectAllCheckbox,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SortableList,
    Textarea,
    createListSelection,
    type BulkAction,
  } from '@salt/ui-components';
  import {
    aisles,
    aisleUsage,
    isLoadingAisles,
    addAisle,
    addAislesBulk,
    renameAisle,
    reorderAisles,
    deleteAisles,
    mergeAisles,
  } from '../../lib/aisleService.js';
  import { canonItems } from '../../lib/canonService.js';
  import type { Aisle } from '@salt/domain';
  import { titleCase } from '../../lib/titleCase.js';
  import { addToast } from '../../lib/toastStore.js';

  // Filter state
  let filterText = $state('');
  let showFilter = $state<'all' | 'in-use' | 'empty'>('all');

  // Selection mode
  let selectionMode = $state(false);

  // Add dialog
  let addOpen = $state(false);
  let addText = $state('');
  let addError = $state('');
  let addBusy = $state(false);

  // Inline rename
  let editingId = $state<string | null>(null);
  let editingName = $state('');
  let editInputEl = $state<HTMLInputElement | undefined>();

  // Delete modal
  let deleteOpen = $state(false);
  let deleteBusy = $state(false);
  let deleteError = $state('');

  // Merge modal
  let mergeOpen = $state(false);
  let mergeBusy = $state(false);
  let mergeError = $state('');
  let mergeTargetId = $state('');
  let mergeChoices = $state(new Map<string, 'move' | 'unassign'>());

  // Derived
  let filteredAisles = $derived(
    $aisles.filter((a) => {
      if (!a.name.toLowerCase().includes(filterText.toLowerCase())) return false;
      const count = $aisleUsage.get(a.id) ?? 0;
      if (showFilter === 'in-use') return count > 0;
      if (showFilter === 'empty') return count === 0;
      return true;
    }),
  );

  const selection = createListSelection({
    getAllIds: () => filteredAisles.map((a) => a.id),
    isSelectionMode: () => selectionMode,
  });

  // Add
  async function handleAdd() {
    const names = addText
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) {
      addError = 'Enter at least one aisle name.';
      return;
    }
    addBusy = true;
    addError = '';
    const result = names.length === 1 ? await addAisle(names[0]!) : await addAislesBulk(names);
    addBusy = false;
    if (result.kind === 'ok') {
      addOpen = false;
      addText = '';
    } else {
      addError =
        result.error.kind === 'ValidationError'
          ? 'Name already exists or is invalid.'
          : 'Failed to save. Try again.';
    }
  }

  function handleAddKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleAdd();
    }
  }

  // Rename
  function startRename(aisle: Aisle) {
    editingId = aisle.id;
    editingName = aisle.name;
  }

  $effect(() => {
    if (editingId && editInputEl) editInputEl.focus();
  });

  async function commitRename(id: string) {
    const trimmed = editingName.trim();
    // Inline edits have no dialog to hold a message, so the two of them use the
    // shared toast — the same failure the Add/Delete/Merge dialogs already word
    // for themselves, which since #931 arrives as a Result instead of a throw.
    if (trimmed) {
      const result = await renameAisle(id, trimmed);
      if (result.kind !== 'ok') addToast('Failed to rename aisle. Try again.', 'destructive');
    }
    editingId = null;
  }

  function handleRenameKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename(id);
    } else if (e.key === 'Escape') {
      editingId = null;
    }
  }

  // Reorder
  async function handleReorder(orderedIds: string[]) {
    const result = await reorderAisles(orderedIds);
    if (result.kind !== 'ok') addToast('Failed to reorder aisles. Try again.', 'destructive');
  }

  // Derived: canon items affected by a bulk delete of all selected aisles
  let deleteAffectedItems = $derived(
    $canonItems.filter((item) => item.aisleId !== null && selection.isSelected(item.aisleId)),
  );

  // Derived: source aisle ids for the merge (all selected except the target)
  let mergeSourceIds = $derived([...selection.selected].filter((id) => id !== mergeTargetId));

  // Derived: canon items that will be affected by the merge (belong to a source aisle)
  let mergeAffectedItems = $derived(
    $canonItems.filter((item) => item.aisleId !== null && mergeSourceIds.includes(item.aisleId)),
  );

  // Reset per-item choices whenever the target (and therefore the source set) changes
  $effect(() => {
    const newChoices = new Map<string, 'move' | 'unassign'>();
    for (const item of mergeAffectedItems) {
      newChoices.set(item.id, 'move');
    }
    mergeChoices = newChoices;
  });

  function openMerge() {
    mergeTargetId = [...selection.selected][0] ?? '';
    mergeOpen = true;
  }

  // Contextual bottom action bar. Merge needs ≥2 aisles; both actions open their
  // existing dialogs (structural ops with disclosure / per-item choices).
  const bulkActions = $derived<BulkAction[]>([
    {
      id: 'merge',
      label: 'Merge',
      icon: 'Merge',
      disabled: selection.count < 2,
      testId: 'bulk-merge-button',
      onSelect: openMerge,
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      variant: 'destructive',
      testId: 'bulk-delete-button',
      onSelect: () => (deleteOpen = true),
    },
  ]);

  async function handleBulkDelete() {
    deleteBusy = true;
    deleteError = '';
    const result = await deleteAisles([...selection.selected]);
    deleteBusy = false;
    if (result.kind === 'ok') {
      selection.clear();
      deleteOpen = false;
    } else {
      deleteError = 'Failed to delete aisles. Try again.';
    }
  }

  async function handleBulkMerge() {
    mergeBusy = true;
    mergeError = '';
    const result = await mergeAisles({
      targetId: mergeTargetId,
      sourceIds: mergeSourceIds,
      perItemChoices: [...mergeChoices.entries()].map(([canonItemId, choice]) => ({
        canonItemId,
        choice,
      })),
    });
    mergeBusy = false;
    if (result.kind === 'ok') {
      selection.clear();
      mergeOpen = false;
    } else {
      mergeError = 'Failed to merge aisles. Try again.';
    }
  }
</script>

<AdminGuard>
  <div class="p-4 sm:p-6">
    <ListPage
      title="Manage Aisles"
      description="Organise and sort your store aisles."
      isLoading={$isLoadingAisles}
      isEmpty={$aisles.length === 0 && !$isLoadingAisles}
      bind:selectionMode
      selectionCount={selection.count}
      {bulkActions}
    >
      {#snippet actions()}
        <Button size="sm" onclick={() => goBack('/admin')}>
          <Icon name="ArrowLeft" size={16} />
          Back
        </Button>
        <Button size="sm" data-testid="aisle-add-button" onclick={() => (addOpen = true)}
          >Add</Button
        >
      {/snippet}
      {#snippet selectionBar()}
        <SelectAllCheckbox {selection} />
      {/snippet}

      {#snippet children()}
        <!-- Filter bar -->
        <div class="mb-4 flex flex-wrap items-end gap-2">
          <div class="flex-1">
            <input
              class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
              placeholder="Filter aisles…"
              type="search"
              bind:value={filterText}
            />
          </div>
          <Select value={showFilter} onValueChange={(v) => (showFilter = v as typeof showFilter)}>
            <SelectTrigger class="w-36">
              {showFilter === 'all' ? 'Show all' : showFilter === 'in-use' ? 'In use' : 'Empty'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Show all</SelectItem>
              <SelectItem value="in-use">In use</SelectItem>
              <SelectItem value="empty">Empty</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Sortable list -->
        <SortableList
          items={filteredAisles}
          getId={(a) => a.id}
          onReorder={handleReorder}
          class="divide-y divide-border rounded border"
        >
          {#snippet row(aisle)}
            <div data-testid={`aisle-row-${aisle.id}`} class="flex items-center gap-2 px-3 py-2">
              {#if selectionMode}
                <span data-testid={`aisle-row-checkbox-${aisle.id}`}>
                  <RowSelectCheckbox
                    {selection}
                    id={aisle.id}
                    labelledBy={`aisle-name-${aisle.id}`}
                  />
                </span>
              {/if}

              <span
                data-testid={`aisle-drag-handle-${aisle.id}`}
                class="cursor-grab text-muted-foreground"
              >
                <Icon name="GripVertical" size={16} />
              </span>

              {#if editingId === aisle.id}
                <input
                  bind:this={editInputEl}
                  class="flex-1 rounded border border-input bg-background px-2 py-0.5 text-sm"
                  bind:value={editingName}
                  onblur={() => commitRename(aisle.id)}
                  onkeydown={(e) => handleRenameKeydown(e, aisle.id)}
                />
              {:else}
                <button
                  id={`aisle-name-${aisle.id}`}
                  class="flex-1 truncate text-left text-sm font-medium hover:underline"
                  onclick={() => startRename(aisle)}
                >
                  {titleCase(aisle.name)}
                </button>
              {/if}

              {#if ($aisleUsage.get(aisle.id) ?? 0) > 0}
                <span class="shrink-0 text-xs text-muted-foreground">
                  {$aisleUsage.get(aisle.id)}
                </span>
              {/if}
            </div>
          {/snippet}
        </SortableList>
      {/snippet}
    </ListPage>
  </div>

  <!-- Add dialog -->
  <Dialog
    bind:open={addOpen}
    onOpenChange={(v) => {
      if (!v) {
        addText = '';
        addError = '';
      }
    }}
  >
    <DialogContent>
      <div data-testid="aisle-add-dialog">
        <DialogHeader>
          <DialogTitle>Add aisles</DialogTitle>
        </DialogHeader>
        <div class="py-2">
          <Textarea
            label="Aisle name(s)"
            description="Enter one per line to add multiple at once."
            placeholder="e.g. Produce&#10;Dairy&#10;Bakery"
            rows={4}
            bind:value={addText}
            onkeydown={handleAddKeydown}
            error={addError}
            data-testid="aisle-add-textarea"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onclick={() => (addOpen = false)} disabled={addBusy}
            >Cancel</Button
          >
          <Button
            data-testid="aisle-add-submit"
            onclick={handleAdd}
            loading={addBusy}
            disabled={addBusy}>Add</Button
          >
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>

  <!-- Bulk delete dialog -->
  <Dialog
    bind:open={deleteOpen}
    onOpenChange={(v) => {
      if (!v) deleteError = '';
    }}
  >
    <DialogContent>
      <div data-testid="bulk-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete aisles</DialogTitle>
          <DialogDescription>
            These items will become unassigned and flagged for review.
          </DialogDescription>
        </DialogHeader>
        {#if deleteAffectedItems.length > 0}
          <ul class="max-h-48 divide-y divide-border overflow-y-auto rounded border py-1">
            {#each deleteAffectedItems as item (item.id)}
              <li class="px-3 py-2 text-sm">{titleCase(item.name)}</li>
            {/each}
          </ul>
        {:else}
          <p class="py-2 text-sm text-muted-foreground">No items reference the selected aisles.</p>
        {/if}
        {#if deleteError}
          <p class="text-sm text-destructive">{deleteError}</p>
        {/if}
        <DialogFooter>
          <Button variant="outline" onclick={() => (deleteOpen = false)} disabled={deleteBusy}>
            Cancel
          </Button>
          <Button
            data-testid="bulk-delete-confirm"
            variant="destructive"
            onclick={handleBulkDelete}
            loading={deleteBusy}
            disabled={deleteBusy}
          >
            Continue
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>

  <!-- Bulk merge dialog -->
  <Dialog
    bind:open={mergeOpen}
    onOpenChange={(v) => {
      if (!v) {
        mergeError = '';
      }
    }}
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Merge aisles</DialogTitle>
        <DialogDescription>
          Choose a target aisle. Items from the other selected aisles will be moved or unassigned.
        </DialogDescription>
      </DialogHeader>
      <div class="space-y-4 py-2">
        <Select value={mergeTargetId} onValueChange={(v: string) => (mergeTargetId = v)}>
          <SelectTrigger>
            {mergeTargetId
              ? titleCase($aisles.find((a) => a.id === mergeTargetId)?.name ?? 'Pick target…')
              : 'Pick target aisle…'}
          </SelectTrigger>
          <SelectContent>
            {#each [...selection.selected] as id (id)}
              {@const a = $aisles.find((a) => a.id === id)}
              {#if a}
                <SelectItem value={a.id}>{titleCase(a.name)}</SelectItem>
              {/if}
            {/each}
          </SelectContent>
        </Select>

        {#if mergeAffectedItems.length > 0}
          <div class="max-h-64 divide-y divide-border overflow-y-auto rounded border">
            {#each mergeAffectedItems as item (item.id)}
              <div class="flex items-center justify-between gap-4 px-3 py-2">
                <span class="min-w-0 flex-1 truncate text-sm">{titleCase(item.name)}</span>
                <RadioGroup
                  label={titleCase(item.name)}
                  value={mergeChoices.get(item.id) ?? 'move'}
                  orientation="horizontal"
                  class="sr-only-label"
                  onValueChange={(v: string) => mergeChoices.set(item.id, v as 'move' | 'unassign')}
                >
                  <RadioGroupItem value="move" label="Move" />
                  <RadioGroupItem value="unassign" label="Unassign" />
                </RadioGroup>
              </div>
            {/each}
          </div>
        {:else if mergeSourceIds.length > 0}
          <p class="text-sm text-muted-foreground">No items reference these aisles.</p>
        {/if}
      </div>
      {#if mergeError}
        <p class="text-sm text-destructive">{mergeError}</p>
      {/if}
      <DialogFooter>
        <Button variant="outline" onclick={() => (mergeOpen = false)} disabled={mergeBusy}>
          Cancel
        </Button>
        <Button
          onclick={handleBulkMerge}
          loading={mergeBusy}
          disabled={mergeBusy || !mergeTargetId || mergeSourceIds.length === 0}
        >
          Merge
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</AdminGuard>
