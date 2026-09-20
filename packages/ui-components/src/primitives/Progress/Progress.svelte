<!-- spec: ui-spec-v16.md §1 v0.16 -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Progress } from 'bits-ui';
  import { cn } from '../../lib/cn';
  import { createProgressState } from '../../headless/Progress.headless.svelte';
  import { progressRootVariants, progressIndicatorVariants } from './Progress.variants';
  import type { ProgressProps } from './Progress.types';

  let {
    value = $bindable(),
    defaultValue = undefined,
    max = 100,
    announce = 'polite',
    ariaLabel,
    presentational = false,
    class: className,
  }: ProgressProps = $props();

  if (value === undefined) value = untrack(() => defaultValue);

  const state = createProgressState({
    value: () => value,
    max: () => max,
  });

  const indicatorStyle = $derived(
    state.isIndeterminate ? undefined : `transform: translateX(-${100 - state.percent}%)`,
  );
</script>

{#if presentational}
  <!-- v0.16 §1 — the bar as a picture of a figure something else already states
     in words. Two departures from the default mode, and only two: spans instead
     of divs, because the consumer that needed this mode renders the bar inside a
     <button>, which may hold phrasing content only; and out of the accessibility
     tree entirely (no role, no aria-live, no aria-value*), because a redundant
     graphic inside a control should be silent rather than merely quiet — ARIA's
     presentational-children rule strips the role in most screen readers but does
     NOT silence a live region. Geometry, colours, clamping and the transform are
     the default mode's, unchanged; `block` restores only what the divs gave for
     free. `announce` and `ariaLabel` have no meaning here and are ignored. -->
  <span class={cn(progressRootVariants(), 'block', className)} aria-hidden="true">
    <span
      class={cn(progressIndicatorVariants({ indeterminate: state.isIndeterminate }), 'block')}
      style={indicatorStyle}
    ></span>
  </span>
{:else}
  <Progress.Root
    value={state.bitsValue}
    {max}
    class={cn(progressRootVariants(), className)}
    aria-label={ariaLabel}
    aria-live={announce === 'polite' ? 'polite' : undefined}
  >
    <div
      class={progressIndicatorVariants({ indeterminate: state.isIndeterminate })}
      style={indicatorStyle}
    ></div>
  </Progress.Root>
{/if}
