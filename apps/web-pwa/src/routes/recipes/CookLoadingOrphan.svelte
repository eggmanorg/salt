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
  // THE REUSABLE PART IS THE SPLIT, NOT THE WORDS (issue #1365). The distinction it
  // draws — still loading versus genuinely gone — is the recipe store's own loading
  // flag, and is the same question on every screen that reads a recipe live. The
  // sentence it says once that settles is not: `/batches/:id/cook` reads the method
  // live too, but it has no cook session to close (its header says so outright) and
  // the way out of a run is the run, not the recipe list.
  //
  // So the deleted state's title, description and way back are props, DEFAULTING to
  // the recipe-cook copy the two original callers already shipped. Those two pass
  // nothing, which is why their output is unchanged and the e2e orphan journey keeps
  // selecting `cook-mode-orphan` / `cook-mode-orphan-back` — the same ids on every
  // caller, deliberately, because it is the same screen.
  //
  // The caller still owns the decision to render it at all (`recipe === null`),
  // which is where the pages diverge: plain cook mode falls straight through to the
  // cook, guided has its plan states to consider first.
  let {
    deletedTitle = 'This recipe was deleted',
    deletedDescription = 'The recipe you were cooking no longer exists, so this cook session has been closed.',
    backLabel = 'Back to recipes',
    onBack = () => push('/recipes'),
  }: {
    deletedTitle?: string;
    deletedDescription?: string;
    backLabel?: string;
    onBack?: () => void;
  } = $props();
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
      title={deletedTitle}
      description={deletedDescription}
      data-testid="cook-mode-orphan"
    >
      {#snippet actions()}
        <Button variant="outline" onclick={onBack} data-testid="cook-mode-orphan-back">
          {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
          {backLabel}
        </Button>
      {/snippet}
    </ErrorState>
  {/if}
</div>
