<!-- spec: ui-spec-v09.md §8.23 v0.9.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import Icon from '../Icon/Icon.svelte';
  import { chipVariants } from './Chip.variants';
  import type { ChipProps } from './Chip.types';

  let {
    variant = 'filter',
    pressed = false,
    tone = 'neutral',
    icon,
    class: className,
    children,
    ...rest
  }: ChipProps = $props();

  // §8.23.8: `filter` and `expander` are buttons; `fact` and `tag` are spans,
  // because a thing that cannot be pressed must not be reachable by Tab or
  // announced as a control.
  const interactive = $derived(variant === 'filter' || variant === 'expander');
</script>

{#if interactive}
  <button
    type="button"
    class={cn(chipVariants({ variant, pressed, tone: 'neutral' }), className)}
    aria-pressed={variant === 'filter' ? pressed : undefined}
    {...rest}
  >
    {@render children?.()}
  </button>
{:else}
  <!-- The glyph and the label sit hard against each other: whitespace BETWEEN two tags is
       interior and survives Svelte's trim, so a newline here would put a phantom
       leading space into every static chip's `textContent`. Flexbox never paints
       it, but a consumer asserting on the text does see it — the recipe page's
       attribution chip is asserted exactly. The 4px gap comes from
       `.salt-chip--fact`'s `gap-1`, never from a space in the markup. -->
  <span class={cn(chipVariants({ variant, pressed: false, tone }), className)} {...rest}>
    {#if icon}<Icon name={icon} size={12} />{/if}{@render children?.()}
  </span>
{/if}
