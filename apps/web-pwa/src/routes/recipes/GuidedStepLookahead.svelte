<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';
  import GuidedPlanLine from './GuidedPlanLine.svelte';

  // WHAT IS COMING, read from the step you are on (issue #769) — the two lines the
  // cook deck fades in below the step, drawn once for both screens (issue #1453).
  //
  // Shared for the same reason as `GuidedStepNotes`: the review screen says it
  // shows a step exactly as the cook will see it, and one component is what makes
  // that true by construction rather than by assertion (CLAUDE.md rule 12). The
  // cook deck keeps the veil, the geometry and the decision of whether the panel
  // fits at all — this is only what goes inside it.
  //
  // Both lines belong to the LAST step's successor arithmetic: `nextNumber` is
  // null when there is no step after this one, and then neither line is shown nor
  // offered. A look-ahead authored on the final step is invisible to the cook, so
  // it is invisible here too — the alternative is an editor offering to write a
  // line nobody will ever read.

  interface GuidedStepLookaheadEdit {
    onSetLookahead: (value: string | null) => void;
    onSetGetAhead: (value: string | null) => void;
  }

  let {
    lookahead,
    getAhead,
    nextNumber,
    edit,
  }: {
    lookahead: string;
    getAhead: string;
    nextNumber: number | null;
    edit?: GuidedStepLookaheadEdit | undefined;
  } = $props();

  let adding = $state<'lookahead' | 'getAhead' | null>(null);
</script>

{#if nextNumber !== null}
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-1">
    {#if getAhead !== '' || adding === 'getAhead'}
      <!-- The one line here that is an INSTRUCTION, so it is the one line that
           gets a colour and an icon. Above the summary deliberately: if the cook
           reads one thing in this gap, it is this. -->
      <p
        class="flex items-start gap-2 text-sm font-medium text-primary"
        data-testid="guided-step-get-ahead"
      >
        <Icon name="Hourglass" size={16} class="mt-0.5 shrink-0" />
        {#if edit}
          <GuidedPlanLine
            class="min-w-0 flex-1"
            value={getAhead}
            ariaLabel="what to start during this step"
            placeholder="preheat the oven to 200°C"
            startOpen={adding === 'getAhead'}
            onCommit={(v) => edit.onSetGetAhead(v === '' ? null : v)}
            onClose={() => (adding = null)}
          >
            <span class="min-w-0 flex-1">{getAhead}</span>
          </GuidedPlanLine>
        {:else}
          <span class="min-w-0 flex-1">{getAhead}</span>
        {/if}
      </p>
    {/if}
    {#if lookahead !== '' || adding === 'lookahead'}
      <p class="flex items-baseline gap-2 text-sm text-muted-foreground">
        <span class="shrink-0 text-xs font-semibold uppercase tracking-wide">
          Next · {nextNumber}
        </span>
        {#if edit}
          <GuidedPlanLine
            class="min-w-0 flex-1"
            value={lookahead}
            ariaLabel="what the next step does"
            placeholder="the sauce reduces by half"
            startOpen={adding === 'lookahead'}
            onCommit={(v) => edit.onSetLookahead(v === '' ? null : v)}
            onClose={() => (adding = null)}
          >
            <span class="min-w-0 flex-1 truncate">{lookahead}</span>
          </GuidedPlanLine>
        {:else}
          <span class="min-w-0 flex-1 truncate">{lookahead}</span>
        {/if}
      </p>
    {/if}
    {#if edit}
      <div class="flex flex-wrap items-center gap-1">
        {#if getAhead === '' && adding !== 'getAhead'}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (adding = 'getAhead')}
            data-testid="guided-plan-add-get-ahead"
          >
            {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
            get ahead
          </Button>
        {/if}
        {#if lookahead === '' && adding !== 'lookahead'}
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (adding = 'lookahead')}
            data-testid="guided-plan-add-lookahead"
          >
            {#snippet leading()}<Icon name="Plus" size={14} />{/snippet}
            coming up
          </Button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
