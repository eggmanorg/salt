<script lang="ts">
  import { PictogramPill } from '@salt/ui-components';
  import { kitIcons } from '../../lib/kitIcons.js';
  import type { RecipeKitEntryDoc } from '@salt/domain/schemas';

  // The kit a step reaches for (issue #882), in the chip vocabulary the first-use row
  // uses — mid-cook the two are read the same way ("things to have in front of me"),
  // and giving the tools a second visual language would make the cook learn a second
  // one with their hands full. Drawn identically by both cook modes (issue #994).
  //
  // STATIC, where the ingredient chips are buttons: an ingredient chip expands its
  // clipped line and long-presses onto the shopping list, and a frying pan has
  // neither an amount to reveal nor anywhere to be bought to. A button that does
  // nothing on press is worse than a span — it takes a tab stop and promises an
  // action. The pill itself is `PictogramPill` (ui-spec-v12 §8.30) since #955:
  // this markup was hand-rolled here, and the third surface that wanted it
  // reached for a `Chip` and drew an 18px smudge. The <ul>/<li> and the
  // aria-label stay here, because only this file knows what the row is a list of.
  //
  // Drawn at the step the tool comes OUT and not again until it has been put down;
  // the run rule is the domain query's, applied by the caller, not this file's. An
  // unresolved label keeps its words and loses only the picture, so the icon
  // kill-switch never costs the cook a piece of kit.

  interface Props {
    entries: readonly RecipeKitEntryDoc[];
  }
  let { entries }: Props = $props();
</script>

<ul
  class="flex flex-wrap items-start gap-2"
  aria-label="Kit this step calls for"
  data-testid="cook-step-kit"
>
  {#each entries as entry (entry.label)}
    <li class="shrink-0 max-w-full">
      <PictogramPill
        label={entry.label}
        thumbnail={$kitIcons.kitIconFor(entry)}
        version={$kitIcons.kitIconVersionFor(entry)}
        data-testid="cook-step-kit-chip"
      />
    </li>
  {/each}
</ul>
