<script lang="ts">
  import DocCallout from '../../src/primitives/DocBlocks/DocCallout.svelte';
  import type { DocTone } from '../../src/primitives/DocBlocks/DocBlocks.types';

  let { tone, label, body }: { tone: DocTone; label?: string; body: string } = $props();
</script>

<DocCallout {tone} {label}>{body}</DocCallout>
