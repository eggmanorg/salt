<script lang="ts">
  import { Chip, ChipGroup } from '@salt/ui-components';

  let {
    mode = 'single',
    ariaLabel,
  }: { mode?: 'single' | 'multi' | 'truncated'; ariaLabel?: string | undefined } = $props();

  const SECTIONS = ['Recipes', 'Meals', 'Cocktails', "Chef's Specials"];
  const TAGS = ['weeknight', 'vegetarian', 'one-pot', 'freezes well'];

  let section = $state('Recipes');
  let active = $state<string[]>(['weeknight']);
  let expanded = $state(false);

  function toggle(tag: string): void {
    active = active.includes(tag) ? active.filter((t) => t !== tag) : [...active, tag];
  }
</script>

{#if mode === 'single'}
  <ChipGroup {ariaLabel}>
    {#each SECTIONS as s (s)}
      <Chip pressed={s === section} onclick={() => (section = s)}>{s}</Chip>
    {/each}
  </ChipGroup>
{:else if mode === 'multi'}
  <ChipGroup {ariaLabel}>
    {#each TAGS as t (t)}
      <Chip pressed={active.includes(t)} onclick={() => toggle(t)}>#{t}</Chip>
    {/each}
  </ChipGroup>
{:else}
  <ChipGroup {ariaLabel}>
    {#each expanded ? TAGS : TAGS.slice(0, 2) as t (t)}
      <Chip pressed={active.includes(t)} onclick={() => toggle(t)}>#{t}</Chip>
    {/each}
    {#if expanded}
      <Chip variant="expander" onclick={() => (expanded = false)}>Show less</Chip>
    {:else}
      <Chip variant="expander" onclick={() => (expanded = true)}>
        +{TAGS.length - 2} more
      </Chip>
    {/if}
  </ChipGroup>
{/if}
