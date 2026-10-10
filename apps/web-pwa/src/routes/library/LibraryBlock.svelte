<script lang="ts">
  import {
    DocCallout,
    DocCards,
    DocChart,
    DocRangeMap,
    DocStats,
    DocTimeline,
    Markdown,
  } from '@salt/ui-components';
  import type { SaltBlockProps } from '@salt/ui-components';
  import { parseLibraryBlock } from '@salt/domain/schemas';

  /**
   * One `salt-<kind>` block in a library page body (issue #1663), handed here by
   * `Markdown`'s `blocks` prop on the three library surfaces and nowhere else.
   *
   * Parses the block's YAML with the domain schema and draws it with the
   * `ui-components` primitive for its kind. A block that does not parse — a hand
   * edit that broke it, a kind that does not exist — renders as the text that
   * was written, in a code box, with one line saying the drawing could not be
   * read. It never renders blank and never throws: the page is still the page,
   * and the person can see what to fix.
   */
  let { kind, source }: SaltBlockProps = $props();

  const parsed = $derived(parseLibraryBlock(kind, source));
</script>

{#if parsed.ok}
  {@const block = parsed.block}
  {#if block.kind === 'cards'}
    <DocCards groups={block.data.groups} />
  {:else if block.kind === 'callout'}
    <DocCallout tone={block.data.tone} label={block.data.label}>
      <Markdown text={block.data.body} />
    </DocCallout>
  {:else if block.kind === 'stats'}
    <DocStats items={block.data.items} />
  {:else if block.kind === 'chart'}
    <DocChart {...block.data} />
  {:else if block.kind === 'range'}
    <DocRangeMap {...block.data} />
  {:else}
    <DocTimeline {...block.data} />
  {/if}
{:else}
  <div class="my-3" data-testid="library-block-broken">
    <pre><code>{source}</code></pre>
    <p class="text-xs text-muted-foreground">
      This drawing couldn't be read ({parsed.problem}), so here is what was written.
    </p>
  </div>
{/if}
