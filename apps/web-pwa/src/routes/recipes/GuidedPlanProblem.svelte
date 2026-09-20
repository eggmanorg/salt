<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';

  // SOMETHING TO LOOK AT, where it is (issue #1453, Phase 2).
  //
  // The plan's problems used to be four banners at the top of the page, written in
  // the vocabulary of the document — "container names", "prep step 3". A reader
  // who is being asked to check a plan cannot act on either: the words are not
  // theirs, and the thing named is somewhere else on the page.
  //
  // So a problem is drawn HERE, on the step or the bowl it is about, in the words
  // the kitchen uses, and it carries its own fixes. Both surfaces render this one
  // component: the same fault said two different ways on two screens is how a
  // reader learns to distrust both.
  //
  // NEVER A GATE. Nothing on this card refuses anything — Approve stays live
  // behind it, and a plan with every one of these showing is still perfectly
  // cookable (Salt records, never polices). A fix is an offer, which is why a
  // problem with no fix worth offering simply carries none.

  let {
    message,
    fixes = [],
  }: {
    message: string;
    fixes?: readonly { label: string; run: () => void }[];
  } = $props();
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-warning/40 bg-warning/10 px-3 py-2"
  data-testid="guided-plan-problem"
>
  <Icon name="TriangleAlert" size={16} class="shrink-0 text-warning-text" />
  <p class="min-w-[12rem] flex-1 text-sm text-warning-text">{message}</p>
  {#each fixes as fix, i (i)}
    <Button size="sm" variant="outline" onclick={fix.run} data-testid="guided-plan-problem-fix">
      {fix.label}
    </Button>
  {/each}
</div>
