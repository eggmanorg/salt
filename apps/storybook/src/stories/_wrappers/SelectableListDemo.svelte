<!-- Composition wrapper for SelectableList.stories.ts. SelectableList is generic
     (<T extends {id}>) and driven by a runes `ListSelection` controller built with
     the `createListSelection` factory, plus a required `row` Snippet — none of which
     a single `component` + `args` can express. The wrapper fixes a concrete item
     type, builds the controller with the story's selection-mode flag, and pre-selects
     a couple of rows so the checked/ring state is visible in a static snapshot. The
     controller's own $effect clears the selection whenever selection mode is off, so
     the NonSelectable story shows plain rows. Rule 7: only @salt/ui-components. -->
<script lang="ts">
  import { SelectableList, SelectAllCheckbox, createListSelection } from '@salt/ui-components';

  let { selectionMode = true }: { selectionMode?: boolean } = $props();

  type Item = { id: string; label: string; aisle: string };
  const items: Item[] = [
    { id: 'tomatoes', label: 'Tinned tomatoes', aisle: 'Pantry' },
    { id: 'oil', label: 'Olive oil', aisle: 'Pantry' },
    { id: 'rice', label: 'Basmati rice', aisle: 'Pantry' },
    { id: 'eggs', label: 'Free-range eggs', aisle: 'Chilled' },
  ];

  const selection = createListSelection({
    getAllIds: () => items.map((i) => i.id),
    isSelectionMode: () => selectionMode,
  });

  // Pre-select a subset so the selected state renders in the static snapshot.
  // (Cleared automatically by the controller when selection mode is off.)
  selection.add(['tomatoes', 'rice']);
</script>

<div class="flex w-full max-w-md flex-col gap-2">
  {#if selectionMode}
    <div class="px-1">
      <SelectAllCheckbox {selection} />
    </div>
  {/if}
  <SelectableList {items} {selection}>
    {#snippet row(item, { selected })}
      <div class="flex items-center justify-between gap-3">
        <span
          class={selected ? 'text-sm font-semibold text-foreground' : 'text-sm text-foreground'}
        >
          {item.label}
        </span>
        <span class="text-xs text-muted-foreground">{item.aisle}</span>
      </div>
    {/snippet}
  </SelectableList>
</div>
