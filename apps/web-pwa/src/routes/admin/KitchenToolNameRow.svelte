<script lang="ts">
  import {
    Icon,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
  } from '@salt/ui-components';

  /**
   * One phrase a kitchen tool answers to, on a line of its own (issue #1489).
   *
   * ONE COMPONENT, TWO PLACES. The same list of names is shown under an expanded
   * list row and inside the editor's "Also called" section, and each line carries
   * the same three verbs. Writing that twice is how the two copies drift, so this
   * is the shopping list's `subordinate` idiom (indented, no icon,
   * `ShoppingItemRow.svelte:53`) as a component rather than as a class string —
   * it has behaviour of its own, which is the line #930 drew.
   *
   * THE VERBS ARE IN A MENU, not three buttons on the row. Three labelled buttons
   * on a nested row do not fit a phone, and three more bare glyphs is the exact
   * complaint this work exists to fix; ui-spec-v14 §8.33 was written for a row
   * that needs several named actions. They are ordered cheapest first: moving a
   * word between tools costs nothing, promoting it spends one Gemini image, and
   * the label says so rather than a confirmation asking.
   *
   * `testidPrefix` is not decoration. On a wide screen the expanded row and the
   * docked editor are on screen at once, so a shared id would resolve twice; each
   * site names its own copy.
   */
  let {
    phrase,
    toolLabel,
    testidPrefix,
    onPromote,
    onMove,
    onRemove,
  }: {
    phrase: string;
    /** The tool this phrase hangs off — for the menu's accessible name. */
    toolLabel: string;
    testidPrefix: string;
    /** Mint a tool of its own for this phrase. Spends one image. */
    onPromote: (phrase: string) => void;
    /** Hand this phrase to a different tool. Costs nothing. */
    onMove: (phrase: string) => void;
    onRemove: (phrase: string) => void;
  } = $props();

  let menuOpen = $state(false);
</script>

<li
  class="flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5"
  data-testid="{testidPrefix}-row"
  data-kit-matcher={phrase}
>
  <span class="min-w-0 flex-1 truncate text-sm">{phrase}</span>
  <Popover bind:open={menuOpen}>
    <PopoverTrigger>
      {#snippet children()}
        <button
          type="button"
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Actions for “{phrase}” under {toolLabel}"
          data-testid="{testidPrefix}-menu"
        >
          <Icon name="EllipsisVertical" size={16} />
        </button>
      {/snippet}
    </PopoverTrigger>
    <PopoverContent align="end" class="min-w-56 p-1">
      <PopoverMenuItem
        icon="ArrowRight"
        onclick={() => {
          menuOpen = false;
          onMove(phrase);
        }}
        data-testid="{testidPrefix}-move"
      >
        Move to another tool…
      </PopoverMenuItem>
      <PopoverMenuItem
        icon="ImagePlus"
        onclick={() => {
          menuOpen = false;
          onPromote(phrase);
        }}
        data-testid="{testidPrefix}-promote"
      >
        Give it its own picture — draws a new one
      </PopoverMenuItem>
      <div class="my-1 h-px bg-border"></div>
      <PopoverMenuItem
        icon="Trash2"
        variant="destructive"
        onclick={() => {
          menuOpen = false;
          onRemove(phrase);
        }}
        data-testid="{testidPrefix}-remove"
      >
        Remove
      </PopoverMenuItem>
    </PopoverContent>
  </Popover>
</li>
