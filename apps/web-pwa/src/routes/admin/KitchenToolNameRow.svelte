<script lang="ts">
  import { Button } from '@salt/ui-components';

  /**
   * One phrase a kitchen tool answers to, on a line of its own (issue #1489).
   *
   * ONE COMPONENT, TWO PLACES. The same list of names is shown under an expanded
   * list row and inside the editor's "Also called" section, and from Phase 2 each
   * line carries a menu of three verbs. Writing that twice is how the two copies
   * drift, so this is the shopping list's `subordinate` idiom (indented, no icon,
   * `ShoppingItemRow.svelte:53`) as a component rather than as a class string —
   * it has behaviour of its own, which is the line #930 drew.
   *
   * `testidPrefix` is not decoration. On a wide screen the expanded row and the
   * docked editor are on screen at once, so a shared id would resolve twice; each
   * site names its own copy.
   */
  let {
    phrase,
    toolLabel,
    testidPrefix,
    onRemove,
  }: {
    phrase: string;
    /** The tool this phrase hangs off — for the action's accessible name. */
    toolLabel: string;
    testidPrefix: string;
    onRemove: (phrase: string) => void;
  } = $props();
</script>

<li
  class="flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5"
  data-testid="{testidPrefix}-row"
  data-kit-matcher={phrase}
>
  <span class="min-w-0 flex-1 truncate text-sm">{phrase}</span>
  <Button
    variant="ghost"
    size="sm"
    onclick={() => onRemove(phrase)}
    data-testid="{testidPrefix}-remove"
    ariaLabel="Remove “{phrase}” from {toolLabel}"
  >
    Remove
  </Button>
</li>
