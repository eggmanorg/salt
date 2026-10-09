<script lang="ts">
  import type { SaltBlockProps } from '../../src/primitives/Markdown/saltBlocks';

  let { kind, source }: SaltBlockProps = $props();
</script>

<div data-testid="salt-block" data-kind={kind}>{source}</div>
