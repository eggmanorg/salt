<script lang="ts">
  import Chip from '../../src/primitives/Chip/Chip.svelte';
  import ChipGroup from '../../src/primitives/Chip/ChipGroup.svelte';
  import type { ChipTone } from '../../src/primitives/Chip/Chip.types';

  let {
    label = 'Serves 4',
    variant = 'fact',
    withIcon = false,
    tone = 'neutral',
  }: {
    label?: string;
    variant?: 'fact' | 'tag';
    withIcon?: boolean;
    tone?: ChipTone;
  } = $props();
</script>

<ChipGroup ariaLabel="Facts" data-testid="group">
  {#if variant === 'fact'}
    <Chip variant="fact" {tone} icon={withIcon ? 'Users' : undefined} data-testid="chip">
      {label}
    </Chip>
  {:else}
    <Chip variant="tag" data-testid="chip">{label}</Chip>
  {/if}
</ChipGroup>
