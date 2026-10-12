<script lang="ts">
  import {
    Button,
    Icon,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    TextField,
  } from '@salt/ui-components';
  import type { Freezer, FreezerStock, ShelfStock } from '@salt/domain';
  import { ErrorCode, type DomainError, type ReadResult } from '@salt/shared-types';
  import {
    addFreezer,
    removeFreezer,
    renameFreezer,
    setFreezerShelves,
  } from '../../lib/freezerService.js';

  /**
   * Setting up the freezers (issue #1682): add one by name, rename it, give it its
   * shelves, take a shelf away, remove the freezer.
   *
   * Every change is saved as it is made — there is no Save for the sheet as a
   * whole — and every refusal (a blank or duplicate name, a blank or repeated shelf
   * label) comes from the domain command, shown beside the thing that was refused
   * with nothing saved. The sheet makes no judgement of its own about what is
   * valid, so it cannot disagree with the rules that guard the document.
   *
   * Removing a freezer or a shelf — or relabelling a shelf — is allowed with
   * stock still on it, and asks nothing (issue #1684). The stock is not deleted
   * or rewritten: the freezer page files it under Not placed until someone moves
   * it. The count beside each freezer and shelf is there so you know before you
   * tap; it is information, never a gate.
   */

  interface Props {
    open: boolean;
    /**
     * Every freezer in the setup, in order, with what is on each of its shelves —
     * `itemsByShelf(...).freezers`, so the counts come with the freezers they
     * belong to.
     */
    stock: readonly FreezerStock[];
  }
  let { open = $bindable(), stock }: Props = $props();

  function itemCount(n: number): string {
    return `${n} ${n === 1 ? 'item' : 'items'}`;
  }

  /** The labelled shelves — all of them, in a freezer that has any. */
  function labelled(groups: readonly ShelfStock[]): (ShelfStock & { shelf: string })[] {
    return groups.filter((g): g is ShelfStock & { shelf: string } => g.shelf !== null);
  }

  // What is typed but not yet saved, per freezer id. A rename draft is dropped
  // once it saves, so the field goes back to showing the stored name.
  let nameDrafts = $state<Record<string, string>>({});
  let shelfDrafts = $state<Record<string, string>>({});
  // The last refusal, keyed by freezer id — or NEW for the add-a-freezer form.
  let errors = $state<Record<string, string>>({});
  let newName = $state('');

  const NEW = '__new__';

  function without(record: Record<string, string>, key: string): Record<string, string> {
    return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
  }

  function messageFor(error: DomainError): string {
    if (error.kind === 'ValidationError') {
      switch (error.code) {
        case ErrorCode.INVALID_FREEZER_NAME:
          return 'Give the freezer a name.';
        case ErrorCode.DUPLICATE_FREEZER_NAME:
          return 'There is already a freezer with that name.';
        case ErrorCode.INVALID_SHELF_LABEL:
          return 'Give the shelf a label.';
        case ErrorCode.DUPLICATE_SHELF_LABEL:
          return 'This freezer already has a shelf with that label.';
      }
    }
    if (error.kind === 'NotFound') return 'That freezer has just been removed.';
    return "Couldn't save that. Try again.";
  }

  /** Show the refusal under `key`, or clear it; true when the change saved. */
  function settle(key: string, result: ReadResult<unknown, DomainError>): boolean {
    if (result.kind === 'err') {
      errors = { ...errors, [key]: messageFor(result.error) };
      return false;
    }
    errors = without(errors, key);
    return true;
  }

  async function handleAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (settle(NEW, await addFreezer(newName))) newName = '';
  }

  async function handleRename(event: SubmitEvent, freezer: Freezer): Promise<void> {
    event.preventDefault();
    const draft = nameDrafts[freezer.id];
    if (draft === undefined) return;
    if (settle(freezer.id, await renameFreezer(freezer.id, draft))) {
      nameDrafts = without(nameDrafts, freezer.id);
    }
  }

  async function handleAddShelf(event: SubmitEvent, freezer: Freezer): Promise<void> {
    event.preventDefault();
    const label = shelfDrafts[freezer.id] ?? '';
    if (settle(freezer.id, await setFreezerShelves(freezer.id, [...freezer.shelves, label]))) {
      shelfDrafts = { ...shelfDrafts, [freezer.id]: '' };
    }
  }

  async function handleRemoveShelf(freezer: Freezer, shelf: string): Promise<void> {
    const remaining = freezer.shelves.filter((s) => s !== shelf);
    settle(freezer.id, await setFreezerShelves(freezer.id, remaining));
  }

  async function handleRemoveFreezer(freezer: Freezer): Promise<void> {
    settle(freezer.id, await removeFreezer(freezer.id));
  }

  function renamePending(freezer: Freezer): boolean {
    const draft = nameDrafts[freezer.id];
    return draft !== undefined && draft !== freezer.name;
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Manage freezers</SheetTitle>
      <SheetDescription>Name each freezer and give it its shelves.</SheetDescription>
    </SheetHeader>

    <div class="flex min-h-0 flex-col gap-4 overflow-y-auto">
      {#each stock as { freezer, count, shelves: groups } (freezer.id)}
        <section
          class="flex flex-col gap-3 rounded border border-border p-3"
          data-testid="manage-freezer"
          data-freezer-id={freezer.id}
        >
          <form class="flex items-end gap-2" onsubmit={(e) => void handleRename(e, freezer)}>
            <TextField
              class="min-w-0 flex-1"
              label="Name"
              value={nameDrafts[freezer.id] ?? freezer.name}
              onValueChange={(v) => (nameDrafts = { ...nameDrafts, [freezer.id]: v })}
              data-testid="manage-freezer-name"
            />
            {#if renamePending(freezer)}
              <Button type="submit" size="sm" data-testid="manage-freezer-rename">Rename</Button>
            {/if}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              ariaLabel={`Remove ${freezer.name}`}
              onclick={() => void handleRemoveFreezer(freezer)}
              data-testid="manage-freezer-remove"
            >
              <Icon name="Trash2" size={16} />
            </Button>
          </form>

          <p class="text-xs text-muted-foreground" data-testid="manage-freezer-count">
            {`${itemCount(count)} in this freezer`}
          </p>

          {#if freezer.shelves.length > 0}
            <ul class="flex flex-wrap gap-2" aria-label={`Shelves in ${freezer.name}`}>
              {#each labelled(groups) as { shelf, items: onShelf }, i (i)}
                <li
                  class="flex items-center gap-1 rounded border border-border py-0.5 pl-2"
                  data-testid="manage-shelf"
                >
                  <span class="text-sm">{shelf}</span>
                  {#if onShelf.length > 0}
                    <span class="text-xs text-muted-foreground" data-testid="manage-shelf-count">
                      {`· ${itemCount(onShelf.length)}`}
                    </span>
                  {/if}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    ariaLabel={`Remove shelf ${shelf}`}
                    onclick={() => void handleRemoveShelf(freezer, shelf)}
                    data-testid="manage-shelf-remove"
                  >
                    <Icon name="X" size={14} />
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}

          <form class="flex items-end gap-2" onsubmit={(e) => void handleAddShelf(e, freezer)}>
            <TextField
              class="min-w-0 flex-1"
              aria-label={`New shelf in ${freezer.name}`}
              placeholder="Add a shelf, e.g. A"
              value={shelfDrafts[freezer.id] ?? ''}
              onValueChange={(v) => (shelfDrafts = { ...shelfDrafts, [freezer.id]: v })}
              data-testid="manage-shelf-input"
            />
            <Button type="submit" size="sm" variant="outline" data-testid="manage-shelf-add">
              Add shelf
            </Button>
          </form>

          {#if errors[freezer.id]}
            <p class="text-sm text-destructive" role="alert" data-testid="manage-freezer-error">
              {errors[freezer.id]}
            </p>
          {/if}
        </section>
      {/each}

      <form class="flex flex-col gap-2" onsubmit={(e) => void handleAdd(e)}>
        <div class="flex items-end gap-2">
          <TextField
            class="min-w-0 flex-1"
            label="Add a freezer"
            placeholder="e.g. Garage"
            bind:value={newName}
            data-testid="manage-new-freezer-name"
          />
          <Button type="submit" size="sm" data-testid="manage-new-freezer-add">Add</Button>
        </div>
        {#if errors[NEW]}
          <p class="text-sm text-destructive" role="alert" data-testid="manage-new-freezer-error">
            {errors[NEW]}
          </p>
        {/if}
      </form>
    </div>

    <SheetFooter>
      <Button variant="outline" onclick={() => (open = false)} data-testid="manage-freezers-done">
        Done
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
