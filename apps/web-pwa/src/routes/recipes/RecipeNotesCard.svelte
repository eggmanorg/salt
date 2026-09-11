<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Markdown,
    Textarea,
  } from '@salt/ui-components';
  import type { Recipe } from '@salt/domain';
  import EditableZone from './EditableZone.svelte';
  import NotesFormattingToolbar from './NotesFormattingToolbar.svelte';

  /**
   * The notes card, editable in place (issue #1319).
   *
   * BELOW the tab strip, not inside a panel (issue #878): a note is about the
   * dish, not about its ingredients or its method, so it stays visible whichever
   * tab is showing.
   *
   * There is no Edit/Preview pair as the retired editor had. The card renders the
   * note as Markdown whenever it is not being typed into, so the preview IS the
   * read state and there is nothing to switch between — the same `<Markdown …
   * breaks />` either way, so the two cannot disagree.
   */
  let {
    recipe,
    editing,
    onEdit,
  }: {
    recipe: Recipe;
    editing: boolean;
    onEdit: (next: Recipe) => void;
  } = $props();

  // Resolved once rather than guarded at the interpolation: the read state only
  // renders when there IS a note, so `{recipe.notes ?? ''}` inline would be a
  // fallback nothing could ever reach or test.
  const noteText = $derived(recipe.notes ?? '');

  let draft = $state('');
  let notesEl = $state<HTMLTextAreaElement | undefined>(undefined);

  function setNotes(value: string): void {
    draft = value;
    onEdit({ ...recipe, notes: value.trim() === '' ? null : value });
  }
</script>

{#if recipe.notes || editing}
  <Card>
    <CardHeader class="px-4 pt-4 pb-0">
      <CardTitle class="text-sm">Notes</CardTitle>
    </CardHeader>
    <CardContent class="px-4 pb-4 pt-3">
      <EditableZone
        {editing}
        filled={Boolean(recipe.notes)}
        label="Edit notes"
        slotLabel="Note"
        testId="recipe-edit-notes"
        onOpen={() => (draft = recipe.notes ?? '')}
      >
        {#snippet view()}
          <!-- `breaks` is what makes this a no-op for every note written before
               notes were Markdown: it keeps each typed line break a line break,
               exactly as the old whitespace-pre-wrap paragraph did. -->
          <Markdown text={noteText} breaks class="text-sm text-muted-foreground" />
        {/snippet}
        {#snippet edit(close)}
          <div class="flex flex-col gap-2">
            <!-- The toolbar drives the textarea's DOM node, so it is rendered only
                 beside a live one. -->
            <div class="flex items-center justify-between gap-2">
              <NotesFormattingToolbar element={notesEl} />
              <!-- No blur-to-close on this one field: every toolbar button is a
                   press that takes focus off the textarea, and closing on blur
                   would shut the editor the moment you reached for Bold. -->
              <Button variant="ghost" size="sm" onclick={close} data-testid="recipe-notes-done"
                >Done</Button
              >
            </div>
            <Textarea
              bind:element={notesEl}
              label="Notes"
              placeholder="Anything else worth remembering"
              value={draft}
              onValueChange={setNotes}
              rows={3}
              autoresize
              data-testid="recipe-notes-input"
            />
          </div>
        {/snippet}
      </EditableZone>
    </CardContent>
  </Card>
{/if}
