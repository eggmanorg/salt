<!-- spec: ui-spec-v13.md §8.32 v0.13.2 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import Button from '../Button/Button.svelte';
  import Icon from '../Icon/Icon.svelte';
  import type { ErrorStateProps } from './ErrorState.types';

  let {
    title = 'Something went wrong',
    description,
    onRetry,
    retryLabel = 'Try again',
    actions,
    class: className,
    ...rest
  }: ErrorStateProps = $props();
</script>

<div
  class={cn(
    'flex flex-col items-center justify-center text-center gap-3 py-12 px-6 rounded border border-destructive/30 bg-destructive/5',
    className,
  )}
  {...rest}
  role="alert"
>
  <div class="text-destructive">
    <Icon name="TriangleAlert" size={28} ariaLabel="Error" />
  </div>
  <h3 class="text-base font-semibold text-foreground">{title}</h3>
  {#if description}
    <p class="text-sm text-muted-foreground max-w-md">{description}</p>
  {/if}
  {#if actions}
    <div class="flex items-center gap-2 mt-2">
      {@render actions()}
    </div>
  {:else if onRetry}
    <div class="mt-2">
      <Button variant="outline" size="sm" onclick={onRetry}>{retryLabel}</Button>
    </div>
  {/if}
</div>
