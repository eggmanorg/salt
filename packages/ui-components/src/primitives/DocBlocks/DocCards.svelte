<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { DOC_TONE_TINT } from './docTone';
  import type { DocCardsProps } from './DocBlocks.types';

  let { groups, class: className }: DocCardsProps = $props();

  // Every element is a `div`/`span` bar the group heading: these render inside a
  // `salt-md` body, whose `:global(p)`, `ul` and `li` rules would otherwise
  // restyle a card's insides at document scale. The heading is a real `h3` on
  // purpose — it IS a heading in the page's outline, and the doc scale is the
  // size it should be.
</script>

<div class={cn('salt-doc-cards my-3 grid gap-4', className)}>
  {#each groups as group, g (g)}
    <section class="grid gap-2.5">
      {#if group.heading}
        <h3>{group.heading}</h3>
      {/if}
      {#each group.cards as card, c (c)}
        <div class="grid gap-1.5 rounded border border-border bg-card px-3 py-2.5 text-sm">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <span class="font-semibold text-foreground">{card.title}</span>
            {#if card.chips.length > 0}
              <span class="inline-flex flex-wrap items-center gap-1">
                {#each card.chips as chip, i (i)}
                  {#if i > 0 && card.arrows}
                    <span class="text-xs text-placeholder" aria-hidden="true">→</span>
                    <span class="sr-only">then</span>
                  {/if}
                  <span
                    class={cn(
                      'inline-flex items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap tabular-nums',
                      DOC_TONE_TINT[chip.tone],
                    )}
                    data-tone={chip.tone}>{chip.label}</span
                  >
                {/each}
              </span>
            {/if}
          </div>
          {#each card.lines as line, l (l)}
            <div class="grid grid-cols-[auto_1fr] items-baseline gap-2">
              <span
                class="text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase"
                >{line.label ?? ''}</span
              >
              <span class="text-foreground">{line.text}</span>
            </div>
          {/each}
          {#if card.footnote}
            <div class="text-xs text-muted-foreground">{card.footnote}</div>
          {/if}
        </div>
      {/each}
    </section>
  {/each}
</div>
