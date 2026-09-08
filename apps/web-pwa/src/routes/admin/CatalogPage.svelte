<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    CollapsibleSection,
    ListPage,
    SelectAllCheckbox,
    Text,
    createListSelection,
    type BulkAction,
  } from '@salt/ui-components';
  import { untrack } from 'svelte';
  import { push, router } from 'svelte-spa-router';
  import type { CanonItem, ProductForm } from '@salt/domain';
  import { goBack } from '../../lib/nav.js';
  import {
    canonItems,
    isLoadingAisles,
    deleteCanonItem,
    approveCanonItems,
    regenerateCanonIcon,
  } from '../../lib/canonService.js';
  import { aisles } from '../../lib/aisleService.js';
  import {
    productForms,
    isLoadingProductForms,
    confirmProductForm,
    deleteProductForm,
    regenerateProductFormIcon,
  } from '../../lib/productFormService.js';
  import { titleCase } from '../../lib/titleCase.js';
  import { SPLIT_QUERY, createMediaQuery } from '../../lib/mediaQuery.svelte.js';
  import { addToast } from '../../lib/toastStore.js';
  import { createDeferredDelete } from '../../lib/deferredDelete.svelte.js';
  import AdminGuard from './AdminGuard.svelte';
  import CatalogRow from './CatalogRow.svelte';
  import CatalogRecordPane from './CatalogRecordPane.svelte';
  import {
    canonKey,
    formKey,
    parseRecordKey,
    readCatalogArrival,
    routeRecordKey,
    type CatalogFilter,
    type CatalogRecordKey,
  } from './catalogRoute.js';

  /**
   * The catalog (issue #872) — ONE list holding canon items and the product forms
   * that hang off them, in place of the two separate admin lists.
   *
   * Structurally it is the shopping list: aisle-grouped collapsible sections whose
   * rows stand for several children. The row displays and the editor edits — beside
   * the list from `split:` up, the whole screen below it.
   */

  // `params` is OPTIONAL: this page serves `/admin/catalog` (static, no params) as
  // well as `/admin/catalog/:id` and the four aliases. svelte-spa-router passes a
  // `params` prop only for parameterised routes.
  let { params }: { params?: { id?: string } } = $props();

  // Which door we came in by, read ONCE. The path family cannot change without a
  // remount, and it is the only thing that says which collection a bare alias
  // `:id` belongs to, which filter to preset, and where a deleted record returns
  // you to.
  const arrival = readCatalogArrival(router.location);

  const routeKey = $derived(routeRecordKey(arrival, params?.id));

  // ─── View state — in memory only (Rule 3) ───────────────────────────────────

  let filterText = $state('');
  let filter = $state<CatalogFilter>(arrival.filter);
  let selectionMode = $state(false);
  let collapsedAisles = $state(new Set<string>());
  let expandedRows = $state(new Set<string>());

  function toggleAisle(aisleId: string): void {
    const next = new Set(collapsedAisles);
    if (next.has(aisleId)) next.delete(aisleId);
    else next.add(aisleId);
    collapsedAisles = next;
  }

  function toggleRow(id: string): void {
    const next = new Set(expandedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedRows = next;
  }

  const FILTERS: { id: CatalogFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'needs-review', label: 'Needs review' },
    { id: 'has-forms', label: 'Has forms' },
    { id: 'no-threshold', label: 'No threshold' },
  ];

  // ─── Two panes, one gate ────────────────────────────────────────────────────
  // Is the editor docked in a column of its own? From `split:` up it is. This must
  // stay the SAME GATE as the `split:` variant the columns are laid out with, and
  // it is what `fill` is passed from as well — one gate, so the classes and the
  // prop cannot disagree (ui-spec-v07 §1.4). The read itself, and the four ways
  // it can fail, are `lib/mediaQuery.svelte.ts`.
  const split = createMediaQuery(SPLIT_QUERY);
  const docked = $derived(split.matches);

  // ─── Which record the editor is on ──────────────────────────────────────────
  // Seeded from the route, then owned by the page: on the two-pane breakpoint
  // choosing a row must NOT navigate, because the router remounts this page on a
  // route change and the list would lose its scroll position.
  // `untrack` because this is the value AT MOUNT, deliberately not a live read —
  // the `$effect` below is what follows the route afterwards.
  const mountedKey = routeRecordKey(
    arrival,
    untrack(() => params?.id),
  );
  let openKey = $state<CatalogRecordKey | null>(mountedKey);
  let syncedRouteKey = $state<CatalogRecordKey | null>(mountedKey);

  $effect(() => {
    if (routeKey === syncedRouteKey) return;
    syncedRouteKey = routeKey;
    openKey = routeKey;
  });

  const openRecord = $derived.by(() => {
    const parsed = openKey ? parseRecordKey(openKey) : null;
    if (!parsed) return null;
    if (parsed.kind === 'canon') {
      const item = $canonItems.find((i) => i.id === parsed.id);
      return item ? ({ kind: 'canon', item } as const) : null;
    }
    const form = $productForms.find((f) => f.id === parsed.id);
    return form ? ({ kind: 'form', form } as const) : null;
  });

  function openRecordKey(key: CatalogRecordKey): void {
    if (docked) openKey = key;
    else push(`/admin/catalog/${key}`);
  }

  // Back, which only the full-page editor offers — the docked pane has no back
  // button, because the list is already beside it.
  function closeRecord(): void {
    goBack(arrival.listPath);
  }

  // A deleted record leaves the pane AND the URL: a path still naming it would be
  // a dead bookmark. The undo toast outlives this page, so the deferred delete is
  // unaffected by the list remounting under it.
  function recordDeleted(): void {
    openKey = null;
    push(arrival.listPath);
  }

  // ─── Deferred delete / deferred approve ─────────────────────────────────────

  const deferredDelete = createDeferredDelete();

  // Deferred approve + ONE undo (issue #872). Approving is deferred exactly as a
  // delete is: nothing is written until the toast lapses, so Undo cancels cleanly
  // and there is no un-approve write path to invent. Meanwhile the affected
  // records read as approved — they leave "Needs review" and lose their shading.
  //
  // Deliberately page-local rather than a second shared helper in `src/lib`: this
  // is its first and only consumer, and the repo promotes on the second.
  let approving = $state(new Set<string>());

  // The Undo window, which is also how long the write waits. Shorter than the
  // Toast default (5000ms) and than shopping's single-item delete (4200ms):
  // approving is a confirmation, not a destruction, so the toast is read and
  // dismissed rather than deliberated over. It is still the only way back —
  // there is no un-approve write path — so it is not cut to nothing.
  const APPROVE_UNDO_MS = 3000;

  function releaseApproving(keys: readonly string[]): void {
    const next = new Set(approving);
    for (const key of keys) next.delete(key);
    approving = next;
  }

  function requestApprove(keys: readonly CatalogRecordKey[]): void {
    if (keys.length === 0) return;
    const list = [...keys];
    approving = new Set([...approving, ...list]);
    let undone = false;
    // `success`, and said before the write lands: the rows already read as
    // approved, so the toast matches what the reader is looking at. A failed
    // commit still surfaces its own destructive toast from `commitApprove`.
    addToast(`${list.length} record${list.length === 1 ? '' : 's'} approved`, 'success', {
      duration: APPROVE_UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          releaseApproving(list);
        },
      },
      onDismiss: () => {
        if (undone) return;
        void commitApprove(list).finally(() => releaseApproving(list));
      },
    });
  }

  // Approving a canon item and confirming a product form are the same act — the
  // review being recorded over the record's OWN current values. Neither writes
  // anything else: every edit already went through the editor.
  async function commitApprove(keys: readonly string[]): Promise<void> {
    const canonIds: string[] = [];
    const forms: ProductForm[] = [];
    for (const key of keys) {
      const parsed = parseRecordKey(key);
      if (!parsed) continue;
      if (parsed.kind === 'canon') canonIds.push(parsed.id);
      else {
        const form = $productForms.find((f) => f.id === parsed.id);
        if (form) forms.push(form);
      }
    }
    const approved = await approveCanonItems(canonIds);
    const results = await Promise.all(
      forms.map((f) =>
        confirmProductForm(f, {
          matchers: f.matchers,
          parentCanonId: f.parentCanonId,
          label: f.label,
          formUnit: f.yield.formUnit,
          amountPerParent: f.yield.amountPerParent,
        }),
      ),
    );
    // One message for both halves: the act the person performed was "approve
    // these records", and which half of it failed to reach Firestore is not a
    // distinction they can act on.
    if (approved.kind !== 'ok' || results.some((r) => r.kind !== 'ok')) {
      addToast('Failed to record some approvals.', 'destructive');
    }
  }

  // `needs_approval` is review-only and never a gate on use — a pending record is
  // already resolving recipes and list adds. These two only decide how it READS.
  function isItemPending(item: CanonItem): boolean {
    return item.needs_approval && !approving.has(canonKey(item.id));
  }

  function isFormPending(form: ProductForm): boolean {
    return form.needs_approval === true && !approving.has(formKey(form.id));
  }

  // ─── The list ───────────────────────────────────────────────────────────────

  const formsByParent = $derived.by(() => {
    const map = new Map<string, ProductForm[]>();
    for (const form of $productForms) {
      if (deferredDelete.isPending(formKey(form.id))) continue;
      const list = map.get(form.parentCanonId);
      if (list) list.push(form);
      else map.set(form.parentCanonId, [form]);
    }
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return map;
  });

  type CatalogRowData = {
    item: CanonItem;
    /** The forms to show under this row — what the current filter leaves. */
    forms: ProductForm[];
    /** Everything "Approve all N" on this row would cover, filter regardless. */
    approveKeys: CatalogRecordKey[];
  };

  const rows = $derived.by((): CatalogRowData[] => {
    const q = filterText.trim().toLowerCase();
    const out: CatalogRowData[] = [];
    for (const item of $canonItems) {
      if (deferredDelete.isPending(canonKey(item.id))) continue;
      const all = formsByParent.get(item.id) ?? [];
      if (
        q !== '' &&
        !item.name.toLowerCase().includes(q) &&
        !item.synonyms.some((s) => s.toLowerCase().includes(q)) &&
        !all.some(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.matchers.some((m) => m.toLowerCase().includes(q)),
        )
      ) {
        continue;
      }
      const pendingForms = all.filter(isFormPending);
      let forms = all;
      if (filter === 'needs-review') {
        if (!isItemPending(item) && pendingForms.length === 0) continue;
        forms = pendingForms;
      } else if (filter === 'has-forms') {
        if (all.length === 0) continue;
      } else if (filter === 'no-threshold') {
        if (item.largeQuantityThreshold != null) continue;
      }
      out.push({
        item,
        forms,
        approveKeys: [
          ...(isItemPending(item) ? [canonKey(item.id)] : []),
          ...pendingForms.map((f) => formKey(f.id)),
        ],
      });
    }
    return out;
  });

  // Rows grouped by aisle, sorted alpha within each group. Aisles appear in their
  // stored order; unassigned at the end. "Needs review" is deliberately in this
  // same order rather than by recency: a review queue that reorders itself as you
  // work it loses your place.
  type AisleGroup = { aisleId: string; aisleName: string; rows: CatalogRowData[] };

  const UNASSIGNED = '__unassigned__';

  const aisleGroups = $derived.by((): AisleGroup[] => {
    const byAisle = new Map<string, CatalogRowData[]>([[UNASSIGNED, []]]);
    for (const aisle of $aisles) byAisle.set(aisle.id, []);

    for (const row of rows) {
      const key = row.item.aisleId ?? UNASSIGNED;
      const bucket = byAisle.get(key);
      if (bucket) bucket.push(row);
      else byAisle.set(key, [row]);
    }

    const groups: AisleGroup[] = [];
    for (const aisle of $aisles) {
      const group = byAisle.get(aisle.id) ?? [];
      if (group.length > 0) {
        groups.push({
          aisleId: aisle.id,
          aisleName: titleCase(aisle.name),
          rows: [...group].sort((a, b) => a.item.name.localeCompare(b.item.name)),
        });
      }
    }
    const unassigned = byAisle.get(UNASSIGNED) ?? [];
    if (unassigned.length > 0) {
      groups.push({
        aisleId: UNASSIGNED,
        aisleName: 'Unassigned',
        rows: [...unassigned].sort((a, b) => a.item.name.localeCompare(b.item.name)),
      });
    }
    return groups;
  });

  // The options every review row's aisle chip offers (issue #872). Derived ONCE
  // here rather than inside the row: the list is the same for every row, and a
  // catalog holds hundreds of them.
  const aisleItems = $derived([
    { value: '', label: 'No aisle' },
    ...$aisles.map((a) => ({ value: a.id, label: titleCase(a.name) })),
  ]);

  // ─── Selection — one selection spanning both record types ───────────────────

  const allVisibleKeys = $derived(
    rows.flatMap((row): CatalogRecordKey[] => [
      canonKey(row.item.id),
      ...row.forms.map((f) => formKey(f.id)),
    ]),
  );

  const selection = createListSelection({
    getAllIds: () => allVisibleKeys,
    isSelectionMode: () => selectionMode,
  });

  function isKeyPending(key: string): boolean {
    const parsed = parseRecordKey(key);
    if (!parsed) return false;
    if (parsed.kind === 'canon') {
      const item = $canonItems.find((i) => i.id === parsed.id);
      return item ? isItemPending(item) : false;
    }
    const form = $productForms.find((f) => f.id === parsed.id);
    return form ? isFormPending(form) : false;
  }

  const selectedPendingKeys = $derived(selection.ids.filter(isKeyPending) as CatalogRecordKey[]);

  function handleBulkApprove(): void {
    const keys = selectedPendingKeys;
    if (keys.length === 0) return;
    selectionMode = false; // exiting selection mode clears the selection
    requestApprove(keys);
  }

  async function handleBulkRegenerateIcon(): Promise<void> {
    // No longer canon-only: since issue #871 a product form has its own icon from
    // the same pipeline, so a mixed selection regenerates every record in it, each
    // through its own collection's callable. The count can therefore be the whole
    // selection again rather than a canon-only subset.
    const records = selection.ids
      .map(parseRecordKey)
      .filter((p): p is { kind: 'canon' | 'form'; id: string } => p !== null);
    if (records.length === 0) return;
    selectionMode = false;
    const results = await Promise.all(
      records.map((r) =>
        r.kind === 'canon' ? regenerateCanonIcon(r.id) : regenerateProductFormIcon(r.id),
      ),
    );
    if (results.some((r) => r.kind !== 'ok')) {
      addToast('Failed to regenerate some icons.', 'destructive');
    } else {
      addToast(`Regenerating ${records.length} icon${records.length === 1 ? '' : 's'}…`, 'success');
    }
  }

  function handleBulkDelete(): void {
    if (selection.count === 0) return;
    const keys = selection.ids;
    selectionMode = false;
    const noun = keys.every((k) => k.startsWith('f:'))
      ? 'form'
      : keys.every((k) => k.startsWith('c:'))
        ? 'item'
        : 'record';
    deferredDelete.request(
      keys,
      async (delKeys) => {
        const results = await Promise.all(
          delKeys
            .map(parseRecordKey)
            .filter((p): p is { kind: 'canon' | 'form'; id: string } => p !== null)
            .map((p) => (p.kind === 'canon' ? deleteCanonItem(p.id) : deleteProductForm(p.id))),
        );
        if (results.some((r) => r.kind !== 'ok')) {
          addToast('Failed to delete some records.', 'destructive');
        }
      },
      { noun },
    );
  }

  // Contextual bottom action bar. Approve only appears when pending records are
  // selected; it covers canon items and product forms in one verb, because
  // approving an item and confirming a form are the same act.
  const bulkActions = $derived<BulkAction[]>([
    ...(selectedPendingKeys.length > 0
      ? [
          {
            id: 'approve',
            label: `Approve (${selectedPendingKeys.length})`,
            icon: 'Check',
            testId: 'catalog-bulk-approve',
            onSelect: handleBulkApprove,
          } satisfies BulkAction,
        ]
      : []),
    {
      id: 'regenerate-icon',
      label: 'Regenerate icon',
      icon: 'RefreshCw',
      testId: 'catalog-bulk-regenerate-icon',
      onSelect: () => void handleBulkRegenerateIcon(),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      variant: 'destructive',
      testId: 'catalog-bulk-delete',
      onSelect: handleBulkDelete,
    },
  ]);
</script>

<AdminGuard>
  {#if openRecord && !docked}
    <!-- The phone: a chosen record is the whole screen, and Back returns to the
         list. `DetailPage` here is an ORDINARY page — it must not be `fill`, and
         it is never nested inside the filled list below. -->
    <div class="p-4 sm:p-6">
      <CatalogRecordPane
        record={openRecord}
        variant="page"
        onOpen={openRecordKey}
        onClose={closeRecord}
        onDeleted={recordDeleted}
      />
    </div>
  {:else}
    <ListPage
      title="Catalog"
      description="Items, and the product forms that stand in for them."
      isLoading={$isLoadingAisles || $isLoadingProductForms}
      isEmpty={$canonItems.length === 0}
      class="p-4 sm:p-6"
      fill={docked}
      bind:selectionMode
      selectionCount={selection.count}
      {bulkActions}
    >
      {#snippet actions()}
        <Button size="sm" variant="outline" onclick={() => push('/admin/product-forms/new')}>
          Add form
        </Button>
        <Button size="sm" onclick={() => push('/admin/canon/new')}>Add item</Button>
      {/snippet}

      {#snippet selectionBar()}
        <SelectAllCheckbox {selection} />
      {/snippet}

      {#snippet children()}
        <!-- Two panes from `split:` up, one column below it. The height comes from
             `ListPage`'s fill chain (ui-spec-v05 §1, ui-spec-v07 §1.4) resolving
             against AppShell's <main> — there is deliberately no `calc(100dvh - …)`
             and nothing measures chrome. -->
        <div class="grid gap-4 split:min-h-0 split:flex-1 split:grid-cols-2 split:gap-6">
          <div
            class="flex min-w-0 flex-col gap-4 split:min-h-0 split:overflow-y-auto split:salt-focus-gutter"
          >
            <div class="flex flex-col gap-2">
              <input
                class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                placeholder="Filter catalog…"
                type="search"
                data-testid="catalog-filter-text"
                bind:value={filterText}
              />
              <ChipGroup ariaLabel="Filter the catalog">
                {#each FILTERS as chip (chip.id)}
                  <Chip
                    pressed={filter === chip.id}
                    onclick={() => (filter = chip.id)}
                    data-testid="catalog-filter-{chip.id}"
                  >
                    {chip.label}
                  </Chip>
                {/each}
              </ChipGroup>
            </div>

            {#if aisleGroups.length === 0}
              <Text muted>Nothing matches this view.</Text>
            {:else}
              {#each aisleGroups as group (group.aisleId)}
                {@const collapsed = collapsedAisles.has(group.aisleId)}
                <CollapsibleSection
                  title={group.aisleName}
                  expanded={!collapsed}
                  onToggle={() => toggleAisle(group.aisleId)}
                  collapsedCount={group.rows.length}
                  triggerTestId="catalog-aisle-toggle"
                  data-testid="catalog-aisle-group"
                  data-aisle-id={group.aisleId}
                >
                  <ul class="flex flex-col gap-1">
                    {#each group.rows as row (row.item.id)}
                      <CatalogRow
                        item={row.item}
                        forms={row.forms}
                        {aisleItems}
                        pending={isItemPending(row.item)}
                        {isFormPending}
                        expanded={expandedRows.has(row.item.id)}
                        onToggle={filter === 'needs-review'
                          ? undefined
                          : () => toggleRow(row.item.id)}
                        {openKey}
                        {selectionMode}
                        isSelected={(key) => selection.isSelected(key)}
                        onToggleSelect={(key) => selection.toggle(key)}
                        onOpen={openRecordKey}
                        onApprove={() => requestApprove(row.approveKeys)}
                        approveCount={row.approveKeys.length}
                        onAddForm={() => push(`/admin/product-forms/new?parent=${row.item.id}`)}
                      />
                    {/each}
                  </ul>
                </CollapsibleSection>
              {/each}
            {/if}
          </div>

          <!-- The editor, docked from `split:` up. Below that it does not render at
               all — the record takes the whole screen instead. -->
          <div class="hidden min-w-0 flex-col split:flex split:min-h-0">
            {#if openRecord}
              <CatalogRecordPane
                record={openRecord}
                variant="pane"
                onOpen={openRecordKey}
                onClose={closeRecord}
                onDeleted={recordDeleted}
              />
            {:else}
              <Text muted>Choose a record to edit it here.</Text>
            {/if}
          </div>
        </div>
      {/snippet}
    </ListPage>
  {/if}
</AdminGuard>
