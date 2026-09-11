<script lang="ts">
  import {
    Button,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Icon,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    TextField,
    Textarea,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { trackUsageEvent } from '@salt/observability';
  import {
    emptyRecipe,
    insertComponentByElapsedTime,
    isCookable,
    takesComponents,
    type Recipe,
  } from '@salt/domain';
  import { persistRecipe, recipes } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { NEW_ENTRY_COPY, kindOf, type NewEntryMode } from './recipeKind.js';
  import { requestEditOnArrival } from './editOnArrival.js';

  /**
   * The door for the entries that cannot be imported (issue #1319 Phase 6).
   *
   * A recipe arrives by URL, by photo or by chat; nobody has ever typed one into
   * Salt and the editor that let them is being retired. Three things cannot arrive
   * any of those ways, so they get this sheet instead of a page: a "When you CBA"
   * entry (a takeaway, a picnic, a night off), a meal, and a placeholder.
   *
   * A SHEET AND NOT A PAGE, and it asks only for what the entry CANNOT EXIST
   * WITHOUT. Everything else — tags, a source, the timing, the notes — is done on
   * the entry's own page, because since Phases 1-5 that page is where editing
   * happens. So this sheet writes the document and drops you there already editing
   * it (`editOnArrival.ts`), and a second form for the same fields never exists.
   *
   * WHY IT WRITES ON CONFIRM RATHER THAN MINTING UP FRONT: creating a blank
   * document and navigating to it would leave an untitled empty entry in the
   * library every time somebody opened the menu by mistake and backed out. Nothing
   * is written until Create, and Create is disabled until the entry is real.
   *
   * THE FIELD SET IS DERIVED FROM ONE PREDICATE, and its boundary is worth stating
   * (CLAUDE.md Rule 12): `takesComponents(kind)` partitions THESE THREE ENTRIES
   * exactly — only the meal's kind takes dishes, and the other two are nothing but
   * a name and a description, which is what all eight production "When you CBA"
   * entries actually are. That is a property of which three entries the sheet
   * offers, not a law about kinds: add a fourth entry whose kind takes components
   * and it needs its own answer for the description rather than inheriting this
   * one. It is still the capability predicate and never a comparison against
   * `'outing'` (CLAUDE.md -> Data model conventions).
   */
  interface Props {
    mode: NewEntryMode;
    open: boolean;
  }
  let { mode, open = $bindable() }: Props = $props();

  const entry = $derived(NEW_ENTRY_COPY[mode]);

  // Does this entry get a dish picker, and therefore require a dish? One question,
  // asked of the domain. A meal's `kind` is an ordinary `recipe`; what makes it a
  // meal is the dish below, which is why no empty meal can be minted here.
  const takesDishes = $derived(takesComponents(entry.kind));

  let name = $state('');
  let description = $state('');
  let dishIds = $state<string[]>([]);
  let busy = $state(false);

  // The id exists from the moment the sheet opens, not from the moment it writes,
  // because `insertComponentByElapsedTime` needs the meal's own id to refuse a
  // self-reference while dishes are being picked. Nothing is stored under it until
  // Create, so a cancelled sheet simply throws a uuid away.
  let pendingId = $state(crypto.randomUUID());

  // Remount key for the picker input, bumped after each pick so the box clears —
  // `Combobox` syncs its label from `value` at mount only, exactly as
  // `RecipeMadeFromCard`'s picker and the planner's recipe picker both handle it.
  let pickerKey = $state(0);

  // Re-seed on each open. A sheet reopened for a different entry must not still be
  // holding the name somebody typed into the last one and backed out of — and a
  // new entry needs a new id. Same shape as `RecipeAddToPlannerSheet`'s re-seed.
  //
  // `busy` is reset HERE rather than in an `onOpenChange` handler, and on OPEN
  // rather than on close, because a sheet dismissed while its write was in flight
  // is exactly the case a close handler would have to be trusted to catch: swipe,
  // Escape and the overlay all reach `open = false`, but so does the success path,
  // and a component left `busy` shows a permanently loading Create the next time it
  // is opened. Resetting on the way in needs no handler and cannot be bypassed.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      name = '';
      description = '';
      dishIds = [];
      busy = false;
      pendingId = crypto.randomUUID();
      pickerKey += 1;
    }
    wasOpen = open;
  });

  const trimmedName = $derived(name.trim());
  const canCreate = $derived(trimmedName !== '' && (!takesDishes || dishIds.length > 0) && !busy);

  // Candidates: anything not already chosen that is something you actually make.
  // The second is a capability predicate, never a comparison against the kind — an
  // outing has no dish to compose and a placeholder is a photograph and a title.
  //
  // No `canBeComponentOf(pendingId, r.id)` guard, unlike `RecipeMadeFromCard`'s
  // picker, and the reason is the boundary rather than an oversight: `pendingId` is
  // minted in this browser a moment ago and is not written anywhere yet, so it
  // cannot be in `$recipes` and the self-reference that guard exists to refuse is
  // unreachable here. The domain still refuses it inside
  // `insertComponentByElapsedTime`, which is where the rule lives.
  const pickerItems: ComboboxItemType[] = $derived(
    $recipes
      .filter((r) => !dishIds.includes(r.id) && isCookable(kindOf(r)))
      .map((r) => ({ value: r.id, label: r.title })),
  );

  function dishFilter(input: string, item: ComboboxItemType): boolean {
    return item.label.toLowerCase().includes(input.trim().toLowerCase());
  }

  function dishTitle(id: string): string {
    return $recipes.find((r) => r.id === id)?.title ?? 'No longer in the library';
  }

  function addDish(id: string): void {
    pickerKey += 1;
    // Position is domain policy — longest-cooking first, with the self-reference
    // and already-attached guards folded in — so this never computes an index.
    dishIds = insertComponentByElapsedTime(pendingId, dishIds, id, $recipes);
  }

  function removeDish(id: string): void {
    dishIds = dishIds.filter((d) => d !== id);
  }

  // No `if (!canCreate) return` guard, and the boundary is worth stating rather
  // than the guard being quietly dropped (CLAUDE.md Rule 12): `disabled={!canCreate}`
  // on the Create button below is the enforcement, a disabled `<button>` dispatches
  // no click, and that button is this function's only caller. A re-check here would
  // be a branch no test could reach — the same call `RecipeMadeFromCard`'s picker
  // makes about its own empty-id guard. If a second caller is ever added, the check
  // belongs at that call site or back here WITH a test that reaches it.
  async function handleCreate(): Promise<void> {
    busy = true;
    const base = emptyRecipe(pendingId, new Date().toISOString(), entry.kind);
    const next: Recipe = takesDishes
      ? { ...base, title: trimmedName, componentRecipeIds: dishIds }
      : {
          ...base,
          title: trimmedName,
          description: description.trim() === '' ? null : description.trim(),
        };
    const result = await persistRecipe(next);
    busy = false;
    // Rule 10: the failure crosses as a `Failure<DomainError>` and is said out
    // loud. The sheet stays open holding what was typed, because there is nothing
    // else left to hold it — nothing was written.
    if (result.kind !== 'ok') {
      addToast('Could not create that. Please try again.', 'destructive');
      return;
    }
    trackUsageEvent('recipe.created', {
      recipe_id: next.id,
      recipe_kind: entry.kind,
      recipe_method: 'manual',
    });
    open = false;
    // Edit mode on arrival, then the navigation — requested before the push so the
    // page reads it on the same turn it mounts.
    requestEditOnArrival(next.id);
    push(`/recipes/${next.id}`);
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>{entry.sheetTitle}</SheetTitle>
    </SheetHeader>

    <TextField
      label="Name"
      placeholder={entry.namePlaceholder}
      value={name}
      onValueChange={(v) => (name = v)}
      required
      disabled={busy}
      data-testid="recipe-new-name"
    />

    {#if takesDishes}
      <!-- At least one dish, and the Create button below is what enforces it: the
           document IS a meal the instant it is written, so `sectionOf` derives
           Meals from `hasComponents` with no new kind and no empty meal exists to
           be tidied up later (issue #752's objection, honoured). -->
      {#if dishIds.length > 0}
        <ul class="flex flex-col gap-2" data-testid="recipe-new-dish-rows">
          {#each dishIds as id (id)}
            <li
              class="flex items-center gap-2 rounded border border-border px-3 py-2"
              data-testid="recipe-new-dish-row"
              data-recipe-id={id}
            >
              <span class="min-w-0 flex-1 truncate text-sm">{dishTitle(id)}</span>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => removeDish(id)}
                disabled={busy}
                aria-label={`Remove ${dishTitle(id)}`}
                data-testid={`recipe-new-dish-remove-${id}`}
              >
                <Icon name="X" size={16} />
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
      <!-- No reorder here, deliberately: ordering is `insertComponentByElapsedTime`
           (longest-cooking first) and the meal's own page has `ReorderControl` on
           this exact list a tap later, which is where the cook's running order is
           chosen. A second reorder affordance on a create form would be the fourth
           surface rendering it for no new reason. -->
      {#key pickerKey}
        <Combobox
          items={pickerItems}
          value=""
          filterFn={dishFilter}
          restrict
          placeholder="Add a dish…"
          onValueChange={addDish}
        >
          <ComboboxField>
            <ComboboxInput data-testid="recipe-new-dish-picker" />
            <ComboboxTrigger />
          </ComboboxField>
          <ComboboxContent>
            {#snippet children({ filteredItems })}
              {#each filteredItems as item, i (item.value)}
                <ComboboxItem {item} index={i} />
              {/each}
              {#if filteredItems.length === 0}
                <ComboboxEmpty>Nothing found</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
      {/key}
    {:else}
      <Textarea
        label="Description"
        placeholder="A short description (optional)"
        value={description}
        onValueChange={(v) => (description = v)}
        rows={3}
        disabled={busy}
        data-testid="recipe-new-description"
      />
    {/if}

    <SheetFooter class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}>
        Cancel
      </Button>
      <Button
        size="sm"
        onclick={() => void handleCreate()}
        loading={busy}
        disabled={!canCreate}
        data-testid="recipe-new-create"
      >
        Create
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
