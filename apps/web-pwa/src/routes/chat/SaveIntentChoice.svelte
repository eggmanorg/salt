<!--
  "You asked me to save this — which did you mean?" (issue #1480, Phase 2).

  ONLY ON A CHAT ATTACHED TO A DISH, and that is the whole reason it exists. On a
  general chat there is one thing the ask could mean, so nothing is asked and the
  save just runs. Standing on a dish there are two — fold this into the dish you
  are looking at, or keep it as a dish of its own — and the app does not guess
  between them.

  IT IS AN AMBIGUITY, NOT A PERMISSION. There is no "are you sure" in here and
  there must not be one: "Update recipe" goes on to the same change summary the
  menu opens, with the same diff and the same Apply, and nothing is written until
  that. A gate in front of a gate is friction in front of a working path.

  THE WORDS ARE THE MENU'S WORDS. `RecipeViewPage`'s chat-actions menu and the
  full chat page's both say "Update recipe" and "Save as new recipe" (#1310), and
  so does this: two names for one act is how #1310's own bug started.

  The HOST places it, once per page, beside its `RecipeChangeSummary` — never per
  chat surface. The recipe page's docked column and its phone drawer are two
  surfaces of one page and can be mounted at the same time (the column is merely
  `hidden` below `lg`), so a copy in each would ask twice.
-->
<script lang="ts">
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
  } from '@salt/ui-components';

  interface Props {
    /** Bound by the host: opened when a recorded request is taken, closed on any answer. */
    open: boolean;
    /** Fold the conversation into the dish on screen — into the existing review gate. */
    onUpdate: () => void;
    /** Keep it as a separate dish. */
    onSaveNew: () => void;
  }
  let { open = $bindable(), onUpdate, onSaveNew }: Props = $props();

  function choose(run: () => void): void {
    // Closed FIRST: the question has been answered either way, and both handlers
    // raise their own acknowledgement (a toast, then a summary sheet) which would
    // otherwise arrive behind this.
    open = false;
    run();
  }
</script>

<Dialog bind:open>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="chat-save-intent-dialog">
      <DialogHeader>
        <DialogTitle>Save which one?</DialogTitle>
        <DialogDescription>
          This chat belongs to a recipe, so there are two things you could mean. Nothing is written
          until you choose.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => choose(onSaveNew)}
          data-testid="chat-save-intent-new"
        >
          {#snippet leading()}<Icon name="BookOpen" size={16} />{/snippet}
          Save as new recipe
        </Button>
        <Button onclick={() => choose(onUpdate)} data-testid="chat-save-intent-update">
          {#snippet leading()}<Icon name="RefreshCw" size={16} />{/snippet}
          Update recipe
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
