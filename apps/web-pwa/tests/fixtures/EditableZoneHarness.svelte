<script lang="ts">
  import EditableZone from '../../src/routes/recipes/EditableZone.svelte';

  // A stand-in caller for `EditableZone` (issue #1319). The primitive's whole
  // contract is expressed through two snippets and a `close` callback, and a
  // snippet taking an argument cannot be built from `createRawSnippet` without
  // more ceremony than the thing under test — so the caller is a real component,
  // the way `StubImageCropper` already stands in for a cropper here.
  let {
    editing = false,
    filled = true,
    slotLabel = 'Note',
  }: { editing?: boolean; filled?: boolean; slotLabel?: string } = $props();

  let value = $state('a note');
  let opens = $state(0);
</script>

<EditableZone
  {editing}
  {filled}
  {slotLabel}
  label="Edit the thing"
  testId="zone-affordance"
  onOpen={() => (opens += 1)}
>
  {#snippet view()}
    <span data-testid="zone-view">{value}</span>
  {/snippet}
  {#snippet edit(close)}
    <input data-testid="zone-input" bind:value />
    <button type="button" data-testid="zone-close" onclick={close}>Close</button>
  {/snippet}
</EditableZone>

<span data-testid="zone-opens">{opens}</span>
