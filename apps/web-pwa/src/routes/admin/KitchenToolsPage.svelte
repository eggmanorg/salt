<script lang="ts">
  import {
    Button,
    CanonIcon,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    ListPage,
    TextField,
  } from '@salt/ui-components';
  import {
    CANON_ICON_HIDDEN,
    resolveKitchenTool,
    suggestKitchenToolParent,
    unresolvedKitLabels,
  } from '@salt/domain';
  import type { KitchenToolDoc, GuidedPlanDoc } from '@salt/domain/schemas';
  import ImagePromptDialog from '../../components/ImagePromptDialog.svelte';
  import RegenerateIconDialog from '../../components/RegenerateIconDialog.svelte';
  import ImageUploadDialog from '../../components/ImageUploadDialog.svelte';
  import AdminGuard from './AdminGuard.svelte';
  import { goBack } from '../../lib/nav.js';
  import {
    kitchenTools,
    isLoadingKitchenTools,
    addKitchenTool,
    editKitchenTool,
    addKitchenToolMatcher,
    removeKitchenTool,
    regenerateKitchenToolIcon,
    hideKitchenToolIcon,
    unhideKitchenToolIcon,
  } from '../../lib/kitchenToolService.js';
  import { equipment } from '../../lib/equipmentService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { loadAllGuidedPlansForCuration } from '../../lib/guidedPlanService.js';
  import { addToast } from '../../lib/toastStore.js';

  // The kitchen-tool vocabulary, and the queue of words our own content used that
  // it cannot name (issue #882, Phase 4).
  //
  // DELIBERATELY NOT A CATALOG RECORD KIND. The Catalog holds two GROCERY kinds
  // that share an aisle, a match pipeline and one `needs_approval` review queue; a
  // tool has none of the three. Threading a third kind through it would churn
  // `CatalogRecordKey`, the arrival routing and every `record.kind === 'canon'`
  // branch across two components to gain a list that shares nothing with the other
  // two. This page is a sibling.

  // ─── The unresolved queue ─────────────────────────────────────────────────────
  //
  // Recipes are already subscribed app-wide, so only the plans need fetching, and
  // that is ONE SHOT on arrival (see `loadAllGuidedPlansForCuration`). A curation
  // backlog that is a page-load old is exactly as useful as one that is a second
  // old — and the rows that matter still vanish live, because they disappear the
  // moment the vocabulary store gains the tool that resolves them, with no reread
  // of anything and no write to a recipe or a plan.

  let plans = $state<GuidedPlanDoc[]>([]);
  let plansLoaded = $state(false);

  $effect(() => {
    let live = true;
    void loadAllGuidedPlansForCuration().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') plans = result.value;
      plansLoaded = true;
    });
    return () => {
      live = false;
    };
  });

  // Each row carries the tool it probably belongs to, so the cheap action can be
  // the obvious one. The suggestion is ADVISORY — `suggestKitchenToolParent`'s
  // header says why a head noun is a good hint and a terrible rule — so it is
  // only ever a button a person presses, never a fold that happens on its own.
  //
  // The manifest goes in too (issue #954): a kit label may now name an appliance
  // the household owns, and `equipmentIcons` already holds a drawing of it — so
  // offering it here would invite a second pictogram of the same machine, and the
  // row could never clear, because the strip resolves equipment before tools.
  const queue = $derived(
    unresolvedKitLabels($recipes, plans, $kitchenTools, $equipment?.items ?? []).map((row) => ({
      ...row,
      suggestion: suggestKitchenToolParent(row.label, $kitchenTools),
    })),
  );

  const sortedTools = $derived(
    $kitchenTools.slice().sort((a, b) => a.label.localeCompare(b.label)),
  );

  // ─── Add / edit ───────────────────────────────────────────────────────────────

  let showEditor = $state(false);
  let editingTool = $state<KitchenToolDoc | null>(null);
  let formLabel = $state('');
  let formMatchers = $state('');
  let formError = $state('');
  let saving = $state(false);

  const isEditing = $derived(editingTool !== null);

  function openCreate(label = ''): void {
    editingTool = null;
    formLabel = label;
    formMatchers = '';
    formError = '';
    showEditor = true;
  }

  function openEdit(tool: KitchenToolDoc): void {
    editingTool = tool;
    formLabel = tool.label;
    formMatchers = tool.matchers.join(', ');
    formError = '';
    showEditor = true;
  }

  function matcherList(): string[] {
    return formMatchers.split(',');
  }

  // The name being typed already belongs to a drawn tool. A WARNING, never a
  // refusal: `Small bowl` beside `Mixing bowl` is a deliberate second tool and the
  // seeded vocabulary contains several such pairs, so a hard guard would forbid
  // its own contents. What it stops is the accident — `Large frying pan` minted
  // beside `Frying pan`, one more document, one more Gemini image, and plain
  // "frying pan" still undrawn because a specific tool covers nothing but itself.
  //
  // `createKitchenTool`'s `ConflictError` is a different and stricter thing: an
  // IDENTICAL slug, which would overwrite a curated tool. That one still refuses.
  //
  // Editing is exempt because a tool's own name resolves to itself; only a new
  // one can be a near-duplicate of something already there.
  const nearDuplicateOf = $derived(
    isEditing || !formLabel.trim() ? null : resolveKitchenTool(formLabel, $kitchenTools),
  );

  async function handleSave(): Promise<void> {
    const input = { label: formLabel, matchers: matcherList() };
    formError = '';
    saving = true;
    const result = editingTool
      ? await editKitchenTool(editingTool, input)
      : await addKitchenTool(input);
    saving = false;
    if (result.kind === 'ok') {
      showEditor = false;
      if (!editingTool) addToast('Added. Drawing its picture…', 'success');
      return;
    }
    // The two refusals say different things and want different next moves, so
    // they are not folded into one "could not save".
    formError =
      result.kind === 'err' && result.error.kind === 'ConflictError'
        ? 'A tool with that name is already in the list — edit that one instead.'
        : 'Give the tool a name.';
  }

  // ─── Alias: teach an existing tool one more phrase ─────────────────────────────
  //
  // The action that keeps the vocabulary from bloating. "masher" and "potato
  // masher" want the same drawing, and every near-duplicate tool is another image
  // the pipeline pays to generate and another row somebody has to keep in step.

  let aliasFor = $state<string | null>(null);
  let aliasToolId = $state('');
  let aliasBusy = $state(false);
  // Which queue row's one-click alias is in flight, by label. A row-level flag
  // rather than a page-level one so the other rows stay usable.
  let suggestBusy = $state<string | null>(null);

  /**
   * The queue's suggested alias, taken in one click. It reuses `addKitchenToolMatcher`
   * — the same write the dialog performs — rather than adding a second path to the
   * same effect: appending a phrase to `matchers` and saving is the whole of it.
   */
  async function acceptSuggestion(label: string, tool: KitchenToolDoc): Promise<void> {
    suggestBusy = label;
    const result = await addKitchenToolMatcher(tool, label);
    suggestBusy = null;
    if (result.kind === 'ok') addToast(`“${label}” now shows the ${tool.label}.`, 'success');
    else addToast('Failed to add the alias.', 'destructive');
  }

  const aliasChoices = $derived(sortedTools.map((t) => ({ value: t.id, label: t.label })));

  function openAlias(label: string): void {
    aliasFor = label;
    aliasToolId = '';
  }

  async function handleAlias(): Promise<void> {
    const phrase = aliasFor;
    const tool = $kitchenTools.find((t) => t.id === aliasToolId);
    if (!phrase || !tool) return;
    aliasBusy = true;
    const result = await addKitchenToolMatcher(tool, phrase);
    aliasBusy = false;
    aliasFor = null;
    if (result.kind === 'ok') addToast(`“${phrase}” now shows the ${tool.label}.`, 'success');
    else addToast('Failed to add the alias.', 'destructive');
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  let deleteTarget = $state<KitchenToolDoc | null>(null);
  let deleting = $state(false);

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    deleting = true;
    const result = await removeKitchenTool(deleteTarget.id);
    deleting = false;
    deleteTarget = null;
    if (result.kind !== 'ok') addToast('Failed to remove the tool.', 'destructive');
  }

  // ─── Icon (Tier-1 pictogram) escape hatch ─────────────────────────────────────
  //
  // The same three controls as the Catalog's record editor, per row rather than
  // per page, so `iconBusyId` holds WHICH row is working instead of a bare flag.

  let iconBusyId = $state<string | null>(null);
  // The open tool IS the state; the hint lives in RegenerateIconDialog.
  let regenerateTool = $state<KitchenToolDoc | null>(null);

  function isHidden(tool: KitchenToolDoc): boolean {
    return tool.thumbnail === CANON_ICON_HIDDEN;
  }

  // The read-only prompt window (issue #892). Per row like the controls above,
  // so the open tool IS the state — there is nothing else to remember.
  let promptTool = $state<KitchenToolDoc | null>(null);
  let promptOpen = $state(false);

  function openPromptDialog(tool: KitchenToolDoc): void {
    promptTool = tool;
    promptOpen = true;
  }

  let uploadTool = $state<KitchenToolDoc | null>(null);
  let uploadOpen = $state(false);

  function openUploadDialog(tool: KitchenToolDoc): void {
    uploadTool = tool;
    uploadOpen = true;
  }

  function openRegenerateDialog(tool: KitchenToolDoc): void {
    regenerateTool = tool;
  }

  async function handleRegenerateIcon(hint: string): Promise<void> {
    const tool = regenerateTool;
    if (!tool) return;
    iconBusyId = tool.id;
    const result = await regenerateKitchenToolIcon(tool.id, hint || undefined);
    iconBusyId = null;
    regenerateTool = null;
    if (result.kind === 'ok') addToast('Regenerating icon…', 'success');
    else addToast('Failed to regenerate icon.', 'destructive');
  }

  async function handleHideIcon(tool: KitchenToolDoc): Promise<void> {
    iconBusyId = tool.id;
    const result = await hideKitchenToolIcon(tool);
    iconBusyId = null;
    if (result.kind !== 'ok') addToast('Failed to hide icon.', 'destructive');
  }

  async function handleUnhideIcon(tool: KitchenToolDoc): Promise<void> {
    iconBusyId = tool.id;
    const result = await unhideKitchenToolIcon(tool.id);
    iconBusyId = null;
    if (result.kind !== 'ok') addToast('Failed to unhide icon.', 'destructive');
  }
</script>

<AdminGuard>
  <ListPage
    title="Kitchen tools"
    description="The drawn vocabulary. Recipes and plans store words; the picture is looked up from those words every time a row is drawn — so adding a tool here gives every recipe that already says it a picture, with nothing rewritten."
    isLoading={$isLoadingKitchenTools}
    isEmpty={false}
    class="p-4 sm:p-6"
  >
    {#snippet actions()}
      <Button size="sm" variant="outline" onclick={() => goBack('/admin')}>Back to admin</Button>
      <Button size="sm" onclick={() => openCreate()} data-testid="kitchen-tool-add">Add tool</Button
      >
    {/snippet}

    {#snippet children()}
      <div class="flex flex-col gap-6">
        <!-- The queue. Present only when there is something in it: an empty
             "Not drawn yet" heading reads as a broken screen rather than a
             vocabulary that has caught up with the content. -->
        {#if queue.length > 0}
          <section class="flex flex-col gap-2" data-testid="kitchen-tool-queue">
            <div>
              <h2 class="text-sm font-medium text-foreground">Not drawn yet</h2>
              <p class="text-xs text-muted-foreground">
                Words your recipes and plans already use that nothing draws, commonest first.
                {#if !plansLoaded}
                  Counting the guided plans…
                {/if}
              </p>
            </div>
            <ul class="divide-y divide-border rounded border">
              {#each queue as row (row.label)}
                <li
                  class="flex items-center gap-3 px-3 py-2"
                  data-testid="kitchen-tool-queue-row"
                  data-kit-label={row.label}
                >
                  <span class="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                  <span
                    class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    data-testid="kitchen-tool-queue-count"
                  >
                    {row.count}
                  </span>
                  <!-- The row leads with the action that COSTS NOTHING. Aliasing
                       reuses a picture the vocabulary already has; "New tool"
                       spends a Gemini image and a document, and does it again for
                       the next adjective. Where there is a likely parent, the
                       one-click alias is solid and the other two are demoted; where
                       there is not, "New tool" is the right first move and leads. -->
                  {#if row.suggestion}
                    {@const parent = row.suggestion}
                    <Button
                      size="sm"
                      onclick={() => void acceptSuggestion(row.label, parent)}
                      loading={suggestBusy === row.label}
                      disabled={suggestBusy !== null}
                      data-testid="kitchen-tool-queue-suggest"
                    >
                      Alias to {parent.label}
                    </Button>
                  {/if}
                  <Button
                    variant={row.suggestion ? 'ghost' : 'solid'}
                    size="sm"
                    onclick={() => openCreate(row.label)}
                    data-testid="kitchen-tool-queue-new"
                  >
                    New tool
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => openAlias(row.label)}
                    data-testid="kitchen-tool-queue-alias"
                  >
                    {row.suggestion ? 'Another…' : 'Alias…'}
                  </Button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="flex flex-col gap-2">
          <h2 class="text-sm font-medium text-foreground">
            The vocabulary ({sortedTools.length})
          </h2>
          <div class="divide-y divide-border rounded border" data-testid="kitchen-tool-list">
            {#each sortedTools as tool (tool.id)}
              <div
                class="flex items-center gap-3 px-3 py-2"
                data-testid="kitchen-tool-row"
                data-kit-tool-id={tool.id}
              >
                <!--
                  40px, the primary-list-row rung (ui-spec-v04 §14.6.1) and the
                  size the asset's framing is tuned for. `version` is the cache-bust nonce (§14.4): a regenerated
                  icon reuses the SAME immutable Storage URL, so without it the
                  browser keeps serving the picture you just replaced.
                -->
                <CanonIcon
                  thumbnail={tool.thumbnail}
                  name={tool.label}
                  size={40}
                  version={tool.iconRequestedAt ?? tool.updatedAt}
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{tool.label}</div>
                  {#if tool.matchers.length > 0}
                    <div
                      class="truncate text-xs text-muted-foreground"
                      data-testid="kitchen-tool-matchers"
                    >
                      {tool.matchers.join(', ')}
                    </div>
                  {/if}
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => openEdit(tool)}
                    data-testid="kitchen-tool-edit"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => openRegenerateDialog(tool)}
                    disabled={iconBusyId === tool.id}
                    data-testid="kitchen-tool-icon-regenerate"
                    ariaLabel="Regenerate the {tool.label} icon"
                  >
                    {#snippet leading()}
                      <Icon name="RefreshCw" size={16} />
                    {/snippet}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => openPromptDialog(tool)}
                    data-testid="kitchen-tool-icon-prompt"
                    ariaLabel="See the prompt behind the {tool.label} icon"
                  >
                    {#snippet leading()}
                      <Icon name="Copy" size={16} />
                    {/snippet}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => openUploadDialog(tool)}
                    data-testid="kitchen-tool-icon-upload"
                    ariaLabel="Upload your own picture for {tool.label}"
                  >
                    {#snippet leading()}
                      <Icon name="Upload" size={16} />
                    {/snippet}
                  </Button>
                  {#if isHidden(tool)}
                    <Button
                      variant="ghost"
                      size="icon"
                      onclick={() => handleUnhideIcon(tool)}
                      loading={iconBusyId === tool.id}
                      disabled={iconBusyId === tool.id}
                      data-testid="kitchen-tool-icon-unhide"
                      ariaLabel="Unhide the {tool.label} icon"
                    >
                      {#snippet leading()}
                        <Icon name="Eye" size={16} />
                      {/snippet}
                    </Button>
                  {:else}
                    <Button
                      variant="ghost"
                      size="icon"
                      onclick={() => handleHideIcon(tool)}
                      loading={iconBusyId === tool.id}
                      disabled={iconBusyId === tool.id}
                      data-testid="kitchen-tool-icon-hide"
                      ariaLabel="Hide the {tool.label} icon"
                    >
                      {#snippet leading()}
                        <Icon name="EyeOff" size={16} />
                      {/snippet}
                    </Button>
                  {/if}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => (deleteTarget = tool)}
                    data-testid="kitchen-tool-delete"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            {:else}
              <p class="px-3 py-4 text-sm text-muted-foreground">
                Nothing drawn yet. Add a tool, or take one from the list above.
              </p>
            {/each}
          </div>
        </section>
      </div>
    {/snippet}
  </ListPage>
</AdminGuard>

<!-- Add / edit a tool -->
<Dialog
  open={showEditor}
  onOpenChange={(v) => {
    if (!v) showEditor = false;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-editor">
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit tool' : 'Add tool'}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? 'The name is drawn and matched; the id and its picture stay where they are.'
            : 'The name is what gets drawn. A picture is generated as soon as you save.'}
        </DialogDescription>
      </DialogHeader>
      <TextField
        label="Name"
        bind:value={formLabel}
        placeholder="e.g. Potato masher"
        data-testid="kitchen-tool-label-input"
      />
      <TextField
        label="Also called (comma separated)"
        bind:value={formMatchers}
        placeholder="e.g. masher, ricer"
        data-testid="kitchen-tool-matchers-input"
      />
      {#if nearDuplicateOf}
        <p class="text-sm text-warning-text" data-testid="kitchen-tool-duplicate-warning">
          “{nearDuplicateOf.label}” already answers to that name. Saving draws a second picture of
          the same thing — if it is the same thing, cancel and add these words to {nearDuplicateOf.label}
          instead.
        </p>
      {/if}
      {#if formError}
        <span class="text-sm text-destructive" data-testid="kitchen-tool-error">{formError}</span>
      {/if}
      <DialogFooter>
        <Button variant="outline" onclick={() => (showEditor = false)} disabled={saving}>
          Cancel
        </Button>
        <Button
          onclick={handleSave}
          loading={saving}
          disabled={saving}
          data-testid="kitchen-tool-save"
        >
          {isEditing ? 'Save' : 'Add'}
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Alias an unresolved name onto a tool that already has a picture -->
<Dialog
  open={aliasFor !== null}
  onOpenChange={(v) => {
    if (!v) aliasFor = null;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-alias-dialog">
      <DialogHeader>
        <DialogTitle>Another name for…</DialogTitle>
        <DialogDescription>
          “{aliasFor}” will show that tool's existing picture. Nothing new is drawn.
        </DialogDescription>
      </DialogHeader>
      <div data-testid="kitchen-tool-alias-select">
        <Combobox
          items={aliasChoices}
          value={aliasToolId}
          onValueChange={(v) => (aliasToolId = v)}
          placeholder="Search tools…"
          restrict
        >
          <ComboboxField>
            <ComboboxInput />
            <ComboboxTrigger />
          </ComboboxField>
          <ComboboxContent>
            {#snippet children({ filteredItems })}
              {#each filteredItems as cbItem, i (cbItem.value)}
                <ComboboxItem item={cbItem} index={i} />
              {/each}
              {#if filteredItems.length === 0}
                <ComboboxEmpty>No tools match.</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={() => (aliasFor = null)} disabled={aliasBusy}>
          Cancel
        </Button>
        <Button
          onclick={handleAlias}
          loading={aliasBusy}
          disabled={aliasBusy || !aliasToolId}
          data-testid="kitchen-tool-alias-confirm"
        >
          Add as another name
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<RegenerateIconDialog
  open={regenerateTool !== null}
  onOpenChange={(v) => {
    if (!v) regenerateTool = null;
  }}
  placeholder="e.g. show it from the side, wooden handle"
  testidPrefix="kitchen-tool"
  busy={iconBusyId !== null}
  onConfirm={handleRegenerateIcon}
/>

<!-- Remove a tool -->
<Dialog
  open={deleteTarget !== null}
  onOpenChange={(v) => {
    if (!v) deleteTarget = null;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-delete-dialog">
      <DialogHeader>
        <DialogTitle>Remove {deleteTarget?.label}?</DialogTitle>
        <DialogDescription>
          Every recipe and plan that says it keeps its words and loses the picture. Nothing else
          changes.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (deleteTarget = null)} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onclick={handleDelete}
          loading={deleting}
          disabled={deleting}
          data-testid="kitchen-tool-delete-confirm"
        >
          Remove
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

{#if promptTool}
  <ImagePromptDialog
    bind:open={promptOpen}
    family="kitchenTool"
    id={promptTool.id}
    subject={promptTool.label}
    data-testid="kitchen-tool-prompt-dialog"
  />
{/if}

{#if uploadTool}
  <ImageUploadDialog
    bind:open={uploadOpen}
    family="kitchenTool"
    id={uploadTool.id}
    subject={uploadTool.label}
    data-testid="kitchen-tool-upload-dialog"
  />
{/if}
