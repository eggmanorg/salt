<!--
  Use from the freezer (issue #1685) — which bag, and how many packs, for one
  shopping row. Opened from a row's "in the freezer" line; the page does the
  write (`useFromFreezer`), so this sheet knows nothing about lists, recipes or
  Firestore. It hands back a bag number and a whole number of packs.

  It starts at the packs the row needs (`packsForNeed`, issue #1712): the row's
  amount over the bag's weight per pack, rounded up and capped at what the bag
  holds — or 1 when the two cannot be compared.

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
  import {
    displayAmount,
    formatBagNumber,
    packsForNeed,
    type FreezerItem,
    type PackNeed,
  } from '@salt/domain';
  import { formatPackWeight } from '../../lib/quantityDisplay.js';

  interface Props {
    open: boolean;
    /** What the row is, as it reads on the list: "Pork Loin". */
    itemName: string;
    /** The matching entries, oldest first (`freezerStockFor`). */
    stock: readonly FreezerItem[];
    /** What the row needs — its own amount and unit, per recipe on a shared row. */
    need: PackNeed;
    /** Where an entry is: "Garage, shelf B". */
    placeOf: (item: FreezerItem) => string;
    onConfirm: (choice: { number: number; count: number }) => void;
  }

  let { open = $bindable(), itemName, stock, need, placeOf, onConfirm }: Props = $props();

  let chosen = $state<number | null>(null);
  let count = $state(1);

  /** The packs a bag starts at for this row. */
  function startFor(item: FreezerItem | undefined): number {
    return item ? packsForNeed(need, item.packWeight, displayAmount(item.amount)) : 1;
  }

  // Every opening starts on the oldest bag, at the packs the row needs from it.
  $effect(() => {
    if (open) {
      chosen = stock[0]?.number ?? null;
      count = startFor(stock[0]);
    }
  });

  const entry = $derived(stock.find((i) => i.number === chosen) ?? null);
  const held = $derived(entry ? displayAmount(entry.amount) : 0);
  const last = $derived(entry !== null && count >= held);

  function packs(n: number): string {
    return `${n} ${n === 1 ? 'pack' : 'packs'}`;
  }

  // "4 × 500 g" for a bag with a weight per pack; "4 packs" for one without.
  function holding(item: FreezerItem): string {
    const n = displayAmount(item.amount);
    return item.packWeight && n > 0 ? `${n} × ${formatPackWeight(item.packWeight)}` : packs(n);
  }

  function choose(value: string): void {
    chosen = Number(value);
    count = startFor(stock.find((i) => i.number === chosen));
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
            label={`#${formatBagNumber(item.number)} ${item.name} — ${placeOf(item)} · ${holding(item)}`}
          />
        {/each}
      </RadioGroup>
    {:else if entry}
      <p class="text-sm text-foreground" data-testid="use-from-freezer-entry">
        #{formatBagNumber(entry.number)}
        {entry.name} — {placeOf(entry)} · {holding(entry)}
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
          That is the last of #{formatBagNumber(entry.number)}. Its entry comes out of the freezer.
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
