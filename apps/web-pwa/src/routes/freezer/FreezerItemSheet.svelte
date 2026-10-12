<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    TextField,
  } from '@salt/ui-components';
  import type { Freezer, FreezerItem } from '@salt/domain';
  import { ErrorCode, type DomainError, type ReadResult } from '@salt/shared-types';
  import { untrack } from 'svelte';
  import {
    addFreezerItem,
    removeFreezerItem,
    updateFreezerItem,
  } from '../../lib/freezerService.js';

  /**
   * Putting something in the freezer, and changing it afterwards (issue #1684).
   *
   * Adding: the number is pre-filled with the next free one and can be typed
   * over (the bag may already be marked); then a name, the freezer and shelf, how
   * many packs, and where it was bought if it was.
   *
   * Editing: the number is shown and fixed — it is the document id and it is
   * written on the bag. The name, the supplier and the place can change; a new
   * place is a move. The pack count is not edited here yet. Remove deletes the
   * entry and frees its number.
   *
   * Every refusal comes from the domain command through the service, as in the
   * Manage freezers sheet, so the sheet makes no judgement of its own.
   */

  interface Props {
    open: boolean;
    /** The item being edited, or `null` to add one. */
    item: FreezerItem | null;
    freezers: readonly Freezer[];
    /** The number an add starts from — the lowest free one. */
    suggestedNumber: number;
  }
  let { open = $bindable(), item, freezers, suggestedNumber }: Props = $props();

  let numberDraft = $state('');
  let name = $state('');
  let freezerId = $state<string | null>(null);
  let shelf = $state<string | null>(null);
  let packs = $state('1');
  let purchasedFrom = $state('');
  let error = $state<string | null>(null);

  // A fresh form each time the sheet opens, from whatever it was opened on.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      error = null;
      if (item) {
        numberDraft = String(item.number);
        name = item.name;
        packs = String(item.amount);
        purchasedFrom = item.purchasedFrom ?? '';
        // An item under Not placed opens with nothing picked: leaving it so keeps
        // it where it is, picking a place files it.
        const home = freezers.find((f) => f.id === item.freezerId);
        freezerId = home?.id ?? null;
        shelf =
          home && item.shelf !== null && home.shelves.includes(item.shelf) ? item.shelf : null;
      } else {
        numberDraft = String(suggestedNumber);
        name = '';
        packs = '1';
        purchasedFrom = '';
        freezerId = freezers[0]?.id ?? null;
        shelf = freezers[0]?.shelves[0] ?? null;
      }
    });
  });

  const chosen = $derived(freezers.find((f) => f.id === freezerId) ?? null);

  function pickFreezer(freezer: Freezer): void {
    if (freezer.id === freezerId) return;
    freezerId = freezer.id;
    shelf = freezer.shelves[0] ?? null;
  }

  function messageFor(err: DomainError): string {
    if (err.kind === 'ValidationError') {
      switch (err.code) {
        case ErrorCode.INVALID_FREEZER_NUMBER:
          return 'The number must be a whole number, 1 or more.';
        case ErrorCode.FREEZER_NUMBER_IN_USE:
          return 'Something in the freezer already has that number.';
        case ErrorCode.INVALID_FREEZER_ITEM_NAME:
          return 'Say what it is.';
        case ErrorCode.INVALID_FREEZER_AMOUNT:
          return 'Say how many packs — a whole number, 1 or more.';
        case ErrorCode.UNKNOWN_FREEZER_PLACE:
          return 'Pick a freezer and a shelf.';
      }
    }
    if (err.kind === 'NotFound') return 'This has just been taken out on another phone.';
    return "Couldn't save that. Try again.";
  }

  function settle(result: ReadResult<unknown, DomainError>): void {
    if (result.kind === 'err') {
      error = messageFor(result.error);
      return;
    }
    open = false;
  }

  /** The field as a number, or NaN — the domain refuses what is not a whole one. */
  function whole(text: string): number {
    return text.trim() === '' ? Number.NaN : Number(text);
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (item) {
      settle(
        await updateFreezerItem(item.number, {
          name,
          purchasedFrom,
          place: freezerId === null ? null : { freezerId, shelf },
        }),
      );
      return;
    }
    settle(
      await addFreezerItem({
        number: whole(numberDraft),
        name,
        freezerId: freezerId ?? '',
        shelf,
        amount: whole(packs),
        purchasedFrom,
      }),
    );
  }

  async function handleRemove(target: FreezerItem): Promise<void> {
    settle(await removeFreezerItem(target.number));
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>{item ? `#${item.number} ${item.name}` : 'Add to the freezer'}</SheetTitle>
      <SheetDescription>
        {item ? 'Change it, move it, or take it off the list.' : 'Write the number on the bag.'}
      </SheetDescription>
    </SheetHeader>

    <form
      id="freezer-item-form"
      class="flex min-h-0 flex-col gap-4 overflow-y-auto"
      onsubmit={(e) => void handleSubmit(e)}
      data-testid="freezer-item-form"
    >
      <TextField
        label="Number"
        inputmode="numeric"
        readonly={item !== null}
        bind:value={numberDraft}
        data-testid="freezer-item-number"
      />
      <TextField
        label="What is it?"
        placeholder="e.g. Pork loin"
        bind:value={name}
        data-testid="freezer-item-name"
      />

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Freezer</span>
        <ChipGroup ariaLabel="Freezer" data-testid="freezer-item-freezers">
          {#each freezers as freezer (freezer.id)}
            <Chip
              variant="filter"
              pressed={freezer.id === freezerId}
              onclick={() => pickFreezer(freezer)}
              data-testid="freezer-item-freezer"
            >
              {freezer.name}
            </Chip>
          {/each}
        </ChipGroup>
      </div>

      {#if chosen && chosen.shelves.length > 0}
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">Shelf</span>
          <ChipGroup ariaLabel="Shelf" data-testid="freezer-item-shelves">
            {#each chosen.shelves as label (label)}
              <Chip
                variant="filter"
                pressed={label === shelf}
                onclick={() => (shelf = label)}
                data-testid="freezer-item-shelf"
              >
                {label}
              </Chip>
            {/each}
          </ChipGroup>
        </div>
      {/if}

      {#if !item}
        <TextField
          label="How many packs?"
          inputmode="numeric"
          bind:value={packs}
          data-testid="freezer-item-packs"
        />
      {/if}

      <TextField
        label="Bought from (optional)"
        placeholder="e.g. Swaledale"
        bind:value={purchasedFrom}
        data-testid="freezer-item-supplier"
      />

      {#if error}
        <p class="text-sm text-destructive" role="alert" data-testid="freezer-item-error">
          {error}
        </p>
      {/if}
    </form>

    <SheetFooter>
      {#if item}
        {@const target = item}
        <Button
          variant="outline"
          onclick={() => void handleRemove(target)}
          data-testid="freezer-item-remove"
        >
          Remove
        </Button>
      {/if}
      <Button type="submit" form="freezer-item-form" data-testid="freezer-item-save">
        {item ? 'Save' : 'Add'}
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
