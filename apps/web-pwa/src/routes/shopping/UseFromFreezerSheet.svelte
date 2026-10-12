<!--
  Use from the freezer (issue #1685) — which bag, and how many packs, for one
  shopping row. Opened from a row's "in the freezer" line; the page does the
  write (`useFromFreezer`), so this sheet knows nothing about lists, recipes or
  Firestore. It hands back a bag number and a whole number of packs.

  Taking the last packs removes the entry. The sheet says so
  before confirming: that notice IS the "remove it?" question #1684's page asks
  after a −1, so there is no second dialog.
-->
<script lang="ts">
  import {
    Button,
    Icon,
    RadioGroup,
    RadioGroupItem,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { displayAmount, type FreezerItem } from '@salt/domain';

  interface Props {
    open: boolean;
    /** What the row is, as it reads on the list: "Pork Loin". */
    itemName: string;
    /** The matching entries, oldest first (`freezerStockFor`). */
    stock: readonly FreezerItem[];
    /** Where an entry is: "Garage, shelf B". */
    placeOf: (item: FreezerItem) => string;
    onConfirm: (choice: { number: number; count: number }) => void;
  }

  let { open = $bindable(), itemName, stock, placeOf, onConfirm }: Props = $props();

  let chosen = $state<number | null>(null);
  let count = $state(1);

  // Every opening starts on the oldest bag and one pack.
  $effect(() => {
    if (open) {
      chosen = stock[0]?.number ?? null;
      count = 1;
    }
  });

  const entry = $derived(stock.find((i) => i.number === chosen) ?? null);
  const held = $derived(entry ? displayAmount(entry.amount) : 0);
  const last = $derived(entry !== null && count >= held);

  function packs(n: number): string {
    return `${n} ${n === 1 ? 'pack' : 'packs'}`;
  }

  function choose(value: string): void {
    chosen = Number(value);
    count = 1;
  }

  function confirm(): void {
    if (!entry) return;
    open = false;
    onConfirm({ number: entry.number, count: Math.min(count, held) });
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Use {itemName} from the freezer</SheetTitle>
    </SheetHeader>

    {#if stock.length > 1}
      <RadioGroup
        label="Which bag"
        value={chosen === null ? '' : String(chosen)}
        onValueChange={choose}
        orientation="vertical"
      >
        {#each stock as item (item.number)}
          <RadioGroupItem
            value={String(item.number)}
            label={`#${item.number} ${item.name} — ${placeOf(item)} · ${packs(displayAmount(item.amount))}`}
          />
        {/each}
      </RadioGroup>
    {:else if entry}
      <p class="text-sm text-foreground" data-testid="use-from-freezer-entry">
        #{entry.number}
        {entry.name} — {placeOf(entry)} · {packs(held)}
      </p>
    {/if}

    {#if entry}
      <div class="flex items-center gap-3">
        <span class="text-sm font-medium">Packs</span>
        <Button
          size="icon"
          variant="outline"
          ariaLabel="One pack fewer"
          disabled={count <= 1}
          onclick={() => (count = Math.max(1, count - 1))}
          data-testid="use-from-freezer-fewer"
        >
          <Icon name="Minus" size={16} />
        </Button>
        <span class="min-w-6 text-center text-sm tabular-nums" data-testid="use-from-freezer-count"
          >{count}</span
        >
        <Button
          size="icon"
          variant="outline"
          ariaLabel="One pack more"
          disabled={count >= held}
          onclick={() => (count = Math.min(held, count + 1))}
          data-testid="use-from-freezer-more"
        >
          <Icon name="Plus" size={16} />
        </Button>
      </div>
      {#if last}
        <p class="text-xs text-muted-foreground" data-testid="use-from-freezer-last">
          That is the last of #{entry.number}. Its entry comes out of the freezer.
        </p>
      {/if}
    {/if}

    <SheetFooter>
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button disabled={!entry} onclick={confirm} data-testid="use-from-freezer-confirm">
        Use from the freezer
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
