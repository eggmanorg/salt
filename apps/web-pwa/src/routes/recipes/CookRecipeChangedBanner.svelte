<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';

  // The live recipe drifted from the snapshot taken when the session started, in
  // either cook mode (issue #994). Amber-callout vocabulary, the same one the step
  // note wears — a warning should look like a warning wherever it is met.
  //
  // The CONDITION stays with the caller (`recipeChanged`), the restart itself is the
  // shared lifecycle's, so the only per-page facts are the in-flight flag and the
  // handler to call.

  interface Props {
    restarting: boolean;
    onRestart: () => void;
  }
  let { restarting, onRestart }: Props = $props();
</script>

<div
  class="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-text"
  data-testid="cook-mode-recipe-changed"
>
  <Icon name="TriangleAlert" size={16} class="shrink-0 text-warning" />
  <span class="flex-1">This recipe was updated since you started cooking.</span>
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
</div>
