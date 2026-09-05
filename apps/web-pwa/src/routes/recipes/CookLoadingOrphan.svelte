<script lang="ts">
  import { Button, ErrorState, Icon, Spinner } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { isLoadingRecipes } from '../../lib/recipeService.js';

  // The "no recipe yet" screen both cook modes show (issue #994): still loading, or
  // the recipe was deleted out from under the cook. One component rather than two
  // copies because the two screens were already identical down to the testids —
  // `cook-mode-orphan` and `cook-mode-orphan-back` are the SAME ids in both pages,
  // which is what the e2e orphan journey selects on.
  //
  // No props. The distinction it draws is the recipe store's own loading flag, and
  // the way out is the recipe list — neither is a per-mode fact, so neither is
  // something a caller could pass differently. The caller owns only the decision to
  // render it at all (`recipe === null`), which is where the two pages diverge:
  // plain cook mode falls straight through to the cook, guided has its plan states
  // to consider first.
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
  {#if $isLoadingRecipes}
    <Spinner size={20} />
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else}
    <!-- `ErrorState`, not `EmptyState`: the recipe was deleted out from under a
         running cook, which is a failure to report (`role="alert"`), not a place
         that happens to hold nothing — ui-spec-v13 §8.31.2 is that split.
         `cook-mode-orphan` rides the primitive's `...rest` onto the panel, so it
         now wraps the icon and the button as well as the words. -->
    <ErrorState
      title="This recipe was deleted"
      description="The recipe you were cooking no longer exists, so this cook session has been closed."
      data-testid="cook-mode-orphan"
    >
      {#snippet actions()}
        <Button
          variant="outline"
          onclick={() => push('/recipes')}
          data-testid="cook-mode-orphan-back"
        >
          {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
          Back to recipes
        </Button>
      {/snippet}
    </ErrorState>
  {/if}
</div>
