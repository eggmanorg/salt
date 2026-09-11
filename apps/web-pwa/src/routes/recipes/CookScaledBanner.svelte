<script lang="ts">
  import { Icon } from '@salt/ui-components';

  // This cook is for a different number than the recipe states (issue #1314), in
  // either cook mode. Said out loud rather than left to be inferred from the
  // amounts: a cook halfway through a recipe cannot check the arithmetic, and the
  // things scaling did NOT touch — the method, the timings, the tin — are exactly
  // what would mislead them if they assumed otherwise.
  //
  // Informational, so the palette's tertiary (terracotta) rather than the warning
  // amber `CookRecipeChangedBanner` wears beside it: nothing is wrong and there is
  // nothing to act on. It carries no Reset — mid-cook the way back is the recipe
  // page, and a control that silently restated every amount under a cook's hands
  // is not one this screen should offer.

  interface Props {
    /** How many this cook is for. */
    servings: number;
    /** How many the recipe itself states. */
    base: number;
  }
  let { servings, base }: Props = $props();
</script>

<div
  class="flex shrink-0 items-center gap-3 border-b border-tertiary-variant/40 bg-tertiary-variant/10 px-4 py-3 text-sm text-muted-foreground"
  data-testid="cook-mode-scaled"
>
  <Icon name="Users" size={16} class="shrink-0 text-tertiary" />
  <span class="flex-1"
    >Amounts are scaled for {servings} — the recipe is written for {base}. The method, the timings
    and any tin or pan size are as written.</span
  >
</div>
