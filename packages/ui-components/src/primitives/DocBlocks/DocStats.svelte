<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { DOC_TONE_INK } from './docTone';
  import type { DocStatsProps } from './DocBlocks.types';

  let { items, class: className }: DocStatsProps = $props();

  // One row whatever the count (2–4): `auto-fit` would wrap a fourth tile onto
  // its own line on a 360px phone, and a summary row that breaks is two rows.
  const columns = $derived(
    { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }[items.length] ?? 'grid-cols-2',
  );
</script>

<div class={cn('salt-doc-stats my-3 grid gap-2', columns, className)}>
  {#each items as item, i (i)}
    <div class="min-w-0 rounded border border-border bg-card px-2.5 py-2" data-tone={item.tone}>
      <div
        class={cn(
          'font-display text-xl leading-tight font-bold tabular-nums',
          DOC_TONE_INK[item.tone],
        )}
      >
        {item.value}
      </div>
      <div class="text-xs text-muted-foreground">{item.label}</div>
    </div>
  {/each}
</div>
