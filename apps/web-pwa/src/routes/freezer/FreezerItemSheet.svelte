<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    Combobox,
    ComboboxContent,
    ComboboxCreate,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Textarea,
    TextField,
  } from '@salt/ui-components';
  import {
    formatBagNumber,
    supplierSuggestions,
    type Freezer,
    type FreezerItem,
    type PackWeight,
  } from '@salt/domain';
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
   * Adding: the number is pre-filled with the next one up (`nextBagNumber`) and
   * can be typed over (the bag may already be marked); then a description, the
   * freezer and shelf — or "Not yet", for packs labelled in the kitchen before
   * anyone has seen which shelf they fit on — how many packs, how big one pack
   * is (g, ml or a count, issue #1712), where it was bought if it was, and notes.
   * The sheet opens with the description focused, not the number.
   *
   * Editing: the number is shown and fixed — it is the document id and it is
   * written on the bag. The description, the supplier, the pack size, the notes
   * and the place can change; a new place is a move, and a changed pack count
   * corrects the count. An entry saved before pack sizes opens with the size
   * blank, and cannot be saved until one is given. Remove deletes the entry.
   *
   * The links are offered, never required (Phase 2), through the same dropdown
   * the shopping list's add field uses. The description is an ingredient picked
   * from it — which links that ingredient — or words typed freely, which link the
   * ingredient only when they are its name exactly. An entry opened for editing
   * keeps the link it has until its description is changed. The recipe it was
   * made from and the place it was bought are picked the same way; a new place
   * can be typed.
   *
   * Every refusal comes from the domain command through the service, as in the
   * Manage freezers sheet, so the sheet makes no judgement of its own.
   */

  interface Props {
    open: boolean;
    /** The item being edited, or `null` to add one. */
    item: FreezerItem | null;
    freezers: readonly Freezer[];
    /** The number an add starts from — `nextBagNumber`, one past the highest given out. */
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
  let weight = $state('');
  let weightUnit = $state<PackWeight['unit']>('g');
  let purchasedFrom = $state('');
  let notes = $state('');
  let canonId = $state<string | null>(null);
  let recipeId = $state<string | null>(null);
  let error = $state<string | null>(null);
  // What each dropdown shows as the sheet opens. A dropdown shows only what one of
  // its options says, so words typed freely are seeded as an option of their own
  // (as `RecipeKitPanel` does) — otherwise an edit would open with them blank.
  let descriptionSeed = $state('');
  let supplierSeed = $state('');
  let descriptionEl = $state<HTMLDivElement | undefined>(undefined);

  // A fresh form each time the sheet opens, from whatever it was opened on.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      error = null;
      if (item) {
        numberDraft = formatBagNumber(item.number);
        name = item.name;
        packs = String(Math.max(item.amount, 0));
        weight = item.packWeight ? String(item.packWeight.amount) : '';
        weightUnit = item.packWeight?.unit ?? 'g';
        purchasedFrom = item.purchasedFrom ?? '';
        notes = item.notes ?? '';
        canonId = item.canonId;
        recipeId = item.recipeId;
        const linked = item.canonId === null ? undefined : canonById.get(item.canonId);
        descriptionSeed =
          linked !== undefined && sameWords(titleCase(linked.name), item.name)
            ? canonValue(linked.id)
            : item.name;
        supplierSeed = purchasedFrom;
        // An item under Not placed opens with nothing picked: leaving it so keeps
        // it where it is, picking a place files it. That is any item whose stored
        // place no longer fits: its freezer removed, or its shelf gone from it.
        // One with no shelf yet fits, and opens with "Not yet" picked.
        const home = freezers.find((f) => f.id === item.freezerId);
        const fits =
          home !== undefined && (item.shelf === null || home.shelves.includes(item.shelf));
        freezerId = fits ? home.id : null;
        shelf = fits ? item.shelf : null;
      } else {
        numberDraft = formatBagNumber(suggestedNumber);
        name = '';
        packs = '1';
        weight = '';
        weightUnit = 'g';
        purchasedFrom = '';
        notes = '';
        canonId = null;
        recipeId = null;
        descriptionSeed = '';
        supplierSeed = '';
        freezerId = freezers[0]?.id ?? null;
        shelf = freezers[0]?.shelves[0] ?? null;
      }
    });
  });

  const chosen = $derived(freezers.find((f) => f.id === freezerId) ?? null);

  // The description field is the first thing to fill in, so it — not the bag
  // number above it — takes the focus as the sheet opens. Focusing it here, as the
  // sheet's content mounts, beats the dialog's own first-field focus, which skips
  // when something inside already has it.
  $effect(() => {
    const input = descriptionEl?.querySelector('input');
    if (open && input) input.focus({ preventScroll: true });
  });

  // An ingredient's option is told apart from words typed freely by this prefix.
  const CANON = 'canon:';
  function canonValue(id: string): string {
    return `${CANON}${id}`;
  }

  function sameWords(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  // Indexed, not scanned (issue #939): the dropdown calls `filterFn` once per
  // ingredient on every keystroke.
  const canonById = $derived(canonIndex($canonItems));
  const canonByName = $derived(new Map($canonItems.map((c) => [c.name.trim().toLowerCase(), c])));
  const canonOptions = $derived(
    [...$canonItems]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: canonValue(c.id), label: titleCase(c.name) })),
  );
  const descriptionOptions = $derived(
    descriptionSeed === '' || descriptionSeed.startsWith(CANON)
      ? canonOptions
      : [{ value: descriptionSeed, label: descriptionSeed }, ...canonOptions],
  );

  /** By name or by synonym — the test the shopping list's add field makes. */
  function descriptionFilter(input: string, option: { value: string; label: string }): boolean {
    const q = input.trim().toLowerCase();
    if (!q) return true;
    const canon = option.value.startsWith(CANON)
      ? canonById.get(option.value.slice(CANON.length))
      : undefined;
    return (
      option.label.toLowerCase().includes(q) ||
      (canon?.synonyms.some((s) => s.toLowerCase().includes(q)) ?? false)
    );
  }

  /** Words typed freely: the ingredient they name exactly, if any, is the link. */
  function describe(text: string): void {
    name = text;
    canonId = canonByName.get(text.trim().toLowerCase())?.id ?? null;
  }

  function pickDescription(value: string): void {
    const canon = value.startsWith(CANON) ? canonById.get(value.slice(CANON.length)) : undefined;
    if (canon === undefined) {
      describe(value);
      return;
    }
    name = titleCase(canon.name);
    canonId = canon.id;
  }

  const linkedRecipe = $derived(recipeId === null ? null : ($recipesById.get(recipeId) ?? null));
  const recipeOptions = $derived(
    [...$recipes]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((r) => ({ value: r.id, label: r.title })),
  );

  // The remembered places, alphabetical; a place typed in that is not among them
  // yet is seeded as its own option.
  const supplierOptions = $derived.by(() => {
    const places = supplierSuggestions({ suppliers: [...suppliers] }, '');
    const seeded =
      supplierSeed.trim() === '' || places.some((p) => sameWords(p, supplierSeed))
        ? places
        : [supplierSeed, ...places];
    return seeded.map((p) => ({ value: p, label: p }));
  });

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
          return 'Give it a description.';
        case ErrorCode.INVALID_FREEZER_AMOUNT:
          return item
            ? 'Say how many packs — a whole number, 0 or more.'
            : 'Say how many packs — a whole number, 1 or more.';
        case ErrorCode.UNKNOWN_FREEZER_PLACE:
          return 'Pick a freezer.';
        case ErrorCode.INVALID_FREEZER_PACK_WEIGHT:
          return weightUnit === 'count'
            ? 'Say how many are in one pack — a whole number.'
            : 'Say how much one pack weighs.';
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

  /** The field as a number, or NaN when blank — the domain decides what it takes. */
  function numberIn(text: string): number {
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
          packWeight: { amount: numberIn(weight), unit: weightUnit },
          notes,
          place: freezerId === null ? null : { freezerId, shelf },
          ...(recount ? { amount: numberIn(packs) } : {}),
          canonId,
          recipeId,
        }),
      );
      return;
    }
    settle(
      await addFreezerItem({
        number: numberIn(numberDraft),
        name,
        freezerId: freezerId ?? '',
        shelf,
        amount: numberIn(packs),
        packWeight: { amount: numberIn(weight), unit: weightUnit },
        purchasedFrom,
        notes,
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
      <SheetTitle
        >{item ? `#${formatBagNumber(item.number)} ${item.name}` : 'Add to the freezer'}</SheetTitle
      >
      <SheetDescription>
        {item ? 'Change it, move it, or take it off the list.' : 'Write the number on the bag.'}
      </SheetDescription>
    </SheetHeader>

    <form
      id="freezer-item-form"
      class="flex min-h-0 flex-col gap-4 overflow-y-auto salt-focus-gutter"
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
      <div class="flex flex-col gap-1.5">
        <span id="freezer-item-name-label" class="text-sm font-medium">Description</span>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          bind:this={descriptionEl}
          oninput={(e) => describe((e.target as HTMLInputElement).value)}
        >
          <Combobox
            items={descriptionOptions}
            value={descriptionSeed}
            allowCustom={true}
            openOnClick={false}
            filterFn={descriptionFilter}
            onValueChange={pickDescription}
            placeholder="e.g. Pork loin"
          >
            <ComboboxField class="w-full">
              <ComboboxInput
                aria-labelledby="freezer-item-name-label"
                data-testid="freezer-item-name"
              />
            </ComboboxField>
            <ComboboxContent>
              {#snippet children({ filteredItems, showCreate })}
                {#each filteredItems as option, i (option.value)}
                  <ComboboxItem item={option} index={i} />
                {/each}
                {#if showCreate}
                  <ComboboxCreate />
                {/if}
                {#if filteredItems.length === 0 && !showCreate}
                  <ComboboxEmpty>No matches</ComboboxEmpty>
                {/if}
              {/snippet}
            </ComboboxContent>
          </Combobox>
        </div>
      </div>

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
            <Chip
              variant="filter"
              pressed={shelf === null}
              onclick={() => (shelf = null)}
              data-testid="freezer-item-shelf-none"
            >
              Not yet
            </Chip>
          </ChipGroup>
        </div>
      {/if}

      <TextField
        label="How many packs?"
        inputmode="numeric"
        bind:value={packs}
        data-testid="freezer-item-packs"
      />

      <div class="flex items-end gap-2">
        <TextField
          label="Pack size"
          inputmode={weightUnit === 'count' ? 'numeric' : 'decimal'}
          placeholder={weightUnit === 'count' ? 'e.g. 6' : 'e.g. 500'}
          bind:value={weight}
          data-testid="freezer-item-weight"
        />
        <ChipGroup ariaLabel="Pack size unit" data-testid="freezer-item-weight-units">
          {#each ['g', 'ml', 'count'] as const as unit (unit)}
            <Chip
              variant="filter"
              pressed={unit === weightUnit}
              onclick={() => (weightUnit = unit)}
              data-testid="freezer-item-weight-unit"
            >
              {unit}
            </Chip>
          {/each}
        </ChipGroup>
      </div>

      <div class="flex flex-col gap-1.5">
        <span id="freezer-item-recipe-label" class="text-sm font-medium"
          >Made from a recipe (optional)</span
        >
        {#if linkedRecipe}
          <div class="flex items-center gap-2" data-testid="freezer-item-recipe">
            <span class="text-sm">{linkedRecipe.title}</span>
            <Button variant="ghost" size="sm" onclick={() => (recipeId = null)}>Unlink</Button>
          </div>
        {:else}
          <Combobox
            items={recipeOptions}
            value=""
            restrict
            placeholder="Pick a recipe…"
            onValueChange={(id) => (recipeId = id)}
          >
            <ComboboxField class="w-full">
              <ComboboxInput
                aria-labelledby="freezer-item-recipe-label"
                data-testid="freezer-item-recipe-picker"
              />
            </ComboboxField>
            <ComboboxContent>
              {#snippet children({ filteredItems })}
                {#each filteredItems as option, i (option.value)}
                  <ComboboxItem item={option} index={i} />
                {/each}
                {#if filteredItems.length === 0}
                  <ComboboxEmpty>No matches</ComboboxEmpty>
                {/if}
              {/snippet}
            </ComboboxContent>
          </Combobox>
        {/if}
      </div>

      <div class="flex flex-col gap-1.5">
        <span id="freezer-item-supplier-label" class="text-sm font-medium"
          >Bought from (optional)</span
        >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div oninput={(e) => (purchasedFrom = (e.target as HTMLInputElement).value)}>
          <Combobox
            items={supplierOptions}
            value={supplierSeed}
            allowCustom={true}
            placeholder="e.g. Swaledale"
            onValueChange={(place) => (purchasedFrom = place)}
          >
            <ComboboxField class="w-full">
              <ComboboxInput
                aria-labelledby="freezer-item-supplier-label"
                data-testid="freezer-item-supplier"
              />
            </ComboboxField>
            <ComboboxContent>
              {#snippet children({ filteredItems, showCreate })}
                {#each filteredItems as option, i (option.value)}
                  <ComboboxItem item={option} index={i} />
                {/each}
                {#if showCreate}
                  <ComboboxCreate />
                {/if}
              {/snippet}
            </ComboboxContent>
          </Combobox>
        </div>
      </div>

      <Textarea
        label="Notes (optional)"
        placeholder="e.g. Mild — for the children"
        rows={3}
        bind:value={notes}
        data-testid="freezer-item-notes"
      />

      {#if error}
        <p class="text-sm text-destructive" role="alert" data-testid="freezer-item-error">
          {error}
        </p>
      {/if}
    </form>

    <SheetFooter class={item ? 'justify-between' : ''}>
      {#if item}
        {@const target = item}
        <Button
          variant="destructive"
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
