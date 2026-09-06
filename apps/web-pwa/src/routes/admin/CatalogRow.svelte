<script lang="ts">
  import {
    Button,
    CanonIcon,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    DisclosureChevron,
    DisclosureTrigger,
    EditableRow,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Text,
    TextField,
    valueChipVariants,
  } from '@salt/ui-components';
  import type { CanonItem, ProductForm, ShoppingBehavior } from '@salt/domain';
  import type { CanonItemUnit } from '@salt/shared-types';
  import { describePendingCanonChange } from '@salt/domain';
  import { titleCase } from '../../lib/titleCase.js';
  import { canonKey, formKey, type CatalogRecordKey } from './catalogRoute.js';
  import {
    DEFAULT_THRESHOLD_UNIT,
    saveCanonAisle,
    saveCanonShoppingBehavior,
    saveCanonThreshold,
  } from './canonDecisions.js';
  import { reasoningSentence } from './reasoningSentence.js';

  /**
   * One canon item in the catalog, with its product forms underneath (issue #872).
   *
   * The row displays; the editor edits — with ONE exception, which is the whole
   * point of the "Needs review" filter. A row awaiting review opens onto the
   * three decisions the pipeline made, and those are editable in place as value
   * chips (ui-spec-v09 §8.27), because a reviewer correcting an aisle should not
   * have to leave the list of things still to review to do it.
   *
   * The exception is narrow and stays narrow: it is only the three decisions,
   * only inside the review strip, and it writes through the same
   * `canonDecisions` module the editor uses. Everything else about the item —
   * name, synonyms, icon, forms — is still the editor's, beside the list on a
   * wide screen and a full page on a phone.
   */
  let {
    item,
    forms,
    aisleItems,
    pending,
    isFormPending,
    expanded,
    onToggle,
    openKey,
    selectionMode,
    isSelected,
    onToggleSelect,
    onOpen,
    onApprove,
    approveCount,
    onAddForm,
  }: {
    item: CanonItem;
    /** This item's forms, already narrowed to what the current filter shows. */
    forms: readonly ProductForm[];
    /**
     * Every aisle, "No aisle" first — computed once by the page rather than per
     * row, and the same list the record editor's aisle combobox offers.
     */
    aisleItems: { value: string; label: string }[];
    /** Is the ITEM itself awaiting review, with a deferred approve already applied. */
    pending: boolean;
    isFormPending: (form: ProductForm) => boolean;
    expanded: boolean;
    /**
     * `undefined` ⇒ the body is always open and NO disclosure control renders.
     * That is the "Needs review" filter, where every row arrives opened: a
     * trigger that cannot close anything would be a lie (ui-spec-v09 §8.26).
     */
    onToggle?: (() => void) | undefined;
    /** Which record the editor is on, so the open row reads as the active one. */
    openKey: CatalogRecordKey | null;
    selectionMode: boolean;
    isSelected: (key: CatalogRecordKey) => boolean;
    onToggleSelect: (key: CatalogRecordKey) => void;
    onOpen: (key: CatalogRecordKey) => void;
    onApprove: () => void;
    /** How many records "Approve all N" covers — the item plus its pending forms. */
    approveCount: number;
    onAddForm: () => void;
  } = $props();

  const itemKey = $derived(canonKey(item.id));
  const hasBody = $derived(forms.length > 0 || pending);
  const open = $derived(hasBody && (onToggle === undefined || expanded));

  // The most recent pending change (issue #193), plus how many older ones are
  // waiting. Absent on items flagged before this shipped — nothing renders,
  // because "not recorded" is not "nothing changed".
  const changes = $derived((item.pendingChanges ?? []).map(describePendingCanonChange));
  const latest = $derived(changes.length > 0 ? changes[changes.length - 1]! : null);
  const olderCount = $derived(Math.max(changes.length - 1, 0));
  // The words the review was raised over — what the user actually typed.
  const sourceTexts = $derived(changes.map((c) => c.rawInput).filter((t): t is string => !!t));

  // What the pipeline decided — the three things a reviewer checks before
  // approving, EDITABLE where they are read (issue #872). They are value chips
  // (ui-spec-v09 §8.27): the pill is a surface worn by the control that owns the
  // interaction, so each one keeps its own popover, focus and ARIA and none of
  // them claims an `aria-pressed` it has no business having.
  //
  // Every one commits immediately — on change, or on blur for the typed one —
  // through `canonDecisions`, the same module the record editor writes through.
  // No Save button, and blur never discards.
  const behaviorLabel: Record<ShoppingBehavior, string> = {
    stocked: 'Stocked',
    check: 'Check',
    needed: 'Needed',
  };

  // The typed decision needs a draft; the two picked ones read straight off the
  // item. Seeded per item and NOT re-seeded on the store's echo of our own
  // write, which would yank a half-typed second edit out from under the cursor.
  let thresholdDraft = $state('');
  let unitDraft = $state<CanonItemUnit>(DEFAULT_THRESHOLD_UNIT);
  let seededId = $state('');

  $effect(() => {
    if (item.id === seededId) return;
    seededId = item.id;
    thresholdDraft = item.largeQuantityThreshold?.toString() ?? '';
    unitDraft = item.unit ?? DEFAULT_THRESHOLD_UNIT;
  });
</script>

<!-- One line of words, shared by both layouts so they cannot diverge. -->
{#snippet pendingSummary()}
  {#if latest?.kind === 'synonym_added'}
    + synonym “{latest.synonym}”
  {:else if latest?.kind === 'aisle_cleared'}
    <!-- Attributed to the user's own aisle admin, not to the AI. -->
    {#if latest.origin === 'aisle_merge'}
      − aisle cleared by your merge
    {:else}
      − aisle cleared by your delete
    {/if}
  {:else}
    + new item
  {/if}
  {#if olderCount > 0}
    and {olderCount} more
  {/if}
{/snippet}

<!-- The compact row. EditableRow renders BOTH snippets into the DOM and hides one
     with CSS, so each testid carries which copy it is — a shared id would resolve
     twice (the trap CanonListRow documented). -->
{#snippet label(which: 'narrow' | 'wide')}
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <CanonIcon
      thumbnail={item.thumbnail}
      name={item.name}
      size={40}
      version={item.iconRequestedAt ?? item.updatedAt}
    />
    <button
      type="button"
      class="min-w-0 flex-1 text-left"
      onclick={() => onOpen(itemKey)}
      data-testid="catalog-row-name-{which}"
    >
      <span class="block truncate text-sm font-medium">{titleCase(item.name)}</span>
      {#if pending && latest}
        <span class="block truncate text-xs text-review-text">
          {@render pendingSummary()}
        </span>
      {/if}
    </button>
    {#if pending}
      <span
        class="shrink-0 rounded-full bg-review/20 px-2 py-0.5 text-xs font-medium text-review-text"
      >
        Review
      </span>
    {/if}
    {#if onToggle && hasBody}
      <DisclosureTrigger
        expanded={open}
        class="shrink-0 rounded p-1 text-muted-foreground"
        onclick={onToggle}
        aria-label="{open ? 'Hide' : 'Show'} details for {titleCase(item.name)}"
        data-testid="catalog-row-disclosure-{which}"
      >
        <DisclosureChevron {expanded} size={14} />
      </DisclosureTrigger>
    {/if}
  </div>
{/snippet}

<EditableRow
  selected={isSelected(itemKey) || openKey === itemKey}
  shaded={pending}
  onToggleSelect={selectionMode ? () => onToggleSelect(itemKey) : undefined}
>
  {#snippet narrow()}{@render label('narrow')}{/snippet}
  {#snippet wide()}{@render label('wide')}{/snippet}
</EditableRow>

<!-- The reveal — a sibling row rather than something inside the one above, so it
     renders ONCE at every breakpoint however the row itself is laid out. -->
{#if open}
  <li class="flex flex-col gap-2 pl-4" data-testid="catalog-row-body">
    {#if pending}
      <div
        class="flex flex-col gap-1 rounded border border-review/40 bg-review/10 p-3 text-sm text-review-text"
        data-testid="catalog-row-review"
      >
        {#if item.reasoning}
          <p data-testid="catalog-row-reasoning">{reasoningSentence(item.reasoning)}</p>
        {/if}
        {#each sourceTexts as source, i (i)}
          <p class="opacity-80" data-testid="catalog-row-source">from “{source}”</p>
        {/each}
        <!-- The surface sets no width, so each control is sized by its wrapper
             (ui-spec-v09 §8.27.4). ChipGroup is for a row of Chips; this row
             interleaves an amount with its unit, so the page owns the layout. -->
        <div class="flex flex-wrap items-center gap-2" data-testid="catalog-row-decisions">
          <div class="w-40">
            <Combobox
              items={aisleItems}
              value={item.aisleId ?? ''}
              onValueChange={(v) => saveCanonAisle(item, v)}
              placeholder="No aisle"
              restrict
            >
              <ComboboxInput
                class={valueChipVariants()}
                aria-label="Aisle for {titleCase(item.name)}"
                data-testid="catalog-row-aisle"
              />
              <ComboboxContent>
                {#snippet children({ filteredItems })}
                  {#each filteredItems as cbItem, i (cbItem.value)}
                    <ComboboxItem item={cbItem} index={i} />
                  {/each}
                  {#if filteredItems.length === 0}
                    <ComboboxEmpty>No aisles match.</ComboboxEmpty>
                  {/if}
                {/snippet}
              </ComboboxContent>
            </Combobox>
          </div>

          <div class="w-28">
            <Select
              value={item.shoppingBehavior}
              onValueChange={(v) => saveCanonShoppingBehavior(item, v)}
            >
              <SelectTrigger
                class={valueChipVariants()}
                aria-label="How {titleCase(item.name)} is shopped"
                data-testid="catalog-row-behavior"
              >
                {behaviorLabel[item.shoppingBehavior]}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stocked" label="Stocked" />
                <SelectItem value="check" label="Check" />
                <SelectItem value="needed" label="Needed" />
              </SelectContent>
            </Select>
          </div>

          <!-- The third decision is typed, not picked — which is why the value
               chip is a class and not a component (§8.27.5). -->
          <TextField
            class="w-20"
            frameClass={valueChipVariants()}
            inputmode="numeric"
            aria-label="Quantity threshold for {titleCase(item.name)}"
            placeholder="None"
            value={thresholdDraft}
            onValueChange={(v) => (thresholdDraft = v)}
            data-testid="catalog-row-threshold"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveCanonThreshold(item, thresholdDraft, unitDraft);
              } else if (e.key === 'Escape') {
                thresholdDraft = item.largeQuantityThreshold?.toString() ?? '';
              }
            }}
            onblur={() => saveCanonThreshold(item, thresholdDraft, unitDraft)}
          />

          <div class="w-24">
            <Select
              value={unitDraft}
              onValueChange={(v) => {
                unitDraft = v as CanonItemUnit;
                saveCanonThreshold(item, thresholdDraft, unitDraft);
              }}
            >
              <SelectTrigger
                class={valueChipVariants()}
                aria-label="Threshold unit for {titleCase(item.name)}"
                data-testid="catalog-row-threshold-unit"
              >
                {unitDraft}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="g" label="g" />
                <SelectItem value="ml" label="ml" />
                <SelectItem value="count" label="count" />
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    {/if}

    {#if forms.length > 0}
      <ul class="flex flex-col gap-1">
        {#each forms as form (form.id)}
          {@const key = formKey(form.id)}
          {#snippet formLabel(which: 'narrow' | 'wide')}
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <!-- The form's OWN pictogram (issue #871), not its parent's: a form
                   exists precisely when the thing you buy looks different from the
                   parent. Sized 32 against the parent row's 40 so the nesting reads
                   as nesting — the nested-row rung (ui-spec-v04 §14.6.1), which
                   generalises this line; same `version` cache-bust as the canon
                   row above. -->
              <CanonIcon
                thumbnail={form.thumbnail}
                name={form.label}
                size={32}
                version={form.iconRequestedAt ?? form.updatedAt}
              />
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                onclick={() => onOpen(key)}
                data-testid="catalog-form-row-{which}"
              >
                <span class="block truncate text-sm font-medium">{form.label}</span>
                <span class="block truncate text-xs text-muted-foreground">
                  {form.matchers.join(', ')} · {form.yield.amountPerParent}
                  {form.yield.formUnit} per item
                </span>
              </button>
            </div>
          {/snippet}
          <EditableRow
            selected={isSelected(key) || openKey === key}
            shaded={isFormPending(form)}
            onToggleSelect={selectionMode ? () => onToggleSelect(key) : undefined}
          >
            {#snippet narrow()}{@render formLabel('narrow')}{/snippet}
            {#snippet wide()}{@render formLabel('wide')}{/snippet}
          </EditableRow>
        {/each}
      </ul>
    {:else}
      <Text muted>No product forms for this item.</Text>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if approveCount > 0}
        <Button size="sm" onclick={onApprove} data-testid="catalog-row-approve">
          {approveCount > 1 ? `Approve all ${approveCount}` : 'Approve'}
        </Button>
      {/if}
      <Button size="sm" variant="outline" onclick={onAddForm} data-testid="catalog-row-add-form">
        {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
        Add form
      </Button>
    </div>
  </li>
{/if}
