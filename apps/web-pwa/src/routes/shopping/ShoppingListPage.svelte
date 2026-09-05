<script lang="ts">
  import {
    Button,
    CanonIcon,
    Combobox,
    ComboboxContent,
    ComboboxCreate,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    CollapsibleSection,
    DisclosureChevron,
    DisclosureTrigger,
    Icon,
    ListPage,
    SelectAllCheckbox,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Spinner,
    Switch,
    Textarea,
    TextField,
    EmptyState,
    createListSelection,
  } from '@salt/ui-components';
  import { todayIso } from '../../lib/today.js';
  import { describeSource } from '../../lib/shoppingSource.js';
  import { titleCase } from '../../lib/titleCase.js';
  import { onDestroy, tick } from 'svelte';
  import { push } from 'svelte-spa-router';
  import {
    daysBetween,
    shopDayHeadline,
    groupItemsByAisle,
    groupItemsByRecipe,
    resolveItemDisplayName,
  } from '@salt/domain';
  import type { ShoppingListItem, AisleRow, AmountSubtotal } from '@salt/domain';
  import { canonItems, aisles, purchaseCounts } from '../../lib/canonService.js';
  import { canonIndex } from '../../lib/canonIndex.js';
  import { recipes } from '../../lib/recipeService.js';
  import {
    lists,
    defaultListId,
    itemsForActiveList,
    isLoadingShoppingList,
    setActiveListId,
    addItemToList,
    updateItemRawText,
    updateItemAmountUnit,
    updateItemNotes,
    toggleItemChecked,
    checkItems,
    uncheckItems,
    removeItem,
    removeItems,
    clearChecked,
    moveSelectedItems,
    confirmItemNeeded,
    confirmItemsNeeded,
    setItemNeedsCheck,
    moveItemWithEdits,
  } from '../../lib/shoppingListService.svelte.js';
  import { upcomingShopDay } from '../../lib/shoppingDayService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { createDeferredDelete } from '../../lib/deferredDelete.svelte.js';
  import { createCheckOffHold } from '../../lib/checkOffHold.svelte.js';
  import {
    shoppingRowClass,
    shoppingRowCollapseClass,
    SHOPPING_ROW_INNER_CLASS,
  } from './shoppingRowShell.js';
  import { createMatchReveal } from '../../lib/matchReveal.svelte.js';
  import { tick as hapticTick } from '../../lib/haptics.js';
  import ShoppingItemRow from './ShoppingItemRow.svelte';
  import CheckOffButton from './CheckOffButton.svelte';
  import type { BulkAction } from '@salt/ui-components';

  interface Props {
    params: { listId: string };
  }
  let { params }: Props = $props();

  // ─── Subscribe to items for this list ────────────────────────────────────────

  $effect(() => {
    setActiveListId(params.listId);
  });

  // ─── Derived state ────────────────────────────────────────────────────────────

  const currentList = $derived($lists.find((l) => l.id === params.listId) ?? null);
  const otherLists = $derived($lists.filter((l) => l.id !== params.listId));
  const isDefault = $derived($defaultListId === params.listId);

  // ─── Shop-day line (issue #629) ─────────────────────────────────────────────
  // Read-only context beneath the list name: what you are stocking for. Tapping
  // it opens that week in the planner, where the shop day is actually set.
  //
  // DEFAULT LIST ONLY — the other lists are background collectors for specialist
  // stores, shopped whenever, and the weekly shop says nothing about them (the
  // same reason the reminder only ever opens the default list).
  //
  // The sentence itself is `shopDayHeadline` in `@salt/domain` — the same rule
  // the daily push reminder renders, which is a different app and cannot import
  // this one. What stays here is only THIS SCREEN'S policy about when to say
  // nothing at all, which the reminder has no equivalent of.
  const shopDays = $derived(
    $upcomingShopDay ? daysBetween(todayIso(), $upcomingShopDay.date) : null,
  );
  const shopHeadline = $derived.by(() => {
    // undefined = the subscription has not resolved yet. Saying nothing is the
    // only honest option; "No shop day set" here would flash on every load.
    if ($upcomingShopDay === undefined) return null;
    if ($upcomingShopDay === null) return 'No shop day set';
    // A window left open across midnight for days can surface a shop that has
    // already happened. Say nothing rather than something wrong.
    if (shopDays === null || shopDays < 0) return null;
    return shopDayHeadline({
      days: shopDays,
      date: $upcomingShopDay.date,
      slot: $upcomingShopDay.slot,
    });
  });
  // The one day that actually changes what you do must not read like the five
  // that don't.
  const shopUrgent = $derived(shopDays !== null && shopDays >= 0 && shopDays <= 1);
  // With no shop set there is no week to deep-link to; land on the planner.
  const shopHref = $derived($upcomingShopDay ? `/mealplan/${$upcomingShopDay.date}` : '/mealplan');

  const canonMap = $derived(
    new Map(
      $canonItems.map((ci) => [
        ci.id,
        {
          id: ci.id,
          name: ci.name,
          aisleId: ci.aisleId,
          thumbnail: ci.thumbnail,
          iconRequestedAt: ci.iconRequestedAt,
          updatedAt: ci.updatedAt,
        },
      ]),
    ),
  );

  // Tri-state icon thumbnail for a row, looked up by its matched canon id.
  // Returns null (→ bare tile) for unmatched/pending rows.
  function thumbnailFor(canonId: string | null): string | null {
    if (!canonId) return null;
    return canonMap.get(canonId)?.thumbnail ?? null;
  }

  // Cache-bust nonce for the matched canon item's icon, resolved via the same
  // canon lookup as `thumbnailFor`. Mirrors the canon pages' render sites
  // (`iconRequestedAt ?? updatedAt`) so a regenerated icon re-fetches instead of
  // serving stale. undefined for unmatched/pending rows (→ raw URL passthrough).
  function iconVersionFor(canonId: string | null): string | number | undefined {
    if (!canonId) return undefined;
    const ci = canonMap.get(canonId);
    return ci ? (ci.iconRequestedAt ?? ci.updatedAt) : undefined;
  }

  const aisleInfos = $derived($aisles.map((a) => ({ id: a.id, name: a.name, order: a.order })));

  // ─── Deferred bulk delete ───────────────────────────────────────────────────────
  // Selected items are hidden immediately, but the real Firestore delete is only
  // committed once the undo window closes. Pressing Undo cancels the commit, so
  // nothing is ever deleted — no soft-delete / restore plumbing required.
  const deferredDelete = createDeferredDelete();

  // The undo window for single-item shopping deletes (edit-sheet delete, "Need it?"
  // drop, and — a later phase — swipe). Bulk delete and the other list pages keep
  // the Toast component default (5000ms); only these single-item deletes shorten it.
  const SINGLE_ITEM_DELETE_MS = 4200;

  const visibleItems = $derived(deferredDelete.visible($itemsForActiveList));

  // ─── Check-off celebration hold ─────────────────────────────────────────────
  // Checking an item off writes IMMEDIATELY; this only keeps the row's place
  // while its outro plays (~760ms), then lets it fall into Checked. Purely
  // component-local presentation state — nothing reaches Firestore or a schema.
  const checkOffHold = createCheckOffHold();
  onDestroy(() => checkOffHold.dispose());

  // ─── Match reveal (lively list, Phase 3 / #571 Treatment 2) ──────────────────
  // The single most-legible moment: a row's canon match lands, so it leaves the
  // "Other" bucket and arrives in its resolved aisle, tile lighting grey→sage.
  //
  // This detector watches the real `matchState` for an unresolved→resolved
  // landing and parks the id as "revealing" for the reveal window. Observed,
  // never written — no schema field. The set drives BOTH halves of the
  // treatment: the tile flourish (CanonIcon's shimmer prop, via `revealing`) and
  // the row's move (`ShoppingItemRow`'s collapse-out / rise-in transitions, via
  // the `isRevealing` gate). The move transitions live in the row; the earlier
  // page-level `crossfade` send/receive pair is gone — measured, its halves never
  // both paired (the receive half always fell back to an instant snap), and #571
  // asks for collapse-out + enter, not a fly.
  //
  // `$effect.pre`, NOT `$effect`, and it matters: the same items update that adds
  // an id to the revealing set is the one that unmounts the Other row and mounts
  // the aisle row. A post-DOM `$effect` would run after those transitions have
  // already read the gate (still closed) — `.pre` commits the set first, so the
  // transitions see it open.
  const matchReveal = createMatchReveal();
  onDestroy(() => matchReveal.dispose());
  $effect.pre(() => {
    matchReveal.observe(visibleItems);
  });

  // ─── Sort mode ──────────────────────────────────────────────────────────────
  // Toggle between grouping by aisle (default) and by source recipe. Ephemeral —
  // resets on reload; no Firestore/local-storage backing (storage rules forbid it).
  let sortMode = $state<'aisle' | 'recipe'>('aisle');

  // ─── Verify filter ───────────────────────────────────────────────────────────
  // When the list holds amber "Need it?" items (recipe-add flagged, #185), offer a
  // toggle that narrows the view to just those, so the shopper can resolve them in
  // one pass. The button only appears while such items exist; clearing the last one
  // drops the filter so the full list returns (effect below).
  const verifyItems = $derived(visibleItems.filter((i) => needsVerify(i)));
  const hasVerifyItems = $derived(verifyItems.length > 0);
  let verifyFilterActive = $state(false);

  $effect(() => {
    if (verifyFilterActive && !hasVerifyItems) verifyFilterActive = false;
  });

  // Items fed into grouping/selection — narrowed to verify items when the filter
  // is on. `isEmpty` stays keyed off the full list so the empty state means "no
  // items", never "filtered to none".
  const displayItems = $derived(verifyFilterActive ? verifyItems : visibleItems);

  // Items as the GROUPING should see them: a row mid-celebration is handed on
  // still reading `checked: false`, so it keeps rendering where it is instead of
  // jumping to the Checked bucket the instant the optimistic write lands. Only
  // the two grouping deriveds read this — `allItemIds`, the verify filter and
  // `isEmpty` all stay on the real state, so selection and counts never lie.
  const groupableItems = $derived(checkOffHold.holdInPlace(displayItems));

  // Declared here (ahead of the selection block below) because the `grouped`
  // derived reads it — a `$derived` is lazy at runtime, but the `let` must still
  // be declared before its first textual use.
  let selectionMode = $state(false);

  // Combine recipe-sourced rows in the normal view; in selection mode show every
  // item individually so bulk check/delete/move act per-item (issue #184).
  const grouped = $derived(
    groupItemsByAisle(groupableItems, canonMap, aisleInfos, { combine: !selectionMode }),
  );

  // Recipe-sorted view: recipe groups, then a Manual section, then checked.
  const recipeGrouped = $derived(groupItemsByRecipe(groupableItems));

  const allItemIds = $derived(displayItems.map((i) => i.id));

  const isEmpty = $derived(!$isLoadingShoppingList && visibleItems.length === 0);

  // ─── Collapsible groups ─────────────────────────────────────────────────────────

  // Checked starts collapsed — it's history, not the active shopping view.
  let checkedCollapsed = $state(true);

  // Aisle sections collapse on demand; tracked by aisle id (expanded by default).
  let collapsedAisles = $state(new Set<string>());

  function toggleAisle(aisleId: string): void {
    const next = new Set(collapsedAisles);
    if (next.has(aisleId)) next.delete(aisleId);
    else next.add(aisleId);
    collapsedAisles = next;
  }

  // ─── List switcher ──────────────────────────────────────────────────────────────

  let listSwitcherOpen = $state(false);

  // ─── Overflow menu ────────────────────────────────────────────────────────────

  let overflowMenuOpen = $state(false);

  function selectSortMode(mode: 'aisle' | 'recipe'): void {
    sortMode = mode;
    overflowMenuOpen = false;
  }

  // ─── Selection state ──────────────────────────────────────────────────────────
  // `selectionMode` itself is declared above (before the `grouped` derived that
  // reads it).

  const selection = createListSelection({
    getAllIds: () => allItemIds,
    isSelectionMode: () => selectionMode,
  });

  // ─── Item capture ─────────────────────────────────────────────────────────────

  let newItemText = $state('');
  let addBusy = $state(false);
  let comboboxResetKey = $state(0);
  // Wrapper around the add combobox; stable across the {#key} remount, so we can
  // find and refocus the freshly-mounted input after an item is added.
  let addFieldEl = $state<HTMLDivElement | undefined>(undefined);

  // Most-bought first, then alphabetical (issue #726). Combobox filters in place
  // and preserves the consumer's array order (ui-spec-v04 §4.1), so ranking is
  // this page's job and needs no change to the primitive. Sorting on the canon
  // `name` rather than the title-cased label keeps the comparison on the one
  // string that cannot drift with presentation. Day one every count is zero, so
  // the tiebreak IS the ordering — already steadier than collection order.
  const comboItems = $derived(
    [...$canonItems]
      .sort(
        (a, b) =>
          ($purchaseCounts[b.id] ?? 0) - ($purchaseCounts[a.id] ?? 0) ||
          a.name.localeCompare(b.name),
      )
      .map((c) => ({ value: c.id, label: titleCase(c.name) })),
  );

  // Indexed, not scanned (issue #939). The combobox calls `filterFn` once per
  // candidate and the candidates ARE `$canonItems`, so a `.find` in there was
  // quadratic in canon size. It compounded: `Combobox.headless.svelte.ts` exposes
  // `filteredItems` (:272) and `showCreate` (:278) as plain getters rather than
  // `$derived`, and `computeShowCreate` (:82) and `totalCount` (:86) each call
  // `computeFilteredItems` again, so one keystroke re-filters several times over.
  // `canonIndex` is that index, shared with the recipe surfaces (issue #1055).
  const canonById = $derived(canonIndex($canonItems));

  function filterFn(input: string, comboItem: { value: string; label: string }): boolean {
    const q = input.trim().toLowerCase();
    if (!q) return true;
    const canon = canonById.get(comboItem.value);
    return (
      comboItem.label.toLowerCase().includes(q) ||
      (canon?.synonyms.some((s) => s.toLowerCase().includes(q)) ?? false)
    );
  }

  async function handleAddItem(): Promise<void> {
    const text = newItemText.trim();
    if (!text) return;
    addBusy = true;
    const result = await addItemToList(params.listId, text);
    addBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to add item.', 'destructive');
    } else if (newItemText.trim() === text) {
      newItemText = '';
      comboboxResetKey++;
      // Remounting the combobox drops focus; return it to the fresh input so the
      // user can keep adding items without re-tapping the field.
      await tick();
      addFieldEl?.querySelector('input')?.focus();
    }
  }

  function handleComboboxValueChange(id: string): void {
    const item = $canonItems.find((c) => c.id === id);
    if (!item) return;
    newItemText = item.name;
    void handleAddItem();
  }

  function handleComboboxCreate(text: string): void {
    newItemText = text;
    void handleAddItem();
  }

  // ─── Edit sheet ───────────────────────────────────────────────────────────────

  let editSheetOpen = $state(false);
  let editingItem = $state<ShoppingListItem | null>(null);
  let editRawText = $state('');
  let editAmount = $state('');
  let editUnit = $state('');
  let editNotes = $state('');
  let editNeedsCheck = $state(false);
  // Armed, not applied: a picked list is a pending choice until Save, so Cancel
  // abandons it exactly as it abandons a half-typed name (issue #694). Empty
  // string = stay on this list.
  let editTargetListId = $state('');
  let editBusy = $state(false);
  let editDeleteBusy = $state(false);

  function openEditSheet(item: ShoppingListItem): void {
    editingItem = item;
    editRawText = item.rawText;
    editAmount = item.amount !== undefined ? String(item.amount) : '';
    editUnit = item.unit ?? '';
    editNotes = item.notes;
    editNeedsCheck = item.needsCheck;
    editTargetListId = '';
    editSheetOpen = true;
  }

  async function handleEditSave(): Promise<void> {
    if (!editingItem) return;
    editBusy = true;
    const rawChanged = editRawText.trim() !== editingItem.rawText;
    const notesChanged = editNotes.trim() !== editingItem.notes;
    const parsedAmount = editAmount.trim() ? parseFloat(editAmount.trim()) : undefined;
    const parsedUnit = editUnit.trim() || undefined;
    const amountUnitChanged =
      parsedAmount !== editingItem.amount || parsedUnit !== editingItem.unit;
    const amount = Number.isNaN(parsedAmount) ? undefined : parsedAmount;

    // Armed move: the edits must ride along INSIDE the moved document, so they
    // are composed with the move into ONE write rather than issued as separate
    // per-field writes first. See moveItemWithEdits for why the naive order
    // silently loses them.
    if (editTargetListId) {
      const r = await moveItemWithEdits(params.listId, editTargetListId, editingItem.id, {
        rawText: editRawText,
        amount,
        unit: parsedUnit,
        notes: editNotes,
        needsCheck: editNeedsCheck,
      });
      editBusy = false;
      if (r.kind !== 'ok') {
        addToast('Failed to move item.', 'destructive');
        return;
      }
      editSheetOpen = false;
      return;
    }

    if (rawChanged) {
      const r = await updateItemRawText(params.listId, editingItem.id, editRawText);
      if (r.kind !== 'ok') {
        addToast('Failed to update item.', 'destructive');
        editBusy = false;
        return;
      }
    }
    if (amountUnitChanged) {
      const r = await updateItemAmountUnit(params.listId, editingItem.id, amount, parsedUnit);
      if (r.kind !== 'ok') {
        addToast('Failed to update quantity.', 'destructive');
        editBusy = false;
        return;
      }
    }
    if (notesChanged) {
      const r = await updateItemNotes(params.listId, editingItem.id, editNotes);
      if (r.kind !== 'ok') {
        addToast('Failed to update notes.', 'destructive');
        editBusy = false;
        return;
      }
    }
    if (editNeedsCheck !== editingItem.needsCheck) {
      const r = await setItemNeedsCheck(params.listId, editingItem.id, editNeedsCheck);
      if (r.kind !== 'ok') {
        addToast('Failed to update the check flag.', 'destructive');
        editBusy = false;
        return;
      }
    }
    editBusy = false;
    editSheetOpen = false;
  }

  function handleEditDelete(): void {
    if (!editingItem) return;
    // Route through the shared deferred-delete: hide the row now, close the sheet,
    // and only commit the real `removeItem` if the "…removed" undo toast lapses.
    const item = editingItem;
    const name = displayLabel(item);
    editSheetOpen = false;
    deferredDelete.request(
      [item.id],
      async () => {
        const result = await removeItem(params.listId, item.id);
        if (result.kind !== 'ok') addToast('Failed to delete item.', 'destructive');
      },
      { message: `"${name}" removed`, duration: SINGLE_ITEM_DELETE_MS },
    );
  }

  // Swipe-left delete on a single row (lively list, Phase 4). Deliberately the SAME
  // path as handleEditDelete — the shared `deferredDelete` instance, the same undo
  // message and window — so swipe adds a trigger, not a second delete mechanism. The
  // commit is the existing `removeItem`; Undo cancels it and nothing is ever deleted.
  function handleSwipeDelete(item: ShoppingListItem): void {
    const name = displayLabel(item);
    deferredDelete.request(
      [item.id],
      async () => {
        const result = await removeItem(params.listId, item.id);
        if (result.kind !== 'ok') addToast('Failed to delete item.', 'destructive');
      },
      { message: `"${name}" removed`, duration: SINGLE_ITEM_DELETE_MS },
    );
  }

  // ─── Bulk actions ─────────────────────────────────────────────────────────────

  let bulkBusy = $state(false);

  function handleBulkDelete(): void {
    if (selection.count === 0) return;
    const ids = selection.ids;
    // Hide immediately and leave selection mode; commit (or undo) when the toast resolves.
    selectionMode = false; // exiting selection mode clears the selection
    deferredDelete.request(ids, async (delIds) => {
      const result = await removeItems(params.listId, delIds);
      if (result.kind !== 'ok') addToast('Failed to delete items.', 'destructive');
    });
  }

  async function handleBulkCheck(): Promise<void> {
    if (selection.count === 0) return;
    bulkBusy = true;
    await checkItems(params.listId, [...selection.selected]);
    bulkBusy = false;
    selection.clear();
  }

  async function handleBulkUncheck(): Promise<void> {
    if (selection.count === 0) return;
    bulkBusy = true;
    await uncheckItems(params.listId, [...selection.selected]);
    bulkBusy = false;
    selection.clear();
  }

  async function handleMoveTo(targetListId: string): Promise<void> {
    if (selection.count === 0) return;
    bulkBusy = true;
    const ids = [...selection.selected];
    const result = await moveSelectedItems(params.listId, targetListId, ids);
    bulkBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to move items.', 'destructive');
    } else {
      selectionMode = false;
    }
  }

  async function handleClearChecked(): Promise<void> {
    const result = await clearChecked(params.listId);
    if (result.kind !== 'ok') addToast('Failed to clear checked items.', 'destructive');
  }

  // Contextual bottom action bar, supplied to ListPage. The template owns the bar
  // chrome, the move picker sheet, and the BottomNav takeover.
  const bulkActions = $derived<BulkAction[]>([
    {
      id: 'check',
      label: 'Check',
      icon: 'CircleCheck',
      disabled: bulkBusy,
      testId: 'shopping-bulk-check',
      onSelect: () => void handleBulkCheck(),
    },
    {
      id: 'uncheck',
      label: 'Uncheck',
      icon: 'Circle',
      disabled: bulkBusy,
      testId: 'shopping-bulk-uncheck',
      onSelect: () => void handleBulkUncheck(),
    },
    {
      kind: 'picker',
      id: 'move',
      label: 'Move',
      icon: 'FolderInput',
      disabled: bulkBusy || otherLists.length === 0,
      testId: 'shopping-bulk-move-select',
      sheetTitle: `Move ${selection.count} item${selection.count === 1 ? '' : 's'} to…`,
      targets: otherLists.map((l) => ({ id: l.id, label: l.name })),
      optionTestId: 'shopping-bulk-move-option',
      onPick: (id) => void handleMoveTo(id),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      variant: 'destructive',
      disabled: bulkBusy,
      testId: 'shopping-bulk-delete',
      onSelect: handleBulkDelete,
    },
  ]);

  // ─── Item row helper ──────────────────────────────────────────────────────────
  // The row itself lives in `ShoppingItemRow.svelte`; what stays here is what the
  // COMBINED row and the edit sheet also read.

  // Label a single row, title-cased: the user's / recipe's wording with the
  // amount, unit and context the parser lifts out removed ("1 whole chicken" →
  // "Whole Chicken"), so it reads as the item without the quantity that's shown
  // separately, and without collapsing to the leaner canon name ("Chicken").
  // Combined aggregate rows label by canon name instead — see rowLabel.
  function displayLabel(item: ShoppingListItem): string {
    return titleCase(resolveItemDisplayName(item));
  }

  // ─── Check off ────────────────────────────────────────────────────────────────
  // The write goes first, every time. `begin` only holds the row's PLACE while the
  // outro plays — it never gates, delays or batches the write, so a tab close or
  // an offline drop mid-animation still records the check.

  function handleToggleChecked(item: ShoppingListItem): void {
    // Already leaving: a second tap on a row mid-outro would toggle it back on a
    // stale `checked` (the held copy reads false by design), so ignore it.
    if (checkOffHold.isExiting(item.id)) return;
    // Unchecking stays instant — undoing a mistake shouldn't be ceremonial.
    if (!item.checked) checkOffHold.begin([item.id]);
    void toggleItemChecked(params.listId, item);
  }

  // ─── Verify flag (recipe-add "check" items, #185) ───────────────────────────
  // A flagged item is highlighted with a quick confirm/drop affordance so the
  // shopper can resolve it without opening the edit sheet. The controls act on a
  // set of ids: a single item, or the flagged contributors of a combined row.
  function needsVerify(item: ShoppingListItem): boolean {
    return item.needsCheck && !item.checked;
  }

  async function handleConfirmNeeded(ids: readonly string[]): Promise<void> {
    const [singleId] = ids;
    if (ids.length === 1 && singleId !== undefined) {
      const result = await confirmItemNeeded(params.listId, singleId);
      if (result.kind !== 'ok') addToast('Failed to update item.', 'destructive');
      return;
    }
    await confirmItemsNeeded(params.listId, ids);
  }

  // The row's displayed label for a given id (title-cased resolved name), resolved
  // from the live list BEFORE the id is hidden so the toast reads the same name the
  // row showed. Falls back to a neutral label if the id has already gone.
  function itemDisplayName(id: string): string {
    const item = $itemsForActiveList.find((i) => i.id === id);
    return item ? displayLabel(item) : 'Item';
  }

  function handleDropNeeded(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const list = [...ids];
    // Single drop reads as the named item; a combined row's multiple flagged
    // contributors drop as one "N items removed" (same "removed" verb as the single
    // case), commit + undo as a unit.
    const [first] = list;
    const message =
      list.length === 1 && first !== undefined
        ? `"${itemDisplayName(first)}" removed`
        : `${list.length} items removed`;
    deferredDelete.request(
      list,
      async (delIds) => {
        const result = await removeItems(params.listId, delIds);
        if (result.kind !== 'ok') addToast('Failed to remove item.', 'destructive');
      },
      { message, duration: SINGLE_ITEM_DELETE_MS },
    );
  }

  // ─── Aisle rows (combining, #184) ───────────────────────────────────────────
  // A combined row stands for several recipe contributions of the same canon.
  // Tapping it reveals the per-contributor breakdown; row-level actions act on
  // all contributors.
  let expandedRows = $state(new Set<string>());

  function toggleRow(key: string): void {
    const next = new Set(expandedRows);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedRows = next;
  }

  function rowLabel(row: AisleRow): string {
    if (row.combined) return titleCase(canonMap.get(row.canonId)?.name ?? '');
    const first = row.contributors[0];
    return first ? displayLabel(first) : '';
  }

  function formatSubtotals(subtotals: readonly AmountSubtotal[]): string | null {
    if (subtotals.length === 0) return null;
    return subtotals.map((s) => (s.unit ? `${s.amount} ${s.unit}` : `${s.amount}`)).join(' + ');
  }

  // The single merged product-form parent count for a combined row, or null when
  // the row isn't a pure product-form-parent row (issue #501). Non-null → render
  // "Canon ×N" (the domain-aggregated Σwhole + MAXforms count), mirroring the
  // single product-form row's ×N treatment instead of a mixed-unit subtotal.
  function countSubtotal(row: AisleRow): AmountSubtotal | null {
    const [only] = row.subtotals;
    return row.subtotals.length === 1 && only && only.unit === 'count' ? only : null;
  }

  // Distinct original wordings across a combined row's contributors, surfaced
  // under the "Canon ×N" headline so what the count is for isn't buried in the
  // expand-only breakdown. Prefers each contributor's OWN recipe wording (issue
  // #528) — "juice of 2 limes, zest of 1 lime" rather than the cleaned-name
  // "Lime Juice, Zest, Limes", which named the forms but not the amounts behind
  // them. Rendered verbatim, exactly as the review sheet shows the same lines.
  // Falls back PER CONTRIBUTOR to today's title-cased cleaned name, so items
  // written before the field keep their existing wording and a row mixing old and
  // new contributors still reads sensibly.
  function formWordings(row: AisleRow): string {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of row.contributors) {
      const wordings = c.originalText?.length
        ? c.originalText
        : [titleCase(resolveItemDisplayName(c))];
      for (const name of wordings) {
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return names.join(', ');
  }

  function rowIds(row: AisleRow): string[] {
    return row.contributors.map((c) => c.id);
  }

  function flaggedIds(row: AisleRow): string[] {
    return row.contributors.filter((c) => c.needsCheck).map((c) => c.id);
  }

  // A combined row checks off as the single unit it already renders as: every
  // contributor is written at once and held at once, so the row celebrates once.
  function markRowDone(row: AisleRow): void {
    const ids = rowIds(row);
    if (ids.some((id) => checkOffHold.isExiting(id))) return;
    checkOffHold.begin(ids);
    void checkItems(params.listId, ids);
  }

  // A recipe's name only becomes a tap target while the recipe is still there.
  // `sources[].label` is a snapshot taken at add time and a shopping list
  // routinely outlives the dish it came from, so the name has to fall back to
  // plain text rather than link to a dead page. The check is free: `initRecipeSync()`
  // already subscribes the `recipes` store app-wide (App.svelte), so this is one
  // lookup and no new Firestore read.
  const liveRecipeIds = $derived(new Set($recipes.map((r) => r.id)));

  // Navigation is a `push()` on a <button>, exactly as the planner's day-sheet
  // recipe rows do it (MealDayDetail.openRecipe). There is not a single <a href>
  // in this app and this feature does not introduce the first one.
  function openRecipe(id: string): void {
    push(`/recipes/${id}`);
  }

  // `describeSource` moved to `lib/shoppingSource.ts` (issue #933) — the row had
  // its own second answer, and the two disagreed about a hand-added item with no
  // attributed adder.
</script>

{#snippet verifyControls(ids: string[])}
  <div class="flex items-center gap-2" data-testid="shopping-verify">
    <span class="text-xs font-medium text-amber-600 dark:text-amber-500">Need it?</span>
    <button
      type="button"
      class="salt-press-pulse flex h-10 w-10 items-center justify-center rounded-md text-amber-600 transition-[color,background-color,transform] [transition-duration:var(--duration-fast),var(--duration-fast),var(--duration-base)] ease-standard motion-reduce:transition-none hover:bg-amber-100 dark:text-amber-500 dark:hover:bg-amber-950"
      onclick={() => {
        // Confirming is the other tap that means "yes, this" — same tick as a check.
        hapticTick();
        void handleConfirmNeeded(ids);
      }}
      aria-label="Confirm needed"
      data-testid="shopping-verify-confirm"
    >
      <Icon name="Check" size={20} />
    </button>
    <button
      type="button"
      class="salt-press-pulse flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] [transition-duration:var(--duration-fast),var(--duration-fast),var(--duration-base)] ease-standard motion-reduce:transition-none hover:bg-accent hover:text-foreground"
      onclick={() => void handleDropNeeded(ids)}
      aria-label="Not needed, remove"
      data-testid="shopping-verify-drop"
    >
      <Icon name="X" size={20} />
    </button>
  </div>
{/snippet}

<!-- Every plain row on the page renders through here, so the row component's
     prop wiring lives in exactly one place. `exiting` is the only new argument:
     the hold that keeps a just-checked row in this group while it celebrates. -->
{#snippet itemRow(
  item: ShoppingListItem,
  pending: boolean,
  subordinate = false,
  showSource = false,
  revealRole: 'send' | 'receive' | 'none' = 'none',
)}
  <ShoppingItemRow
    {item}
    {pending}
    {subordinate}
    {showSource}
    exiting={checkOffHold.isExiting(item.id)}
    revealing={matchReveal.isRevealing(item.id)}
    {revealRole}
    isRevealing={(id) => matchReveal.isRevealing(id)}
    {selectionMode}
    {selection}
    {canonMap}
    {thumbnailFor}
    {iconVersionFor}
    {verifyControls}
    onEdit={openEditSheet}
    onToggleChecked={handleToggleChecked}
    onDelete={handleSwipeDelete}
  />
{/snippet}

{#if !$isLoadingShoppingList && currentList === null}
  <div class="p-4 sm:p-6 flex flex-col gap-3">
    <p class="text-sm text-muted-foreground">List not found.</p>
    <Button variant="outline" onclick={() => push('/shopping')}>Go to shopping</Button>
  </div>
{:else}
  <ListPage
    title={currentList?.name ?? 'Shopping list'}
    isLoading={$isLoadingShoppingList}
    {isEmpty}
    bind:selectionMode
    selectionCount={selection.count}
    {bulkActions}
    class="p-4 sm:p-6"
    data-testid="shopping-list-page"
  >
    {#snippet actions()}
      {#if hasVerifyItems}
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-md h-8 px-2 text-xs font-medium transition-colors {verifyFilterActive
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
            : 'text-amber-600 hover:bg-amber-50 dark:text-amber-500 dark:hover:bg-amber-950/40'}"
          onclick={() => (verifyFilterActive = !verifyFilterActive)}
          aria-pressed={verifyFilterActive}
          aria-label={verifyFilterActive ? 'Show all items' : 'Show only items to verify'}
          data-testid="shopping-verify-filter"
        >
          <Icon name="ListFilter" size={14} />
          {verifyItems.length}
        </button>
      {/if}
      <Popover bind:open={overflowMenuOpen}>
        <PopoverTrigger>
          {#snippet children()}
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-md h-8 w-8 text-foreground hover:bg-accent hover:text-accent-foreground"
              data-testid="shopping-overflow-btn"
              aria-label="List options"
            >
              <Icon name="EllipsisVertical" size={16} />
            </button>
          {/snippet}
        </PopoverTrigger>
        <PopoverContent align="end" class="p-1 min-w-52">
          <p class="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Sort by
          </p>
          <PopoverMenuItem
            icon="Check"
            iconVisible={sortMode === 'aisle'}
            onclick={() => selectSortMode('aisle')}
            data-testid="shopping-sort-aisle"
          >
            Aisle
          </PopoverMenuItem>
          <PopoverMenuItem
            icon="Check"
            iconVisible={sortMode === 'recipe'}
            onclick={() => selectSortMode('recipe')}
            data-testid="shopping-sort-recipe"
          >
            Recipe
          </PopoverMenuItem>
          <div class="my-1 h-px bg-border"></div>
          <PopoverMenuItem
            icon="LayoutList"
            onclick={() => {
              overflowMenuOpen = false;
              push('/shopping/lists');
            }}
            data-testid="shopping-lists-btn"
          >
            Manage lists
          </PopoverMenuItem>
        </PopoverContent>
      </Popover>
    {/snippet}

    {#snippet titleSlot()}
      {#if $lists.length > 1}
        <Popover bind:open={listSwitcherOpen}>
          <PopoverTrigger>
            {#snippet children()}
              <button
                type="button"
                class="flex items-center gap-1 text-xl font-semibold tracking-tight text-foreground hover:opacity-75"
                data-testid="shopping-list-title-btn"
                aria-label="Switch list"
              >
                {currentList?.name ?? 'Shopping list'}
                <Icon name="ChevronDown" size={14} class="text-muted-foreground" />
              </button>
            {/snippet}
          </PopoverTrigger>
          <PopoverContent align="start" class="p-1 min-w-40">
            {#each $lists as list (list.id)}
              <PopoverMenuItem
                selected={list.id === params.listId}
                onclick={() => {
                  listSwitcherOpen = false;
                  push(`/shopping/${list.id}`);
                }}
                data-testid="shopping-list-picker-option"
              >
                {list.name}
              </PopoverMenuItem>
            {/each}
          </PopoverContent>
        </Popover>
      {:else}
        <h1 class="text-xl font-semibold tracking-tight text-foreground">
          {currentList?.name ?? 'Shopping list'}
        </h1>
      {/if}

      <!-- Shop day (issue #629). It rides in `titleSlot` rather than ListPage's
           `description` prop because `description` is a plain string: it cannot
           carry the cart mark or the tap target that opens the planner week.
           ListPage wraps this slot in a `flex-col gap-1`, so it simply stacks
           under the list name. Kept OUT of the `actions()` row deliberately —
           that row's width budget swings with the verify filter, so a mark there
           fits or wraps depending on list state rather than on design. -->
      {#if isDefault && shopHeadline}
        <button
          type="button"
          class="flex items-center gap-1.5 text-left text-sm text-muted-foreground hover:opacity-75"
          onclick={() => push(shopHref)}
          aria-label={`${shopHeadline} — open the meal plan`}
          data-testid="shopping-shop-day"
        >
          <Icon name="ShoppingCart" size={13} class="shrink-0" />
          <span class="font-semibold {shopUrgent ? 'text-destructive' : 'text-foreground'}">
            {shopHeadline}
          </span>
        </button>
      {/if}
    {/snippet}

    {#snippet toolbar()}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex-1"
        bind:this={addFieldEl}
        oninput={(e) => {
          newItemText = (e.target as HTMLInputElement).value;
        }}
      >
        {#key comboboxResetKey}
          <Combobox
            items={comboItems}
            allowCustom={true}
            openOnClick={false}
            {filterFn}
            onValueChange={handleComboboxValueChange}
            onCreate={handleComboboxCreate}
            placeholder="Add an item…"
          >
            <ComboboxField class="w-full">
              <ComboboxInput data-testid="shopping-item-input" />
            </ComboboxField>
            <ComboboxContent>
              {#snippet children({ filteredItems, showCreate })}
                {#each filteredItems as item, i (item.value)}
                  <ComboboxItem {item} index={i} />
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
        {/key}
      </div>
      <Button
        onclick={handleAddItem}
        loading={addBusy}
        disabled={!newItemText.trim() || addBusy}
        data-testid="shopping-item-add-btn"
      >
        Add
      </Button>
    {/snippet}

    {#snippet selectionBar()}
      <SelectAllCheckbox {selection} />
    {/snippet}

    {#snippet empty()}
      <EmptyState title="Your list is empty" description="Add items above to get started." />
    {/snippet}

    {#snippet children()}
      <div class="flex flex-col gap-4" data-testid="shopping-list-content">
        {#if sortMode === 'aisle'}
          <!-- Aisle groups -->
          {#each grouped.aisles as aisleGroup (aisleGroup.aisleId)}
            {@const aisleCollapsed = collapsedAisles.has(aisleGroup.aisleId)}
            <CollapsibleSection
              title={aisleGroup.aisleName}
              expanded={!aisleCollapsed}
              onToggle={() => toggleAisle(aisleGroup.aisleId)}
              collapsedCount={aisleGroup.rows.length}
              triggerTestId="shopping-aisle-toggle"
              data-testid="shopping-aisle-group"
              data-aisle-id={aisleGroup.aisleId}
            >
              {#each aisleGroup.rows as row (row.key)}
                {@const amountStr = formatSubtotals(row.subtotals)}
                {#if row.combined}
                  {@const expanded = expandedRows.has(row.key)}
                  {@const count = countSubtotal(row)}
                  <!-- A combined row celebrates as ONE unit — which is how it
                         already behaves — so the whole aggregate is exiting once
                         any contributor is held. Same shell and same button as
                         ShoppingItemRow; only the row's own content differs. -->
                  {@const rowExiting = row.contributors.some((c) => checkOffHold.isExiting(c.id))}
                  <!-- No `out:collapseOut` / `in:riseIn` here, unlike
                       ShoppingItemRow's own root: the combined row collapses by
                       CSS class alone. #930 rules that asymmetry deliberate and
                       out of its scope; it is why the shell is shared as class
                       strings and not as a component (see shoppingRowShell.ts). -->
                  <div class={shoppingRowCollapseClass(rowExiting)}>
                    <div class={SHOPPING_ROW_INNER_CLASS}>
                      <div
                        class={shoppingRowClass({
                          exiting: rowExiting,
                          needsVerify: row.needsCheck,
                        })}
                        data-testid="shopping-item-row"
                        data-combined="true"
                        data-canon-id={row.canonId}
                      >
                        <!-- A combined row always stands for a matched canon, so its
                               bare tile reads sage too (matched); it is never itself a
                               reveal target, so no shimmer. -->
                        <CanonIcon
                          thumbnail={thumbnailFor(row.canonId)}
                          name={rowLabel(row)}
                          size={40}
                          version={iconVersionFor(row.canonId)}
                          matched={true}
                        />
                        <DisclosureTrigger
                          {expanded}
                          class="flex-1 min-w-0 text-left"
                          onclick={() => toggleRow(row.key)}
                          data-testid="shopping-combined-toggle"
                        >
                          {#if count}
                            <span class="block truncate">
                              {rowLabel(row)}{' '}<span class="text-muted-foreground"
                                >×{count.amount}</span
                              >
                            </span>
                            <span
                              class="flex items-center gap-1 text-xs text-muted-foreground/70 truncate"
                            >
                              <DisclosureChevron {expanded} size={12} />
                              {formWordings(row)}
                            </span>
                          {:else}
                            <span class="block truncate">
                              {rowLabel(row)}{#if amountStr}{' '}<span class="text-muted-foreground"
                                  >({amountStr})</span
                                >{/if}
                            </span>
                            <span class="flex items-center gap-1 text-xs text-muted-foreground/70">
                              <DisclosureChevron {expanded} size={12} />
                              {row.contributors.length} recipes
                            </span>
                          {/if}
                        </DisclosureTrigger>
                        {#if row.needsCheck && !rowExiting}
                          {@render verifyControls(flaggedIds(row))}
                        {:else}
                          <!-- Always `checked={false}`: a combined row exists only
                             while its contributors are unchecked — checking it
                             dissolves it into the Checked section. -->
                          <CheckOffButton
                            checked={false}
                            exiting={rowExiting}
                            onSelect={() => markRowDone(row)}
                          />
                        {/if}
                      </div>
                    </div>
                  </div>
                  {#if expanded}
                    <div class="flex flex-col gap-1 pb-1" data-testid="shopping-combined-breakdown">
                      {#each row.contributors as c (c.id)}
                        {@render itemRow(c, false, true, true)}
                      {/each}
                    </div>
                  {/if}
                {:else}
                  {@const single = row.contributors[0]}
                  {#if single}
                    <!-- A resolved aisle row is the *receive* half of the match
                           reveal: when its id's match just landed (the reveal gate is
                           open), the row rises in here — otherwise it mounts as an
                           instant snap like any other row. -->
                    {@render itemRow(single, false, false, true, 'receive')}
                  {/if}
                {/if}
              {/each}
            </CollapsibleSection>
          {/each}

          <!-- Other (pending / failed / no-aisle items) -->
          {#if grouped.other.contributors.length > 0}
            <section class="flex flex-col gap-1" data-testid="shopping-other">
              <div class="flex items-center gap-2 mb-1">
                <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Other
                </p>
                {#if grouped.other.contributors.some((c) => c.isPending)}
                  <Spinner size={12} />
                {/if}
              </div>
              <!-- An "Other" row is the *send* half of the match reveal: the instant
                   its match lands it collapses out of this bucket while its aisle
                   copy rises in. Any other unmount (a delete, a check-off) sees the
                   reveal gate closed → an instant snap. -->
              {#each grouped.other.contributors as { item, isPending } (item.id)}
                {@render itemRow(item, isPending, false, false, 'send')}
              {/each}
            </section>
          {/if}
        {:else}
          <!-- Recipe groups -->
          {#each recipeGrouped.recipes as recipeGroup (recipeGroup.recipeId)}
            <section
              class="flex flex-col gap-1"
              data-testid="shopping-recipe-group"
              data-recipe-id={recipeGroup.recipeId}
            >
              {#if liveRecipeIds.has(recipeGroup.recipeId)}
                <!-- The heading keeps its own small-caps muted type; all it
                     borrows from the `link` variant is the affordance — the
                     hover underline, the press pulse and the focus ring. A
                     shouting blue heading over every section would be a worse
                     list than no link at all. `self-start` keeps the target the
                     width of the words rather than the width of the section. -->
                <Button
                  variant="link"
                  size="sm"
                  class="h-auto justify-start self-start px-0 py-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
                  onclick={() => openRecipe(recipeGroup.recipeId)}
                  data-testid="shopping-recipe-group-link"
                >
                  {recipeGroup.recipeName}
                </Button>
              {:else}
                <p
                  class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1"
                >
                  {recipeGroup.recipeName}
                </p>
              {/if}
              {#each recipeGroup.items as item (item.id)}
                {@render itemRow(item, item.matchState === 'pending')}
              {/each}
            </section>
          {/each}

          <!-- Manual items -->
          {#if recipeGrouped.manual.items.length > 0}
            <section class="flex flex-col gap-1" data-testid="shopping-manual-group">
              <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                Manual
              </p>
              {#each recipeGrouped.manual.items as item (item.id)}
                {@render itemRow(item, item.matchState === 'pending')}
              {/each}
            </section>
          {/if}
        {/if}

        <!-- Checked items. The same CollapsibleSection as the aisle groups above
             (ui-spec-v09 §8.25) — it carries its count IN the title rather than
             via `collapsedCount`, because "Checked (12)" reads at all times
             while an aisle only names its size once folded away. -->
        {#if grouped.checked.contributors.length > 0}
          <CollapsibleSection
            title={`Checked (${grouped.checked.contributors.length})`}
            expanded={!checkedCollapsed}
            onToggle={() => (checkedCollapsed = !checkedCollapsed)}
            triggerTestId="shopping-checked-toggle"
            data-testid="shopping-checked"
          >
            {#snippet action()}
              <Button
                variant="outline"
                size="sm"
                onclick={handleClearChecked}
                data-testid="shopping-clear-checked"
              >
                Clear checked
              </Button>
            {/snippet}
            {#each grouped.checked.contributors as item (item.id)}
              {@render itemRow(item, false)}
            {/each}
          </CollapsibleSection>
        {/if}
      </div>
    {/snippet}
  </ListPage>
{/if}

<!-- Edit item sheet -->
<Sheet
  bind:open={editSheetOpen}
  side="bottom"
  onOpenChange={(v) => {
    if (!v) {
      editingItem = null;
    }
  }}
>
  <!-- Opts OUT of the bottom variant's 85vh ceiling, deliberately: this sheet
       has never had one, and the combobox listbox that portals into it (below)
       needs the room. Explicit rather than silent — #930 moved the ceiling into
       the primitive, and this is the one site it must not reach.

       `max-h-[none]`, not `max-h-none`: tailwind-merge v3 does not list `none`
       in the max-height group (it does for max-width), so the plain utility
       arrives ALONGSIDE the variant's `max-h-[85vh]` rather than replacing it,
       and which one wins is then down to stylesheet order. The arbitrary form
       merges correctly. Pinned by `Sheet.test.ts` → "a caller can still opt out
       of the ceiling". -->
  <SheetContent class="flex max-h-[none] flex-col gap-4">
    <SheetHeader>
      <div class="flex items-center gap-3">
        {#if editingItem}
          <CanonIcon
            thumbnail={thumbnailFor(editingItem.canonId)}
            name={displayLabel(editingItem)}
            size={64}
            version={iconVersionFor(editingItem.canonId)}
          />
        {/if}
        <SheetTitle>Edit item</SheetTitle>
      </div>
    </SheetHeader>

    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <label class="text-sm font-medium" for="edit-item-rawtext">Item</label>
        <TextField
          id="edit-item-rawtext"
          bind:value={editRawText}
          placeholder="What do you need?"
          disabled={editBusy}
          data-testid="shopping-edit-rawtext"
        />
      </div>
      <div class="flex gap-3">
        <div class="flex flex-col gap-1.5 w-24">
          <label class="text-sm font-medium" for="edit-item-amount">Quantity</label>
          <TextField
            id="edit-item-amount"
            bind:value={editAmount}
            placeholder="e.g. 2"
            inputmode="decimal"
            disabled={editBusy}
            data-testid="shopping-edit-amount"
          />
        </div>
        <div class="flex flex-col gap-1.5 flex-1">
          <label class="text-sm font-medium" for="edit-item-unit">Unit</label>
          <TextField
            id="edit-item-unit"
            bind:value={editUnit}
            placeholder="e.g. kg"
            disabled={editBusy}
            data-testid="shopping-edit-unit"
          />
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <label class="text-sm font-medium" for="edit-item-notes">Notes</label>
        <Textarea
          id="edit-item-notes"
          bind:value={editNotes}
          placeholder="Any notes…"
          disabled={editBusy}
          rows={3}
          data-testid="shopping-edit-notes"
        />
      </div>
      <!--
        The amber "Need it?" flag (#185), raised and cleared from here (#694).
        Disabled on an already-checked item: `needsVerify` is needsCheck && !checked,
        so flagging one would change nothing the shopper could see.
      -->
      <div data-testid="shopping-edit-needs-check">
        <Switch
          bind:checked={editNeedsCheck}
          disabled={editBusy || (editingItem?.checked ?? false)}
          label="Need to check"
          description="Ask whoever shops to confirm we need this before buying."
        />
      </div>
      <!--
        Which list the item is on (#694). Absent when there is nowhere to move it.
        The listbox portals into this SheetContent by default since #691 — do not
        add a portal prop or a marker class.
      -->
      {#if otherLists.length > 0}
        <div class="flex flex-col gap-1.5">
          <span class="text-sm font-medium">List</span>
          <Select
            value={editTargetListId}
            onValueChange={(v) => (editTargetListId = v)}
            disabled={editBusy}
          >
            <SelectTrigger data-testid="shopping-edit-move-select">
              {otherLists.find((l) => l.id === editTargetListId)?.name ??
                currentList?.name ??
                'This list'}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{currentList?.name ?? 'This list'}</SelectItem>
              {#each otherLists as list (list.id)}
                <SelectItem value={list.id}>{list.name}</SelectItem>
              {/each}
            </SelectContent>
          </Select>
        </div>
      {/if}
      {#if editingItem && editingItem.sources.length > 0}
        <div class="flex flex-col gap-1.5" data-testid="shopping-edit-sources">
          <span class="text-sm font-medium">Sources</span>
          <ul class="flex flex-col gap-1">
            {#each editingItem.sources as src, i (i)}
              {@const source = describeSource(src)}
              <li class="text-sm text-muted-foreground">
                {#if source.kind === 'recipe' && liveRecipeIds.has(source.recipeId)}
                  <!-- Name links, servings do not. The sheet has the room the
                       list does not, so this target gets the full 44px. -->
                  <span class="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="link"
                      size="sm"
                      class="h-auto min-h-11 px-0 text-sm font-normal"
                      onclick={() => openRecipe(source.recipeId)}
                      data-testid="shopping-edit-source-link"
                    >
                      {source.name}
                    </Button>
                    <span>{source.servings}</span>
                  </span>
                {:else if source.kind === 'recipe'}
                  {source.name} {source.servings}
                {:else}
                  {source.text}
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <SheetFooter class="flex justify-between">
      <Button
        variant="destructive"
        size="sm"
        onclick={handleEditDelete}
        loading={editDeleteBusy}
        disabled={editBusy || editDeleteBusy}
        data-testid="shopping-edit-delete"
      >
        Delete
      </Button>
      <div class="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onclick={() => (editSheetOpen = false)}
          disabled={editBusy || editDeleteBusy}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onclick={handleEditSave}
          loading={editBusy}
          disabled={editBusy || editDeleteBusy || !editRawText.trim()}
          data-testid="shopping-edit-save"
        >
          Save
        </Button>
      </div>
    </SheetFooter>
  </SheetContent>
</Sheet>
