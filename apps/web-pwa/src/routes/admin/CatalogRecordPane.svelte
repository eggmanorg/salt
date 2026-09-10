<script lang="ts">
  import { Button, DetailPage, Icon } from '@salt/ui-components';
  import type { CanonItem, ProductForm } from '@salt/domain';
  import { canonKey, type CatalogRecordKey } from './catalogRoute.js';
  import {
    updateCanonItemName,
    deleteCanonItem,
    splitMostRecentSynonym,
  } from '../../lib/canonService.js';
  import { editProductForm, deleteProductForm } from '../../lib/productFormService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { titleCase } from '../../lib/titleCase.js';
  import { createDeferredDelete } from '../../lib/deferredDelete.svelte.js';
  import { createSavedTick } from '../../lib/savedTick.svelte.js';
  import EditableRecordTitle from './EditableRecordTitle.svelte';
  import RecordEditor from './RecordEditor.svelte';

  /**
   * The catalog's editor (issue #872) — the record's identity, its destructive
   * actions, and Phase 1's `RecordEditor` underneath.
   *
   * Two shapes, one behaviour. `pane` is the right-hand column of the two-pane
   * catalog, which scrolls itself; `page` is the phone, where a chosen record
   * takes the whole screen and comes back with a Back button. Everything about
   * what a record IS lives in `RecordEditor`; this is only the frame.
   */
  let {
    record,
    variant,
    onOpen,
    onClose,
    onDeleted,
  }: {
    record: { kind: 'canon'; item: CanonItem } | { kind: 'form'; form: ProductForm };
    variant: 'page' | 'pane';
    onOpen: (key: CatalogRecordKey) => void;
    /** Back / dismissed — returns to wherever the reader came from. */
    onClose: () => void;
    /** The record is going: return to the list, never to another record. */
    onDeleted: () => void;
  } = $props();

  const saved = createSavedTick();

  // Deferred delete + Undo (issue #872) in place of a confirm dialog. Nothing is
  // deleted until the toast lapses, so "are you sure?" has nothing left to ask.
  // The list still shows the record for the undo window — honest, because it has
  // not been deleted.
  const deferredDelete = createDeferredDelete();

  const title = $derived(record.kind === 'canon' ? titleCase(record.item.name) : record.form.label);

  let titleError = $state('');

  async function saveTitle(next: string): Promise<void> {
    if (!next) return;
    titleError = '';
    if (record.kind === 'canon') {
      const item = record.item;
      if (next === item.name) return;
      const result = await updateCanonItemName(item, next);
      if (result.kind === 'ok') saved.flash();
      else titleError = 'Invalid name.';
      return;
    }
    const f = record.form;
    if (next === f.label) return;
    const result = await editProductForm(f, {
      matchers: f.matchers,
      parentCanonId: f.parentCanonId,
      label: next,
      formUnit: f.yield.formUnit,
      amountPerParent: f.yield.amountPerParent,
    });
    if (result.kind === 'ok') saved.flash();
    else titleError = 'Invalid label.';
  }

  let splitBusy = $state(false);

  async function handleSplit(): Promise<void> {
    if (record.kind !== 'canon') return;
    const item = record.item;
    if (item.synonyms.length === 0) return;
    splitBusy = true;
    const last = item.synonyms[item.synonyms.length - 1]!;
    const result = await splitMostRecentSynonym(item);
    splitBusy = false;
    if (result.kind === 'ok') {
      addToast(`Split "${titleCase(last)}" into a new item`, 'success');
      onOpen(canonKey(result.value.id));
    }
  }

  // The id and the words are read BEFORE the deferral: `record` derives off the
  // live subscription and is gone the moment the delete lands.
  function handleDelete(): void {
    if (record.kind === 'canon') {
      const { id } = record.item;
      const name = titleCase(record.item.name);
      deferredDelete.request(
        [id],
        async () => {
          const result = await deleteCanonItem(id);
          if (result.kind !== 'ok') addToast('Failed to delete item.', 'destructive');
        },
        { message: `"${name}" deleted`, noun: 'item' },
      );
    } else {
      const { id, label } = record.form;
      deferredDelete.request(
        [id],
        async () => {
          const result = await deleteProductForm(id);
          if (result.kind !== 'ok') addToast('Failed to delete form.', 'destructive');
        },
        { message: `"${label}" deleted`, noun: 'form' },
      );
    }
    onDeleted();
  }
</script>

{#snippet titleControl()}
  <EditableRecordTitle
    value={record.kind === 'canon' ? record.item.name : record.form.label}
    display={title}
    testId={record.kind === 'canon' ? 'canon-detail-name-input' : 'product-form-label-input'}
    editLabel={record.kind === 'canon' ? 'Edit name' : 'Edit label'}
    error={titleError}
    onCommit={saveTitle}
  />
{/snippet}

{#snippet recordActions()}
  {#if record.kind === 'canon' && record.item.synonyms.length > 0}
    <Button
      data-testid="canon-detail-split-button"
      variant="outline"
      size="sm"
      onclick={handleSplit}
      loading={splitBusy}
      disabled={splitBusy}
    >
      {#snippet leading()}
        <Icon name="Split" size={16} />
      {/snippet}
      Split
    </Button>
  {/if}
  <Button
    data-testid={record.kind === 'canon'
      ? 'canon-detail-delete-button'
      : 'product-form-delete-button'}
    variant="destructive"
    size="sm"
    onclick={handleDelete}
  >
    {#snippet leading()}
      <Icon name="Trash2" size={16} />
    {/snippet}
    Delete
  </Button>
{/snippet}

{#if variant === 'page'}
  <DetailPage {title} onBack={onClose} backLabel="Back">
    {#snippet titleSlot()}{@render titleControl()}{/snippet}
    {#snippet actions()}{@render recordActions()}{/snippet}
    <div class="max-w-xl">
      <RecordEditor {record} {saved} />
    </div>
  </DetailPage>
{:else}
  <!-- The pane's own scroller. Its height comes from the fill chain the page sets
       up (ui-spec-v07 §1.4) — nothing here measures chrome. -->
  <div class="flex min-h-0 flex-1 flex-col gap-4" data-testid="catalog-record-pane">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1">{@render titleControl()}</div>
      <div class="flex shrink-0 items-center gap-2">{@render recordActions()}</div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto salt-focus-gutter">
      <RecordEditor {record} {saved} />
    </div>
  </div>
{/if}
