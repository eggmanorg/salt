<script lang="ts">
  import { Button, CanonIcon, DetailPage, Icon, Text, TextField } from '@salt/ui-components';
  import { CANON_ICON_HIDDEN } from '@salt/domain';
  import type { KitchenToolDoc } from '@salt/domain/schemas';
  import ImagePromptDialog from '../../components/ImagePromptDialog.svelte';
  import RegenerateIconDialog from '../../components/RegenerateIconDialog.svelte';
  import ImageUploadDialog from '../../components/ImageUploadDialog.svelte';
  import EditableRecordTitle from './EditableRecordTitle.svelte';
  import KitchenToolNameRow from './KitchenToolNameRow.svelte';
  import {
    addKitchenToolMatcher,
    editKitchenTool,
    hideKitchenToolIcon,
    regenerateKitchenToolIcon,
    unhideKitchenToolIcon,
  } from '../../lib/kitchenToolService.js';
  import { createSavedTick } from '../../lib/savedTick.svelte.js';
  import { addToast } from '../../lib/toastStore.js';

  /**
   * The kitchen-tool editor (issue #1489) — a tool's identity, its picture, the
   * names it answers to, and Delete.
   *
   * Two shapes, one behaviour, exactly as `CatalogRecordPane` has: `pane` is the
   * right-hand column of the two-pane list, which scrolls itself; `page` is the
   * phone, where a chosen tool takes the whole screen and comes back with Back.
   *
   * COMMIT ON CHANGE OR BLUR, no Save button, and blur never discards. The name
   * goes through `EditableRecordTitle`, which owns that contract; the "add a
   * name" field commits on Enter and on blur.
   */
  let {
    tool,
    variant,
    onDelete,
    onClose,
    onPromoteName,
    onMoveName,
    onRemoveName,
  }: {
    tool: KitchenToolDoc;
    variant: 'page' | 'pane';
    /** The tool is going — the page owns the deferred delete and the undo toast. */
    onDelete: () => void;
    /** Back / dismissed — returns to wherever the reader came from. */
    onClose: () => void;
    onPromoteName: (tool: KitchenToolDoc, phrase: string) => void;
    onMoveName: (tool: KitchenToolDoc, phrase: string) => void;
    onRemoveName: (tool: KitchenToolDoc, phrase: string) => void;
  } = $props();

  const saved = createSavedTick();

  // ─── The name ───────────────────────────────────────────────────────────────

  let titleError = $state('');

  async function saveTitle(next: string): Promise<void> {
    if (!next || next === tool.label) return;
    titleError = '';
    // The id does NOT move with the label — it is the Storage key for the
    // drawing (`updateKitchenTool`'s header says why), so a reworded tool keeps
    // the picture it already had.
    const result = await editKitchenTool(tool, { label: next, matchers: tool.matchers });
    if (result.kind === 'ok') saved.flash();
    else titleError = 'Give the tool a name.';
  }

  // ─── Also called ────────────────────────────────────────────────────────────
  //
  // One name at a time, added and removed. The comma-separated field this
  // replaces rewrote the whole list on blur, which cannot coexist with a per-name
  // row: two editors over one value is how they drift.

  let newName = $state('');
  let nameBusy = $state(false);

  async function commitNewName(): Promise<void> {
    const phrase = newName.trim();
    // Blur fires after Enter has already committed, so an empty draft is the
    // normal second visit rather than a mistake.
    if (!phrase || nameBusy) return;
    nameBusy = true;
    const result = await addKitchenToolMatcher(tool, phrase);
    nameBusy = false;
    if (result.kind === 'ok') {
      newName = '';
      saved.flash();
    } else {
      addToast('Failed to add the name.', 'destructive');
    }
  }

  // ─── Picture (the Tier-1 pictogram escape hatch) ────────────────────────────
  //
  // The Catalog's Icon section in shape and in wording: a 96px picture and four
  // labelled buttons, in place of the six bare glyphs this page used to carry on
  // every row. One tool at a time, so `iconBusy` is a plain flag.

  let iconBusy = $state(false);
  let regenerateOpen = $state(false);
  let promptOpen = $state(false);
  let uploadOpen = $state(false);

  const iconHidden = $derived(tool.thumbnail === CANON_ICON_HIDDEN);

  async function handleRegenerateIcon(hint: string): Promise<void> {
    iconBusy = true;
    const result = await regenerateKitchenToolIcon(tool.id, hint || undefined);
    iconBusy = false;
    regenerateOpen = false;
    if (result.kind === 'ok') addToast('Regenerating icon…', 'success');
    else addToast('Failed to regenerate icon.', 'destructive');
  }

  async function handleHideIcon(): Promise<void> {
    iconBusy = true;
    const result = await hideKitchenToolIcon(tool);
    iconBusy = false;
    if (result.kind !== 'ok') addToast('Failed to hide icon.', 'destructive');
  }

  async function handleUnhideIcon(): Promise<void> {
    iconBusy = true;
    const result = await unhideKitchenToolIcon(tool.id);
    iconBusy = false;
    if (result.kind !== 'ok') addToast('Failed to unhide icon.', 'destructive');
  }
</script>

{#snippet titleControl()}
  <EditableRecordTitle
    value={tool.label}
    display={tool.label}
    testId="kitchen-tool-name-input"
    editLabel="Edit name"
    error={titleError}
    onCommit={saveTitle}
  />
{/snippet}

{#snippet toolActions()}
  <!-- No "are you sure?". The page defers the delete behind an undo toast, so
       there is nothing left to ask — Salt records, it does not police. -->
  <Button data-testid="kitchen-tool-delete" variant="destructive" size="sm" onclick={onDelete}>
    {#snippet leading()}
      <Icon name="Trash2" size={16} />
    {/snippet}
    Delete
  </Button>
{/snippet}

{#snippet body()}
  <div class="flex flex-col gap-6">
    <section class="flex flex-col gap-2" data-testid="kitchen-tool-icon-section">
      <h2 class="text-sm font-medium text-foreground">Picture</h2>
      <div class="flex items-center gap-3">
        <CanonIcon
          thumbnail={tool.thumbnail}
          name={tool.label}
          size={96}
          version={tool.iconRequestedAt ?? tool.updatedAt}
        />
        <div class="flex flex-wrap gap-2">
          <Button
            data-testid="kitchen-tool-icon-regenerate"
            variant="outline"
            size="sm"
            onclick={() => (regenerateOpen = true)}
            disabled={iconBusy}
          >
            {#snippet leading()}
              <Icon name="RefreshCw" size={16} />
            {/snippet}
            Regenerate
          </Button>
          <Button
            data-testid="kitchen-tool-icon-prompt"
            variant="outline"
            size="sm"
            onclick={() => (promptOpen = true)}
          >
            {#snippet leading()}
              <Icon name="Copy" size={16} />
            {/snippet}
            Prompt
          </Button>
          <Button
            data-testid="kitchen-tool-icon-upload"
            variant="outline"
            size="sm"
            onclick={() => (uploadOpen = true)}
          >
            {#snippet leading()}
              <Icon name="Upload" size={16} />
            {/snippet}
            Upload
          </Button>
          {#if iconHidden}
            <Button
              data-testid="kitchen-tool-icon-unhide"
              variant="outline"
              size="sm"
              onclick={handleUnhideIcon}
              loading={iconBusy}
              disabled={iconBusy}
            >
              {#snippet leading()}
                <Icon name="Eye" size={16} />
              {/snippet}
              Unhide
            </Button>
          {:else}
            <Button
              data-testid="kitchen-tool-icon-hide"
              variant="outline"
              size="sm"
              onclick={handleHideIcon}
              loading={iconBusy}
              disabled={iconBusy}
            >
              {#snippet leading()}
                <Icon name="EyeOff" size={16} />
              {/snippet}
              Hide
            </Button>
          {/if}
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-2" data-testid="kitchen-tool-names-section">
      <h2 class="text-sm font-medium text-foreground">Also called</h2>
      {#if tool.matchers.length > 0}
        <ul class="flex flex-col gap-1">
          {#each tool.matchers as phrase (phrase)}
            <KitchenToolNameRow
              {phrase}
              toolLabel={tool.label}
              testidPrefix="kitchen-tool-editor-name"
              onPromote={() => onPromoteName(tool, phrase)}
              onMove={() => onMoveName(tool, phrase)}
              onRemove={() => onRemoveName(tool, phrase)}
            />
          {/each}
        </ul>
      {:else}
        <Text muted>Only its own name so far.</Text>
      {/if}
      <TextField
        label="Add another name"
        value={newName}
        onValueChange={(v) => (newName = v)}
        placeholder="e.g. masher"
        data-testid="kitchen-tool-add-name-input"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commitNewName();
          } else if (e.key === 'Escape') {
            newName = '';
          }
        }}
        onblur={() => void commitNewName()}
      />
    </section>

    <!-- The quiet acknowledgement that replaces the Save button. -->
    <div class="h-5" aria-live="polite">
      {#if saved.visible}
        <span
          class="flex items-center gap-1 text-sm text-muted-foreground"
          data-testid="kitchen-tool-saved"
        >
          <Icon name="Check" size={14} />
          Saved
        </span>
      {/if}
    </div>
  </div>
{/snippet}

{#if variant === 'page'}
  <DetailPage title={tool.label} onBack={onClose} backLabel="Back">
    {#snippet titleSlot()}{@render titleControl()}{/snippet}
    {#snippet actions()}{@render toolActions()}{/snippet}
    <div class="max-w-xl" data-testid="kitchen-tool-editor-page">{@render body()}</div>
  </DetailPage>
{:else}
  <!-- The pane's own scroller. Its height comes from the fill chain the page sets
       up (ui-spec-v07 §1.4) — nothing here measures chrome. -->
  <div class="flex min-h-0 flex-1 flex-col gap-4" data-testid="kitchen-tool-editor-pane">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1">{@render titleControl()}</div>
      <div class="flex shrink-0 items-center gap-2">{@render toolActions()}</div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto salt-focus-gutter">{@render body()}</div>
  </div>
{/if}

<RegenerateIconDialog
  open={regenerateOpen}
  onOpenChange={(v) => (regenerateOpen = v)}
  placeholder="e.g. show it from the side, wooden handle"
  testidPrefix="kitchen-tool"
  busy={iconBusy}
  onConfirm={handleRegenerateIcon}
/>

<ImagePromptDialog
  bind:open={promptOpen}
  family="kitchenTool"
  id={tool.id}
  subject={tool.label}
  data-testid="kitchen-tool-prompt-dialog"
/>

<ImageUploadDialog
  bind:open={uploadOpen}
  family="kitchenTool"
  id={tool.id}
  subject={tool.label}
  data-testid="kitchen-tool-upload-dialog"
/>
