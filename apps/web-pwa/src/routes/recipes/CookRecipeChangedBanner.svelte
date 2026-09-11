<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';

  // The live recipe drifted from the snapshot taken when the session started, in
  // either cook mode (issue #994). Amber-callout vocabulary, the same one the step
  // note wears — a warning should look like a warning wherever it is met.
  //
  // The CONDITION stays with the caller (`recipeChanged`), the restart itself is the
  // shared lifecycle's, so the only per-page facts are the in-flight flag and the
  // handler to call.

  // BOTH CONTROLS ARE OPTIONAL SINCE ISSUE #1327, because the batch cook page has
  // the same warning to give and nothing to restart: a batch's grams are frozen by
  // design, so restarting would mean re-freezing them against a recipe that has
  // moved — which is a new run, not a restart. Absent handler, no button, and the
  // sentence is the whole banner. The wording is the caller's for the same reason
  // the condition is: the two pages mean different things by "changed".

  interface Props {
    /** What the banner says. */
    message: string;
    /** In-flight only while a restart is possible — omit alongside `onRestart`. */
    restarting?: boolean;
    /** Omit to render no control at all. */
    onRestart?: () => void;
  }
  let { message, restarting = false, onRestart }: Props = $props();
</script>

<div
  class="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-text"
  data-testid="cook-mode-recipe-changed"
>
  <Icon name="TriangleAlert" size={16} class="shrink-0 text-warning" />
  <span class="flex-1">{message}</span>
  {#if onRestart}
    <Button
      size="sm"
      variant="outline"
      onclick={onRestart}
      loading={restarting}
      disabled={restarting}
      data-testid="cook-mode-restart"
    >
      {#snippet leading()}<Icon name="RefreshCw" size={14} />{/snippet}
      Restart
    </Button>
  {/if}
</div>
