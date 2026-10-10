<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { flowSlot } from './docDiagram';
  import { DOC_TONE_TINT } from './docTone';
  import type { DocFlowChartProps } from './DocBlocks.types';

  /**
   * A flow chart, top to bottom, from rows already laid out (`@salt/domain`'s
   * `layoutLibraryFlow`). Each row is a grid of half-columns with its slots
   * centred (`flowSlot`); between two rows a strip draws each arrow segment from
   * the centre of one slot to the centre of the next, in percentages of the
   * same width, so the arrows meet the boxes at any screen width. Boxes in a
   * row stretch to one height, so every arrow leaves and arrives at an edge.
   */
  let { rows, caption, class: className }: DocFlowChartProps = $props();

  const columns = $derived(Math.max(...rows.map((r) => r.slots.length)));
  const at = (r: number, i: number) => flowSlot(i, rows[r]!.slots.length, columns);
  // One expression, not `"{x}%"`: see DocAxisRows.
  const pct = (n: number) => `${n}%`;
  // A label sits 60% of the way down its segment, nearer the box it points to,
  // so two labelled arrows leaving one box part before their labels are drawn.
  const LABEL_AT = 0.6;
</script>

<div
  class={cn('salt-doc-flow my-3 grid rounded border border-border bg-card p-3 text-sm', className)}
>
  {#each rows as row, r (r)}
    <div class="grid" style:grid-template-columns={`repeat(${2 * columns}, minmax(0, 1fr))`}>
      {#each row.slots as slot, i (i)}
        {#if slot.node}
          <div class="px-1" style:grid-column={at(r, i).column}>
            <div
              class={cn(
                'relative flex h-full items-center justify-center rounded border border-border px-2 py-1.5 text-center text-xs font-semibold break-words',
                slot.node.tone ? DOC_TONE_TINT[slot.node.tone] : 'text-foreground',
              )}
              data-tone={slot.node.tone}
              data-node
            >
              {#if r > 0}
                <svg
                  class="absolute -top-1.5 left-1/2 size-2 -translate-x-1/2 fill-placeholder"
                  viewBox="0 0 10 10"
                  aria-hidden="true"><path d="M 0 0 L 10 0 L 5 9 Z" /></svg
                >
              {/if}
              <!-- Its own element: text beside the `{#if}` compiles a `?? ''` no test can reach. -->
              <span>{slot.node.label}</span>
            </div>
          </div>
        {:else}
          <div
            class="flex justify-center"
            style:grid-column={at(r, i).column}
            aria-hidden="true"
            data-pass
          >
            <span class="w-px bg-placeholder"></span>
          </div>
        {/if}
      {/each}
    </div>
    {#if row.links.length > 0}
      <div class="relative h-8" aria-hidden="true">
        <svg
          class="absolute inset-0 size-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {#each row.links as link, l (l)}
            <line
              x1={at(r, link.from).centre}
              y1="0"
              x2={at(r + 1, link.to).centre}
              y2="100"
              class="stroke-placeholder"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
              data-link
            />
          {/each}
        </svg>
        {#each row.links as link, l (l)}
          {#if link.label}
            {@const x1 = at(r, link.from).centre}
            <span
              class="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-card px-1 text-xs whitespace-nowrap text-muted-foreground"
              style:left={pct(x1 + (at(r + 1, link.to).centre - x1) * LABEL_AT)}
              style:top={pct(LABEL_AT * 100)}>{link.label}</span
            >
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
  {#if caption}
    <div class="mt-2 text-xs text-muted-foreground">{caption}</div>
  {/if}
</div>
