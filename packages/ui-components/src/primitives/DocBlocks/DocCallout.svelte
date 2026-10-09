<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { DOC_TONE_TINT } from './docTone';
  import type { DocCalloutProps } from './DocBlocks.types';

  let { tone, label, children, class: className }: DocCalloutProps = $props();
</script>

<aside
  class={cn(
    'salt-doc-callout my-3 grid gap-0.5 rounded px-3 py-2.5 text-sm',
    DOC_TONE_TINT[tone],
    className,
  )}
  data-tone={tone}
>
  {#if label}
    <span class="text-xs font-semibold tracking-wider uppercase">{label}</span>
  {/if}
  <div>{@render children?.()}</div>
</aside>
