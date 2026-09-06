<script lang="ts">
  import { push } from 'svelte-spa-router';
  import {
    Button,
    CanonIcon,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Spinner,
    Text,
    TextField,
  } from '@salt/ui-components';
  import ImagePromptDialog from '../../components/ImagePromptDialog.svelte';
  import RegenerateIconDialog from '../../components/RegenerateIconDialog.svelte';
  import ImageUploadDialog from '../../components/ImageUploadDialog.svelte';
  import { CANON_ICON_HIDDEN, describePendingCanonChange } from '@salt/domain';
  import type { CanonItem, ProductForm } from '@salt/domain';
  import type { CanonItemUnit } from '@salt/shared-types';
  import {
    canonItems,
    updateCanonItemSynonyms,
    approveCanonItemWithOverrides,
    regenerateCanonIcon,
    hideCanonIcon,
    unhideCanonIcon,
  } from '../../lib/canonService.js';
  import {
    DEFAULT_THRESHOLD_UNIT,
    saveCanonAisle,
    saveCanonShoppingBehavior,
    saveCanonThreshold,
  } from './canonDecisions.js';
  import { aisles } from '../../lib/aisleService.js';
  import {
    productForms,
    editProductForm,
    confirmProductForm,
    regenerateProductFormIcon,
    hideProductFormIcon,
    unhideProductFormIcon,
  } from '../../lib/productFormService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { titleCase } from '../../lib/titleCase.js';
  import type { SavedTick } from '../../lib/savedTick.svelte.js';
  import { reasoningSentence } from './reasoningSentence.js';

  /**
   * The shared catalog record editor (issue #872) — one field stack serving both
   * canon items and product forms, discriminated on record kind.
   *
   * Two things it deliberately does NOT do:
   *
   * 1. It does not render a second copy of the fields for a record awaiting
   *    review. `needs_approval` is review-only and never a gate on use (a pending
   *    canon item already resolves recipes live), so it contributes a context
   *    strip ABOVE the fields and an Approve/Confirm action BELOW them — never a
   *    parallel form. Approving therefore changes nothing on screen except those
   *    two, which is why it also does not navigate away.
   * 2. It does not stage edits. Every field commits on change or blur; Enter is a
   *    convenience and Escape reverts. There is no Save button, so the pending
   *    item's fields write through exactly like an approved one's — Approve just
   *    clears the flag over edits that already landed.
   */
  type RecordEditorRecord =
    { kind: 'canon'; item: CanonItem } | { kind: 'form'; form: ProductForm };

  let { record, saved }: { record: RecordEditorRecord; saved: SavedTick } = $props();

  const canon = $derived(record.kind === 'canon' ? record.item : null);
  const form = $derived(record.kind === 'form' ? record.form : null);
  const needsApproval = $derived(
    record.kind === 'canon' ? record.item.needs_approval : record.form.needs_approval === true,
  );

  // ─── Draft state ────────────────────────────────────────────────────────────
  // Seeded once per record. It must NOT re-seed when the record changes under us:
  // every save round-trips through the live store, and re-seeding on that echo
  // would yank a half-typed second edit out from under the cursor.

  let editingSynonyms = $state('');
  let editingThreshold = $state('');
  let editingUnit = $state<CanonItemUnit>(DEFAULT_THRESHOLD_UNIT);

  let matchersText = $state('');
  let parentCanonId = $state('');
  let amount = $state('');
  let formUnit = $state<CanonItemUnit>('ml');

  let _initedKey = $state('');

  $effect(() => {
    const key = record.kind === 'canon' ? `canon:${record.item.id}` : `form:${record.form.id}`;
    if (key === _initedKey) return;
    _initedKey = key;
    if (record.kind === 'canon') {
      const i = record.item;
      editingSynonyms = i.synonyms.join(', ');
      editingThreshold = i.largeQuantityThreshold?.toString() ?? '';
      editingUnit = i.unit ?? DEFAULT_THRESHOLD_UNIT;
    } else {
      const f = record.form;
      matchersText = f.matchers.join(', ');
      parentCanonId = f.parentCanonId;
      amount = f.yield.amountPerParent.toString();
      formUnit = f.yield.formUnit;
    }
  });

  // ─── Review context ─────────────────────────────────────────────────────────

  // The domain hands back a structured description; this page owns the words
  // (issue #193). Oldest first — the order they happened in.
  const pendingChanges = $derived((canon?.pendingChanges ?? []).map(describePendingCanonChange));

  // A pending form's parent may itself be a freshly-minted, unconfirmed canon
  // item. No stored back-reference — derive it from the subscribed items.
  const parentPending = $derived(
    needsApproval &&
      form !== null &&
      $canonItems.find((c) => c.id === form.parentCanonId)?.needs_approval === true,
  );

  // ─── Canon fields ───────────────────────────────────────────────────────────

  const aisleItems = $derived([
    { value: '', label: 'No aisle' },
    ...$aisles.map((a) => ({ value: a.id, label: titleCase(a.name) })),
  ]);

  let aisleBusy = $state(false);
  let synonymsBusy = $state(false);
  let synonymsError = $state('');
  let thresholdBusy = $state(false);
  let behaviorBusy = $state(false);

  // The three decisions commit through `canonDecisions` — the same module the
  // catalog's review row writes through, so the no-op guards cannot drift.
  async function saveAisle(value: string): Promise<void> {
    const item = canon;
    if (!item) return;
    const result = await saveCanonAisle(item, value, { onBusy: (b) => (aisleBusy = b) });
    if (result === 'saved') saved.flash();
  }

  async function saveSynonyms(): Promise<void> {
    const item = canon;
    if (!item) return;
    const synonyms = editingSynonyms
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      synonyms.length === item.synonyms.length &&
      synonyms.every((s, i) => s === item.synonyms[i])
    )
      return;
    synonymsBusy = true;
    synonymsError = '';
    const result = await updateCanonItemSynonyms(item, synonyms);
    synonymsBusy = false;
    if (result.kind === 'ok') saved.flash();
    else synonymsError = 'Invalid synonyms.';
  }

  async function saveShoppingBehavior(value: string): Promise<void> {
    const item = canon;
    if (!item) return;
    const result = await saveCanonShoppingBehavior(item, value, {
      onBusy: (b) => (behaviorBusy = b),
    });
    if (result === 'saved') saved.flash();
  }

  async function saveThreshold(): Promise<void> {
    const item = canon;
    if (!item) return;
    const result = await saveCanonThreshold(item, editingThreshold, editingUnit, {
      onBusy: (b) => (thresholdBusy = b),
    });
    if (result === 'saved') saved.flash();
  }

  // ─── Icon (Tier-1 pictogram) escape hatch ───────────────────────────────────
  //
  // Shared by both record kinds since issue #871: a product form has its own
  // pictogram, generated by the same pipeline off the same seed, so it gets the
  // same section and the same three controls. The kind is read here, at the four
  // places it actually differs — which record supplies the picture, what the
  // testid is called, and which service the three actions call — rather than by
  // duplicating the section.

  let iconBusy = $state(false);
  const iconThumbnail = $derived(
    record.kind === 'canon' ? record.item.thumbnail : record.form.thumbnail,
  );
  // A canon item is drawn from its NAME, a form from its LABEL — the label is
  // already the human-facing name of the thing bought ("lime juice"), which is
  // exactly what the trigger prompts the image model with.
  const iconName = $derived(record.kind === 'canon' ? record.item.name : record.form.label);
  const iconVersion = $derived(
    record.kind === 'canon'
      ? (record.item.iconRequestedAt ?? record.item.updatedAt)
      : (record.form.iconRequestedAt ?? record.form.updatedAt),
  );
  const iconTestid = $derived(record.kind === 'canon' ? 'canon-detail' : 'product-form-detail');
  const iconHidden = $derived(iconThumbnail === CANON_ICON_HIDDEN);

  // The regenerate dialog stays: it collects an optional one-shot prompt steer.
  // It is an input, not a "are you sure?" — the thing the commit contract drops.
  // The hint itself lives in RegenerateIconDialog, which clears it on open.
  let regenerateOpen = $state(false);

  function openRegenerateDialog(): void {
    regenerateOpen = true;
  }

  // The read-only prompt window (issue #892). The family follows the same
  // record.kind branch every other icon affordance on this editor follows.
  let promptOpen = $state(false);
  let uploadOpen = $state(false);
  const promptFamily = $derived(record.kind === 'canon' ? 'canon' : 'productForm');

  async function handleRegenerateIcon(hint: string): Promise<void> {
    iconBusy = true;
    const result =
      record.kind === 'canon'
        ? await regenerateCanonIcon(record.item.id, hint || undefined)
        : await regenerateProductFormIcon(record.form.id, hint || undefined);
    iconBusy = false;
    regenerateOpen = false;
    if (result.kind === 'ok') addToast('Regenerating icon…', 'success');
    else addToast('Failed to regenerate icon.', 'destructive');
  }

  async function handleHideIcon(): Promise<void> {
    iconBusy = true;
    const result =
      record.kind === 'canon'
        ? await hideCanonIcon(record.item)
        : await hideProductFormIcon(record.form);
    iconBusy = false;
    if (result.kind !== 'ok') addToast('Failed to hide icon.', 'destructive');
  }

  async function handleUnhideIcon(): Promise<void> {
    iconBusy = true;
    const result =
      record.kind === 'canon'
        ? await unhideCanonIcon(record.item.id)
        : await unhideProductFormIcon(record.form.id);
    iconBusy = false;
    if (result.kind !== 'ok') addToast('Failed to unhide icon.', 'destructive');
  }

  // ─── Canon → its product forms ──────────────────────────────────────────────

  const childForms = $derived(
    canon === null
      ? []
      : $productForms
          .filter((f) => f.parentCanonId === canon.id)
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label)),
  );

  // ─── Form fields ────────────────────────────────────────────────────────────

  const canonComboItems = $derived(
    $canonItems.map((c) => ({ value: c.id, label: titleCase(c.name) })),
  );

  let formBusy = $state(false);
  let matchersError = $state('');
  let parentError = $state('');
  let yieldError = $state('');
  let confirmError = $state('');

  const FIELD_ERRORS = {
    matchers: 'Add at least one matcher.',
    parent: 'Pick a parent item.',
    yield: 'Give a yield amount above 0.',
  } as const;

  function buildFormInput(f: ProductForm) {
    return {
      matchers: matchersText
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      parentCanonId,
      // The label lives in the page title, which owns its own commit.
      label: f.label,
      formUnit,
      amountPerParent: parseFloat(amount),
    };
  }

  function formUnchanged(f: ProductForm, input: ReturnType<typeof buildFormInput>): boolean {
    return (
      input.parentCanonId === f.parentCanonId &&
      input.formUnit === f.yield.formUnit &&
      input.amountPerParent === f.yield.amountPerParent &&
      input.matchers.length === f.matchers.length &&
      input.matchers.every((m, i) => m === f.matchers[i])
    );
  }

  /**
   * A form is written whole (LWW per document), so any field's commit carries the
   * whole draft. `field` only decides where a rejection is shown — the failure is
   * always "this draft is not a valid form", and the field just left is the one
   * the reader is looking at.
   */
  async function saveForm(field: keyof typeof FIELD_ERRORS): Promise<void> {
    const f = form;
    if (!f) return;
    const input = buildFormInput(f);
    if (formUnchanged(f, input)) return;
    matchersError = '';
    parentError = '';
    yieldError = '';
    formBusy = true;
    const result = await editProductForm(f, input);
    formBusy = false;
    if (result.kind === 'ok') {
      saved.flash();
      return;
    }
    const message = FIELD_ERRORS[field];
    if (field === 'matchers') matchersError = message;
    else if (field === 'parent') parentError = message;
    else yieldError = message;
  }

  // ─── Approve / Confirm ──────────────────────────────────────────────────────

  let approveBusy = $state(false);

  async function handleApprove(): Promise<void> {
    const item = canon;
    if (!item) return;
    approveBusy = true;
    // No overrides: every edit already wrote through, so approving is only the
    // review being recorded. It stays on this page (issue #872) — the fields do
    // not move, the `review` strip and this button simply go.
    await approveCanonItemWithOverrides(item);
    approveBusy = false;
  }

  let confirmBusy = $state(false);

  async function handleConfirm(): Promise<void> {
    const f = form;
    if (!f) return;
    confirmError = '';
    confirmBusy = true;
    const result = await confirmProductForm(f, buildFormInput(f));
    confirmBusy = false;
    if (result.kind !== 'ok') {
      confirmError =
        'Please give a label, pick a parent item, add at least one matcher, and a yield amount above 0.';
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Review context — ABOVE the fields, never a second copy of them. -->
  {#if needsApproval}
    <section
      class="flex flex-col gap-2 rounded border border-review/40 bg-review/10 p-4"
      data-testid={record.kind === 'canon'
        ? 'canon-detail-approval-section'
        : 'product-form-review-banner'}
    >
      <h2 class="text-sm font-semibold text-review-text">
        {record.kind === 'canon' ? 'Review before approving' : 'Review before confirming'}
      </h2>

      {#if record.kind === 'canon'}
        <!-- What changed (issue #193). Absent on items flagged before this
             shipped — that means "not recorded", so nothing renders rather than
             "nothing changed". Every entry is listed, oldest first: several
             changes can land before anyone reviews. -->
        {#if pendingChanges.length > 0}
          <ul
            class="flex flex-col gap-2 text-sm text-review-text"
            data-testid="canon-detail-pending-changes"
          >
            {#each pendingChanges as change, i (i)}
              <li>
                {#if change.kind === 'synonym_added'}
                  Added synonym “{change.synonym}”
                {:else if change.kind === 'aisle_cleared'}
                  <!-- Say WHO did it: this flag is the user's own aisle admin,
                       not an AI decision. The cleared aisle is gone, so it is
                       never named. -->
                  {#if change.origin === 'aisle_merge'}
                    Aisle cleared — you merged its aisle away
                  {:else}
                    Aisle cleared — you deleted its aisle
                  {/if}
                {:else}
                  Created from the shopping list
                {/if}
                {#if change.rawInput}
                  <br />
                  <span class="opacity-80">from “{change.rawInput}”</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if record.item.reasoning}
          <p class="text-sm text-review-text" data-testid="canon-detail-reasoning">
            {reasoningSentence(record.item.reasoning)}
          </p>
        {/if}
      {:else}
        <p class="text-sm text-review-text">
          This mapping was proposed automatically while importing a recipe and is already being
          used. Check the parent item and yield below, then Confirm.
        </p>
        {#if parentPending}
          <p class="text-sm text-review-text">
            The parent item was auto-created too and is still awaiting review.
            <button
              type="button"
              class="font-medium underline underline-offset-2"
              data-testid="product-form-parent-pending"
              onclick={() => push(`/admin/catalog/c:${form?.parentCanonId}`)}
            >
              Review the parent
            </button>
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  <!-- The icon, for BOTH kinds (issue #871). A product form gets its own
       pictogram rather than its parent's, so the section, the controls and the
       regenerate dialog below are all shared and read the record-agnostic
       `icon*` deriveds — only the testid prefix and the underlying service call
       differ by kind. -->
  <section class="flex flex-col gap-2" data-testid="{iconTestid}-icon-section">
    <h2 class="text-sm font-medium text-foreground">Icon</h2>
    <div class="flex items-center gap-3">
      <CanonIcon thumbnail={iconThumbnail} name={iconName} size={96} version={iconVersion} />
      <div class="flex gap-2">
        <Button
          data-testid="{iconTestid}-icon-regenerate"
          variant="outline"
          size="sm"
          onclick={openRegenerateDialog}
          disabled={iconBusy}
        >
          {#snippet leading()}
            <Icon name="RefreshCw" size={16} />
          {/snippet}
          Regenerate
        </Button>
        <Button
          data-testid="{iconTestid}-icon-prompt"
          variant="outline"
          size="sm"
          onclick={() => (promptOpen = true)}
        >
          {#snippet leading()}
            <Icon name="Copy" size={16} />
          {/snippet}
          Prompt
        </Button>
        <Button
          data-testid="{iconTestid}-icon-upload"
          variant="outline"
          size="sm"
          onclick={() => (uploadOpen = true)}
        >
          {#snippet leading()}
            <Icon name="Upload" size={16} />
          {/snippet}
          Upload
        </Button>
        {#if iconHidden}
          <Button
            data-testid="{iconTestid}-icon-unhide"
            variant="outline"
            size="sm"
            onclick={handleUnhideIcon}
            loading={iconBusy}
            disabled={iconBusy}
          >
            {#snippet leading()}
              <Icon name="Eye" size={16} />
            {/snippet}
            Unhide
          </Button>
        {:else}
          <Button
            data-testid="{iconTestid}-icon-hide"
            variant="outline"
            size="sm"
            onclick={handleHideIcon}
            loading={iconBusy}
            disabled={iconBusy}
          >
            {#snippet leading()}
              <Icon name="EyeOff" size={16} />
            {/snippet}
            Hide
          </Button>
        {/if}
      </div>
    </div>
  </section>

  <!-- The one field stack. -->
  {#if record.kind === 'canon'}
    {@const item = record.item}

    <section class="flex flex-col gap-2">
      <h2 class="text-sm font-medium text-foreground">Aisle</h2>
      <div class="flex items-center gap-2">
        <div class="flex-1" data-testid="canon-detail-aisle-select">
          <Combobox
            items={aisleItems}
            value={item.aisleId ?? ''}
            onValueChange={saveAisle}
            placeholder="Search aisles…"
            restrict
          >
            <ComboboxField>
              <ComboboxInput />
              <ComboboxTrigger />
            </ComboboxField>
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
        {#if aisleBusy}
          <Spinner size={16} />
        {/if}
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <TextField
        label="Synonyms"
        description="Separate multiple synonyms with commas."
        value={editingSynonyms}
        onValueChange={(v) => (editingSynonyms = v)}
        error={synonymsError}
        placeholder="e.g. Butter, Unsalted butter"
        data-testid="canon-detail-synonyms-input"
        disabled={synonymsBusy}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveSynonyms();
          } else if (e.key === 'Escape') {
            editingSynonyms = item.synonyms.join(', ');
          }
        }}
        onblur={saveSynonyms}
      />
    </section>

    <section class="flex flex-col gap-2" data-testid="canon-detail-behavior-section">
      <div class="flex items-center gap-2">
        <RadioGroup
          label="Shopping behavior"
          orientation="horizontal"
          value={item.shoppingBehavior}
          onValueChange={saveShoppingBehavior}
          disabled={behaviorBusy}
        >
          <RadioGroupItem value="stocked" label="Stocked" />
          <RadioGroupItem value="check" label="Check" />
          <RadioGroupItem value="needed" label="Needed" />
        </RadioGroup>
        {#if behaviorBusy}
          <Spinner size={16} />
        {/if}
      </div>
    </section>

    <section class="flex flex-col gap-2" data-testid="canon-detail-threshold-section">
      <h2 class="text-sm font-medium text-foreground">Quantity threshold</h2>
      <div class="flex gap-2 items-end">
        <div class="flex-1">
          <TextField
            label=""
            inputmode="numeric"
            value={editingThreshold}
            onValueChange={(v) => (editingThreshold = v)}
            placeholder="e.g. 500"
            data-testid="canon-detail-threshold-input"
            disabled={thresholdBusy}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveThreshold();
              } else if (e.key === 'Escape') {
                editingThreshold = item.largeQuantityThreshold?.toString() ?? '';
              }
            }}
            onblur={saveThreshold}
          />
        </div>
        <div class="w-28">
          <Select
            value={editingUnit}
            onValueChange={(v) => {
              editingUnit = v as CanonItemUnit;
              saveThreshold();
            }}
            disabled={thresholdBusy}
          >
            <SelectTrigger data-testid="canon-detail-unit-select">{editingUnit}</SelectTrigger>
            <SelectContent>
              <SelectItem value="g">g</SelectItem>
              <SelectItem value="ml">ml</SelectItem>
              <SelectItem value="count">count</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>

    <!-- The item's product forms. Rendered even when empty: the add affordance
         is the point, and hiding it behind "has at least one" is how forms end
         up only ever being created by the importer. -->
    <section class="flex flex-col gap-2" data-testid="canon-detail-forms-section">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-sm font-medium text-foreground">Product forms</h2>
        <Button
          data-testid="canon-detail-add-form"
          variant="outline"
          size="sm"
          onclick={() => push(`/admin/product-forms/new?parent=${item.id}`)}
        >
          {#snippet leading()}
            <Icon name="Plus" size={16} />
          {/snippet}
          Add form
        </Button>
      </div>
      {#if childForms.length === 0}
        <Text muted>No product forms for this item.</Text>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each childForms as child (child.id)}
            <li>
              <button
                type="button"
                class="w-full rounded p-2 text-left transition-colors hover:bg-muted/50"
                data-testid="canon-detail-form-row"
                onclick={() => push(`/admin/catalog/f:${child.id}`)}
              >
                <span class="font-medium text-foreground">{child.label}</span>
                <span class="block text-sm text-muted-foreground">
                  {child.matchers.join(', ')} · {child.yield.amountPerParent}
                  {child.yield.formUnit} per item
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    {@const f = record.form}

    <TextField
      label="Matchers"
      description="Comma-separated EXTRA phrasings a recipe might use, e.g. “dark meat, drumsticks”. Plurals and quantities are ignored when matching."
      value={matchersText}
      onValueChange={(v) => (matchersText = v)}
      error={matchersError}
      placeholder="e.g. lime juice, fresh lime juice"
      data-testid="product-form-matchers-input"
      disabled={formBusy}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveForm('matchers');
        } else if (e.key === 'Escape') {
          matchersText = f.matchers.join(', ');
        }
      }}
      onblur={() => saveForm('matchers')}
    />

    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">Parent item</span>
      <div data-testid="product-form-parent-select">
        <Combobox
          items={canonComboItems}
          value={parentCanonId}
          onValueChange={(v) => {
            parentCanonId = v;
            saveForm('parent');
          }}
          placeholder="Search items…"
          restrict
        >
          <ComboboxField>
            <ComboboxInput />
            <ComboboxTrigger />
          </ComboboxField>
          <ComboboxContent>
            {#snippet children({ filteredItems })}
              {#each filteredItems as cbItem, i (cbItem.value)}
                <ComboboxItem item={cbItem} index={i} />
              {/each}
              {#if filteredItems.length === 0}
                <ComboboxEmpty>No items match.</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
      </div>
      {#if parentError}
        <span class="text-sm text-destructive">{parentError}</span>
      {/if}
    </div>

    <div class="flex items-end gap-2">
      <div class="flex-1">
        <TextField
          label="Yield per parent"
          inputmode="decimal"
          value={amount}
          onValueChange={(v) => (amount = v)}
          error={yieldError}
          placeholder="e.g. 30"
          data-testid="product-form-amount-input"
          disabled={formBusy}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveForm('yield');
            } else if (e.key === 'Escape') {
              amount = f.yield.amountPerParent.toString();
            }
          }}
          onblur={() => saveForm('yield')}
        />
      </div>
      <div class="w-28">
        <Select
          value={formUnit}
          onValueChange={(v) => {
            formUnit = v as CanonItemUnit;
            saveForm('yield');
          }}
          disabled={formBusy}
        >
          <SelectTrigger data-testid="product-form-unit-select">{formUnit}</SelectTrigger>
          <SelectContent>
            <SelectItem value="g">g</SelectItem>
            <SelectItem value="ml">ml</SelectItem>
            <SelectItem value="count">count</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  {/if}

  <!-- The quiet acknowledgement that replaces the Save button. -->
  <div class="h-5" aria-live="polite">
    {#if saved.visible}
      <span
        class="flex items-center gap-1 text-sm text-muted-foreground"
        data-testid="record-editor-saved"
      >
        <Icon name="Check" size={14} />
        Saved
      </span>
    {/if}
  </div>

  <!-- The review consequence — BELOW the fields it applies to. -->
  {#if needsApproval}
    <div class="flex flex-col gap-2">
      {#if record.kind === 'canon'}
        <div>
          <Button
            data-testid="canon-detail-approve-button"
            onclick={handleApprove}
            loading={approveBusy}
            disabled={approveBusy}
          >
            Approve
          </Button>
        </div>
      {:else}
        <div>
          <Button
            data-testid="product-form-confirm-button"
            onclick={handleConfirm}
            loading={confirmBusy}
            disabled={confirmBusy}
          >
            Confirm
          </Button>
        </div>
        {#if confirmError}
          <p class="text-sm text-destructive">{confirmError}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<RegenerateIconDialog
  open={regenerateOpen}
  onOpenChange={(v) => (regenerateOpen = v)}
  placeholder="e.g. show it as a tin, sliced, make it greener"
  testidPrefix={iconTestid}
  busy={iconBusy}
  onConfirm={handleRegenerateIcon}
/>

<ImagePromptDialog
  bind:open={promptOpen}
  family={promptFamily}
  id={record.kind === 'canon' ? record.item.id : record.form.id}
  subject={iconName}
  data-testid="{iconTestid}-prompt-dialog"
/>

<ImageUploadDialog
  bind:open={uploadOpen}
  family={promptFamily}
  id={record.kind === 'canon' ? record.item.id : record.form.id}
  subject={iconName}
  data-testid="{iconTestid}-upload-dialog"
/>
