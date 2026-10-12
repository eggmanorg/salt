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
  import { supplierSuggestions, type Freezer, type FreezerItem } from '@salt/domain';
  import { ErrorCode, type DomainError, type ReadResult } from '@salt/shared-types';
  import { untrack } from 'svelte';
  import { canonIndex } from '../../lib/canonIndex.js';
  import { canonItems } from '../../lib/canonService.js';
  import {
    addFreezerItem,
    removeFreezerItem,
    updateFreezerItem,
  } from '../../lib/freezerService.js';
  import { recipes, recipesById } from '../../lib/recipeService.js';
  import { titleCase } from '../../lib/titleCase.js';

  /**
   * Putting something in the freezer, and changing it afterwards (issue #1684).
   *
   * Adding: the number is pre-filled with the next free one and can be typed
   * over (the bag may already be marked); then a name, the freezer and shelf, how
   * many packs, and where it was bought if it was.
   *
   * Editing: the number is shown and fixed — it is the document id and it is
   * written on the bag. The name, the supplier and the place can change; a new
   * place is a move, and a changed pack count corrects the count. Remove deletes
   * the entry and frees its number.
   *
   * The links are offered, never required (Phase 2): as the name is typed, the
   * ingredients and recipes it matches are offered to link; a linked recipe also
   * offers the ingredients matching its title. As the supplier is typed, the
   * remembered places it matches are offered.
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
    /** The remembered places stock has been bought from. */
    suppliers?: readonly string[];
  }
  let { open = $bindable(), item, freezers, suggestedNumber, suppliers = [] }: Props = $props();

  let numberDraft = $state('');
  let name = $state('');
  let freezerId = $state<string | null>(null);
  let shelf = $state<string | null>(null);
  let packs = $state('1');
  let purchasedFrom = $state('');
  let canonId = $state<string | null>(null);
  let recipeId = $state<string | null>(null);
  let error = $state<string | null>(null);

  // A fresh form each time the sheet opens, from whatever it was opened on.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      error = null;
      if (item) {
        numberDraft = String(item.number);
        name = item.name;
        packs = String(Math.max(item.amount, 0));
        purchasedFrom = item.purchasedFrom ?? '';
        canonId = item.canonId;
        recipeId = item.recipeId;
        // An item under Not placed opens with nothing picked: leaving it so keeps
        // it where it is, picking a place files it. That is any item whose stored
        // place no longer fits: its freezer removed, or its shelf gone from it.
        const home = freezers.find((f) => f.id === item.freezerId);
        const fits =
          home !== undefined &&
          (item.shelf === null ? home.shelves.length === 0 : home.shelves.includes(item.shelf));
        freezerId = fits ? home.id : null;
        shelf = fits ? item.shelf : null;
      } else {
        numberDraft = String(suggestedNumber);
        name = '';
        packs = '1';
        purchasedFrom = '';
        canonId = null;
        recipeId = null;
        freezerId = freezers[0]?.id ?? null;
        shelf = freezers[0]?.shelves[0] ?? null;
      }
    });
  });

  const chosen = $derived(freezers.find((f) => f.id === freezerId) ?? null);

  // How many of each kind of link to offer at once.
  const OFFERS = 4;

  /**
   * The ingredients whose name or a synonym contains `typed` — the same test the
   * shopping list's add field makes (ShoppingListPage.svelte, `filterFn`), so
   * there is one way of matching an ingredient, not two.
   */
  function canonMatching(typed: string): { id: string; label: string }[] {
    const q = typed.trim().toLowerCase();
    if (!q) return [];
    return $canonItems
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) || c.synonyms.some((s) => s.toLowerCase().includes(q)),
      )
      .map((c) => ({ id: c.id, label: titleCase(c.name) }));
  }

  const linkedRecipe = $derived(recipeId === null ? null : ($recipesById.get(recipeId) ?? null));
  const canonById = $derived(canonIndex($canonItems));
  const linkedCanon = $derived(canonId === null ? null : (canonById.get(canonId) ?? null));
  const canonOffers = $derived.by(() => {
    if (canonId !== null) return [];
    const byName = canonMatching(name);
    const byRecipe = linkedRecipe ? canonMatching(linkedRecipe.title) : [];
    const offers = new Map(byRecipe.map((offer) => [offer.id, offer]));
    for (const c of byName) if (!offers.has(c.id)) offers.set(c.id, c);
    return [...offers.values()].slice(0, OFFERS);
  });
  const recipeOffers = $derived.by(() => {
    const q = name.trim().toLowerCase();
    if (recipeId !== null || !q) return [];
    return $recipes.filter((r) => r.title.toLowerCase().includes(q)).slice(0, OFFERS);
  });
  // A place already typed in full is not offered back.
  const supplierOffers = $derived(
    supplierSuggestions({ suppliers: [...suppliers] }, purchasedFrom)
      .filter((s) => s.toLowerCase() !== purchasedFrom.trim().toLowerCase())
      .slice(0, OFFERS),
  );

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
          return item
            ? 'Say how many packs — a whole number, 0 or more.'
            : 'Say how many packs — a whole number, 1 or more.';
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
      // The count is sent only when it was changed. Otherwise the save carries
      // whatever count this phone holds by then, so a take it has seen since the
      // sheet opened survives a rename; one it has not yet seen is overwritten
      // by the whole-document save, as any stale edit is (LWW).
      const recount = packs.trim() !== String(Math.max(item.amount, 0));
      settle(
        await updateFreezerItem(item.number, {
          name,
          purchasedFrom,
          place: freezerId === null ? null : { freezerId, shelf },
          ...(recount ? { amount: whole(packs) } : {}),
          canonId,
          recipeId,
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
        canonId,
        recipeId,
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

      {#if linkedCanon}
        <div class="flex items-center gap-2" data-testid="freezer-item-canon">
          <span class="text-sm">{`Ingredient: ${titleCase(linkedCanon.name)}`}</span>
          <Button variant="ghost" size="sm" onclick={() => (canonId = null)}>Unlink</Button>
        </div>
      {:else if canonOffers.length > 0}
        <ChipGroup ariaLabel="Link an ingredient" data-testid="freezer-item-canon-offers">
          {#each canonOffers as offer (offer.id)}
            <Chip
              variant="filter"
              onclick={() => (canonId = offer.id)}
              data-testid="freezer-item-canon-offer"
            >
              {offer.label}
            </Chip>
          {/each}
        </ChipGroup>
      {/if}

      {#if linkedRecipe}
        <div class="flex items-center gap-2" data-testid="freezer-item-recipe">
          <span class="text-sm">{`Made from: ${linkedRecipe.title}`}</span>
          <Button variant="ghost" size="sm" onclick={() => (recipeId = null)}>Unlink</Button>
        </div>
      {:else if recipeOffers.length > 0}
        <ChipGroup ariaLabel="Made from a recipe" data-testid="freezer-item-recipe-offers">
          {#each recipeOffers as recipe (recipe.id)}
            <Chip
              variant="filter"
              onclick={() => (recipeId = recipe.id)}
              data-testid="freezer-item-recipe-offer"
            >
              {`Made from ${recipe.title}`}
            </Chip>
          {/each}
        </ChipGroup>
      {/if}

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

      <TextField
        label="How many packs?"
        inputmode="numeric"
        bind:value={packs}
        data-testid="freezer-item-packs"
      />

      <TextField
        label="Bought from (optional)"
        placeholder="e.g. Swaledale"
        bind:value={purchasedFrom}
        data-testid="freezer-item-supplier"
      />
      {#if supplierOffers.length > 0}
        <ChipGroup ariaLabel="Places bought from before" data-testid="freezer-item-supplier-offers">
          {#each supplierOffers as place (place)}
            <Chip
              variant="filter"
              onclick={() => (purchasedFrom = place)}
              data-testid="freezer-item-supplier-offer"
            >
              {place}
            </Chip>
          {/each}
        </ChipGroup>
      {/if}

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
