<script lang="ts">
  import {
    Button,
    CanonIcon,
    Checkbox,
    DetailPage,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    Textarea,
    TextField,
  } from '@salt/ui-components';
  // TYPE-ONLY, so all three are fully erased, and the components are pulled in
  // by the `await import()`s below rather than at module scope (the Leaflet
  // treatment in routes/admin/LocationMapField.svelte, issue #813).
  //
  // THIS PAGE IS EAGERLY ROUTED. `/equipment/:id` is a core daily-use view and is
  // a static import in routes/index.ts, unlike the admin pages and the recipe view
  // that host these same dialogs — every one of those is `lazy()`. So a plain
  // module-scope import here is the one that reaches the boot graph, and it drags
  // `ImageCropper` (and `svelte-easy-crop` behind it) into what every first open
  // and every PWA update must download before painting. It measured 504.75 kB
  // gzipped against the 500 kB ceiling — caught by scripts/check-boot-payload.mjs,
  // which exists for exactly this one-line, no-visible-symptom regression.
  //
  // None of the three can be needed before a button is pressed, so none is
  // loaded until one is.
  import type ImagePromptDialogComponent from '../../components/ImagePromptDialog.svelte';
  import type ImageUploadDialogComponent from '../../components/ImageUploadDialog.svelte';
  import type EquipmentPhotoDialogComponent from '../../components/EquipmentPhotoDialog.svelte';
  import { push } from 'svelte-spa-router';
  import { CANON_ICON_HIDDEN, equipmentIconAwaitingApproval } from '@salt/domain';
  import { goBack } from '../../lib/nav.js';
  import {
    equipment,
    equipmentIcons,
    equipmentIconFor,
    equipmentThumbnailFor,
    equipmentIconVersionFor,
    drawEquipmentIcon,
    hideEquipmentIcon,
    reviseEquipmentBrief,
    restartEquipmentBrief,
    describeEquipmentFromPhoto,
    renameEquipmentItem,
    removeEquipmentItem,
    addEquipmentAccessory,
    removeEquipmentAccessory,
    toggleEquipmentAccessoryOwned,
    addEquipmentRule,
    removeEquipmentRule,
    editEquipmentRule,
  } from '../../lib/equipmentService.js';
  import { addToast } from '../../lib/toastStore.js';
  import type { DomainError, ReadResult } from '@salt/shared-types';
  import type { EquipmentReferencePhoto } from '@salt/domain/schemas';

  interface Props {
    params: { id: string };
  }
  let { params }: Props = $props();

  const item = $derived($equipment?.items.find((i) => i.id === params.id) ?? null);

  // The read-only prompt window (issue #892). Equipment has no icon dialog of its
  // own — the brief is edited inline — so this is the page's only modal for the
  // picture, and it opens from the same row of buttons as Draw and Hide.
  let promptOpen = $state(false);
  let uploadOpen = $state(false);
  let photoOpen = $state(false);

  // Loaded once each, on first use, then kept for the life of the page.
  let PromptDialog = $state<typeof ImagePromptDialogComponent | null>(null);
  let UploadDialog = $state<typeof ImageUploadDialogComponent | null>(null);
  let PhotoDialog = $state<typeof EquipmentPhotoDialogComponent | null>(null);

  async function openPromptDialog(): Promise<void> {
    PromptDialog ??= (await import('../../components/ImagePromptDialog.svelte')).default;
    promptOpen = true;
  }

  async function openUploadDialog(): Promise<void> {
    UploadDialog ??= (await import('../../components/ImageUploadDialog.svelte')).default;
    uploadOpen = true;
  }

  async function openPhotoDialog(): Promise<void> {
    PhotoDialog ??= (await import('../../components/EquipmentPhotoDialog.svelte')).default;
    photoOpen = true;
  }

  // ─── Pictogram + description review gate (issue #877) ─────────────────────
  // The description is shown BEFORE anything is drawn, and this panel is the
  // whole reason the pipeline is split in two. An image call is slow and costs
  // real money, and a wrong picture gives you nothing to act on — you re-roll and
  // hope. A sentence you can read in two seconds and correct in ten fixes the
  // CAUSE instead of resampling the symptom.
  //
  // ONLY `subjectBrief` appears here. The locked house-style wording
  // (`EQUIPMENT_STYLE_ANCHORS`) lives in Cloud Functions code, is never stored on
  // the document, and is never sent to the browser — you are correcting what the
  // thing IS, never how Salt draws it.
  const icon = $derived(equipmentIconFor($equipmentIcons, params.id));
  const awaitingApproval = $derived(equipmentIconAwaitingApproval(icon));
  // The same sentinel canon uses, deliberately: it is the value `CanonIcon`
  // itself understands as "render the bare tile", so the two families must agree
  // on it rather than each spelling their own.
  const iconHidden = $derived(icon?.thumbnail === CANON_ICON_HIDDEN);

  let iconBusy = $state(false);
  // The editable copy of the brief. Re-seeded whenever the stored description
  // changes identity — a rename re-authors it, and the user must see the NEW
  // words, not their edit of the old ones. Keyed on the pair rather than on the
  // text so that a redraw stamping the same brief back does not wipe an edit in
  // progress.
  let briefDraft = $state('');
  let briefDraftKey = $state('');
  $effect(() => {
    const key = icon ? `${icon.briefSourceName}\u0000${icon.subjectBrief}` : '';
    if (key !== briefDraftKey) {
      briefDraftKey = key;
      briefDraft = icon?.subjectBrief ?? '';
    }
  });

  async function handleDraw(): Promise<void> {
    const trimmed = briefDraft.trim();
    if (!item || !trimmed) return;
    iconBusy = true;
    const result = await drawEquipmentIcon(item.id, trimmed);
    iconBusy = false;
    if (result.kind === 'ok') {
      addToast('Drew the icon.', 'success');
    } else if (result.error.kind === 'ValidationError') {
      // The server declined before spending anything: generation is switched off
      // for this environment, or no description has been written yet.
      addToast('Drawing is switched off for this environment.', 'destructive');
    } else {
      addToast('Failed to draw the icon.', 'destructive');
    }
  }

  // ─── Revise / Start over (issue #885) ─────────────────────────────────────
  // Both call the describeEquipmentSubject callable, which PERSISTS NOTHING: the
  // rewritten sentence lands back in `briefDraft`, still editable, and only
  // becomes the item's description if Draw is pressed afterwards. Draw remains
  // the one button that spends money and the one writer of `subjectBrief`.
  //
  // `briefDraftKey` is deliberately NOT touched here. It tracks the STORED
  // description's identity so a rename re-seeds the box; a revision is an edit of
  // the draft, exactly like typing in it, so leaving the key alone is what stops
  // the $effect from overwriting the new words with the stored ones.
  let briefSteer = $state('');
  let briefBusy = $state(false);
  let briefError = $state<string | null>(null);

  // Shared by both actions: run it, swap the words in on success, and on failure
  // leave the box EXACTLY as it was. A revision that failed must not cost the
  // description already in there — that text may be several edits deep, and a
  // transient callable error is no reason to throw it away.
  async function runBriefAction(
    action: () => Promise<ReadResult<string, DomainError>>,
  ): Promise<void> {
    if (briefBusy) return;
    briefBusy = true;
    briefError = null;
    const result = await action();
    briefBusy = false;
    if (result.kind !== 'ok') {
      briefError = "Couldn't rewrite the description — your text is unchanged. Try again.";
      return;
    }
    briefDraft = result.value;
  }

  async function handleReviseBrief(): Promise<void> {
    const steer = briefSteer.trim();
    const brief = briefDraft.trim();
    // Revision needs both halves. With no description to revise the honest action
    // is Start over, which the other button already is.
    if (!item || !steer || !brief) return;
    const name = item.name;
    await runBriefAction(() => reviseEquipmentBrief(name, brief, steer));
    // The correction is spent: it has been folded into the description, and
    // leaving it in the box invites a second Revise applying "it's matte black"
    // to an already matte-black sentence.
    if (!briefError) briefSteer = '';
  }

  async function handleStartOverBrief(): Promise<void> {
    if (!item) return;
    const name = item.name;
    briefSteer = '';
    await runBriefAction(() => restartEquipmentBrief(name));
  }

  // ─── Use a photo (issue #947) ─────────────────────────────────────────────
  // "Start over, but with a picture": runBriefAction's third caller, same
  // busy/error handling as Revise and Start over. The dialog only captures and
  // crops; this is the one place the describe callable is actually invoked —
  // `briefBusy` is passed straight through so the dialog can show its own
  // "Reading the photo…" state instead of a second, disconnected spinner.
  //
  // Takes the name rather than re-reading `item`: the call site is the inline
  // `onDescribe` below, already inside `{#if item && PhotoDialog}` — narrowed
  // there, so there is no `item` to re-check here.
  async function handleDescribeFromPhoto(
    name: string,
    photo: EquipmentReferencePhoto,
  ): Promise<void> {
    briefSteer = '';
    await runBriefAction(() => describeEquipmentFromPhoto(name, photo));
    photoOpen = false;
  }

  async function handleHideIcon(): Promise<void> {
    if (!item) return;
    iconBusy = true;
    const result = await hideEquipmentIcon(item.id);
    iconBusy = false;
    if (result.kind !== 'ok') addToast('Failed to hide the icon.', 'destructive');
  }

  // ─── Name editing (inline, pencil-triggered) ──────────────────────────────
  let editingName = $state('');
  let editingNameActive = $state(false);
  let nameInput = $state<HTMLInputElement | undefined>(undefined);
  let nameBusy = $state(false);

  $effect(() => {
    if (editingNameActive && nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  });

  function startEditName(): void {
    if (!item) return;
    editingName = item.name;
    editingNameActive = true;
  }

  async function commitEditName(): Promise<void> {
    if (!item) return;
    const trimmed = editingName.trim();
    if (!trimmed || trimmed === item.name) {
      editingNameActive = false;
      return;
    }
    nameBusy = true;
    const result = await renameEquipmentItem(item.id, trimmed);
    nameBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to rename.', 'destructive');
    } else {
      editingNameActive = false;
    }
  }

  // ─── Delete equipment ─────────────────────────────────────────────────────
  let deleteOpen = $state(false);
  let deleteBusy = $state(false);

  async function handleDelete(): Promise<void> {
    if (!item) return;
    const name = item.name;
    deleteBusy = true;
    const result = await removeEquipmentItem(item.id);
    deleteBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to delete equipment.', 'destructive');
      return;
    }
    deleteOpen = false;
    addToast(`Deleted ${name}`, 'success');
    push('/equipment');
  }

  // ─── Accessories ──────────────────────────────────────────────────────────
  let newAccessoryName = $state('');
  let accessoryBusy = $state(false);

  // Confirmation for removal — tracks which accessory is pending.
  let pendingAccessoryRemoval = $state<{ id: string; name: string } | null>(null);
  let accessoryRemoveBusy = $state(false);

  async function handleAddAccessory(): Promise<void> {
    if (!newAccessoryName.trim() || !item) return;
    accessoryBusy = true;
    const result = await addEquipmentAccessory(item.id, newAccessoryName, false, false);
    accessoryBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to add accessory.', 'destructive');
    } else {
      newAccessoryName = '';
    }
  }

  async function confirmRemoveAccessory(): Promise<void> {
    if (!item || !pendingAccessoryRemoval) return;
    accessoryRemoveBusy = true;
    const result = await removeEquipmentAccessory(item.id, pendingAccessoryRemoval.id);
    accessoryRemoveBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to remove accessory.', 'destructive');
      return;
    }
    pendingAccessoryRemoval = null;
  }

  async function handleToggleOwned(accessoryId: string, currentOwned: boolean): Promise<void> {
    if (!item) return;
    const result = await toggleEquipmentAccessoryOwned(item.id, accessoryId, !currentOwned);
    if (result.kind !== 'ok') addToast('Failed to update accessory.', 'destructive');
  }

  // ─── Rules ────────────────────────────────────────────────────────────────
  let newRuleText = $state('');
  let ruleBusy = $state(false);
  let editingRuleIndex = $state<number | null>(null);
  let editingRuleDraft = $state('');

  async function handleAddRule(): Promise<void> {
    if (!newRuleText.trim() || !item) return;
    ruleBusy = true;
    const result = await addEquipmentRule(item.id, newRuleText);
    ruleBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to add rule.', 'destructive');
    } else {
      newRuleText = '';
    }
  }

  // Confirmation for removal — tracks which rule is pending.
  let pendingRuleRemoval = $state<{ index: number; text: string } | null>(null);
  let ruleRemoveBusy = $state(false);

  async function confirmRemoveRule(): Promise<void> {
    if (!item || !pendingRuleRemoval) return;
    ruleRemoveBusy = true;
    const result = await removeEquipmentRule(item.id, pendingRuleRemoval.index);
    ruleRemoveBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to remove rule.', 'destructive');
      return;
    }
    pendingRuleRemoval = null;
  }

  function startEditRule(index: number): void {
    editingRuleIndex = index;
    editingRuleDraft = item?.rules[index] ?? '';
  }

  async function commitEditRule(): Promise<void> {
    if (editingRuleIndex === null || !item) return;
    const result = await editEquipmentRule(item.id, editingRuleIndex, editingRuleDraft);
    if (result.kind !== 'ok') {
      addToast('Failed to update rule.', 'destructive');
    } else {
      editingRuleIndex = null;
    }
  }
</script>

{#if item === null}
  <div class="p-4 sm:p-6">
    <p class="text-sm text-muted-foreground">Equipment item not found.</p>
    <Button variant="outline" class="mt-4" onclick={() => push('/equipment')}
      >Back to kitchen</Button
    >
  </div>
{:else}
  <DetailPage
    title={item.name}
    onBack={() => goBack('/equipment')}
    backLabel="Back"
    class="p-4 sm:p-6"
  >
    {#snippet titleSlot()}
      {#if editingNameActive}
        <input
          bind:this={nameInput}
          data-testid="equipment-detail-name-input"
          class="text-2xl font-semibold tracking-tight text-foreground bg-transparent border-b border-foreground/30 outline-none w-full min-w-0"
          value={editingName}
          oninput={(e) => (editingName = e.currentTarget.value)}
          disabled={nameBusy}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitEditName();
            } else if (e.key === 'Escape') {
              editingNameActive = false;
            }
          }}
          onblur={() => {
            void commitEditName();
          }}
        />
      {:else}
        <div class="flex items-center gap-3 min-w-0">
          <!-- The subject-header rung (ui-spec-v04 §14.6.1): larger than the
               40px list tile it was opened from, smaller than the 96px the canon
               detail page gives a record that IS the page. -->
          <CanonIcon
            thumbnail={equipmentThumbnailFor($equipmentIcons, params.id)}
            name={item.name}
            size={64}
            version={equipmentIconVersionFor($equipmentIcons, params.id)}
          />
          <h1 class="text-2xl font-semibold tracking-tight text-foreground truncate">
            {item.name}
          </h1>
          <button
            class="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            onclick={startEditName}
            aria-label="Edit name"
            type="button"
            data-testid="equipment-detail-edit-name-btn"
          >
            <Icon name="Pencil" size={14} />
          </button>
        </div>
      {/if}
    {/snippet}

    {#snippet actions()}
      <Button
        data-testid="equipment-detail-delete-button"
        variant="destructive"
        size="sm"
        onclick={() => (deleteOpen = true)}
      >
        {#snippet leading()}
          <Icon name="Trash2" size={16} />
        {/snippet}
        Delete
      </Button>
    {/snippet}

    <div class="flex flex-col gap-8">
      <!-- Description (the review gate) -->
      <section class="flex flex-col gap-3" data-testid="equipment-icon-panel">
        <p class="text-sm font-medium">
          Description
          {#if awaitingApproval}
            <span class="ml-1 font-normal text-muted-foreground">· waiting for you</span>
          {/if}
        </p>
        {#if icon === null}
          <p class="text-sm text-muted-foreground" data-testid="equipment-icon-pending">
            Writing a description of this item…
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">
            What this piece of kit looks like. Correct anything wrong here, then draw it — getting
            the words right costs a moment; getting the picture wrong costs a redraw.
          </p>
          <Textarea
            bind:value={briefDraft}
            label=""
            aria-label="Appliance description"
            rows={4}
            autoresize
            maxLength={2000}
            disabled={iconBusy || briefBusy}
            data-testid="equipment-icon-brief"
          />
          <!--
            Ask for a correction (issue #885). Say what is wrong, press Revise, and
            the text model rewrites the sentence above with the correction folded
            THROUGH it — body colour, finish and controls moving together — and
            hands it back here, still editable, before any drawing is paid for.
            maxlength mirrors the 200-char cap on
            DescribeEquipmentSubjectInputSchema.hint. Enter submits: this is a
            one-line correction you will press repeatedly, and reaching for the
            mouse each time is friction the iteration loop can't afford.
          -->
          <div class="flex items-end gap-2">
            <TextField
              class="flex-1"
              label="Ask for a correction"
              placeholder="e.g. it's matte black, and the tank is on the right"
              maxlength={200}
              value={briefSteer}
              onValueChange={(v) => (briefSteer = v)}
              disabled={iconBusy || briefBusy}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleReviseBrief();
                }
              }}
              data-testid="equipment-icon-steer"
            />
            <Button
              variant="outline"
              onclick={handleReviseBrief}
              loading={briefBusy}
              disabled={iconBusy || briefBusy || !briefSteer.trim() || !briefDraft.trim()}
              data-testid="equipment-icon-revise-btn"
            >
              Revise
            </Button>
          </div>
          {#if briefError}
            <p class="text-xs text-destructive" data-testid="equipment-icon-brief-error">
              {briefError}
            </p>
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <Button
              onclick={handleDraw}
              loading={iconBusy}
              disabled={iconBusy || briefBusy || !briefDraft.trim()}
              data-testid="equipment-icon-draw-btn"
            >
              {icon.sourceName ? 'Redraw' : 'Draw it'}
            </Button>
            <Button
              variant="outline"
              onclick={openPromptDialog}
              data-testid="equipment-icon-prompt-btn"
            >
              {#snippet leading()}
                <Icon name="Copy" size={16} />
              {/snippet}
              Prompt
            </Button>
            <Button
              variant="outline"
              onclick={openUploadDialog}
              disabled={iconBusy || briefBusy}
              data-testid="equipment-icon-upload-btn"
            >
              {#snippet leading()}
                <Icon name="Upload" size={16} />
              {/snippet}
              Upload
            </Button>
            {#if !iconHidden}
              <Button
                variant="outline"
                onclick={handleHideIcon}
                disabled={iconBusy || briefBusy}
                data-testid="equipment-icon-hide-btn"
              >
                Hide
              </Button>
            {/if}
            <!--
              Use a photo (issue #947) — you have SEEN the appliance, so this lets
              you show it rather than trust a text model's guess at a make and
              model. Same footing as Revise and Start over: it rewrites the box,
              never draws anything, and Draw remains the only spend.
            -->
            <Button
              variant="outline"
              onclick={openPhotoDialog}
              disabled={iconBusy || briefBusy}
              data-testid="equipment-icon-photo-btn"
            >
              {#snippet leading()}
                <Icon name="Camera" size={16} />
              {/snippet}
              Use a photo
            </Button>
            <!--
              Start over is ALWAYS available and deliberately quieter than the
              buttons beside it: it throws away whatever is in the box —
              including hand edits — for a fresh description written from the
              item's name. The escape hatch, not a first resort.
            -->
            <button
              type="button"
              class="text-xs text-primary hover:underline disabled:opacity-50"
              onclick={handleStartOverBrief}
              disabled={iconBusy || briefBusy}
              data-testid="equipment-icon-start-over-btn"
            >
              Start over from the name
            </button>
          </div>
        {/if}
      </section>

      <!-- Accessories section -->
      <section class="flex flex-col gap-3">
        <p class="text-sm font-medium">
          Accessories
          {#if item.accessories.length > 0}
            <span class="font-normal text-muted-foreground">({item.accessories.length})</span>
          {/if}
        </p>

        {#if item.accessories.length > 0}
          <ul class="flex flex-col gap-1" data-testid="equipment-accessories">
            {#each item.accessories as acc (acc.id)}
              <li
                class="flex items-center gap-3 rounded border border-border bg-card px-3 py-2 text-sm"
                data-testid="equipment-accessory-row"
                data-accessory-id={acc.id}
              >
                <Checkbox
                  checked={acc.owned}
                  onCheckedChange={() => void handleToggleOwned(acc.id, acc.owned)}
                  label=""
                  aria-label="Owned"
                />
                <span class="flex-1">
                  {acc.name}
                  {#if acc.included}
                    <span class="ml-1 text-xs text-muted-foreground">(included)</span>
                  {/if}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => (pendingAccessoryRemoval = { id: acc.id, name: acc.name })}
                  aria-label="Remove {acc.name}"
                >
                  Remove
                </Button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-muted-foreground">No accessories yet.</p>
        {/if}

        <div class="flex gap-2">
          <TextField
            bind:value={newAccessoryName}
            placeholder="Add accessory…"
            disabled={accessoryBusy}
            class="flex-1"
            data-testid="equipment-add-accessory-input"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddAccessory();
              }
            }}
          />
          <Button
            variant="outline"
            onclick={handleAddAccessory}
            loading={accessoryBusy}
            disabled={!newAccessoryName.trim() || accessoryBusy}
            data-testid="equipment-add-accessory-btn"
          >
            Add
          </Button>
        </div>
      </section>

      <!-- Rules section -->
      <section class="flex flex-col gap-3">
        <p class="text-sm font-medium">
          Rules
          {#if item.rules.length > 0}
            <span class="font-normal text-muted-foreground">({item.rules.length})</span>
          {/if}
        </p>
        <p class="text-xs text-muted-foreground">
          Plain-English instructions that correct how AI uses this equipment in recipes.
        </p>

        {#if item.rules.length > 0}
          <ul class="flex flex-col gap-2" data-testid="equipment-rules">
            {#each item.rules as rule, idx (idx)}
              <li
                class="flex flex-col gap-1 rounded border border-border bg-card px-3 py-2 text-sm"
                data-testid="equipment-rule-row"
                data-rule-index={idx}
              >
                {#if editingRuleIndex === idx}
                  <div class="flex gap-2">
                    <TextField
                      bind:value={editingRuleDraft}
                      class="flex-1"
                      data-testid="equipment-edit-rule-input"
                      onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitEditRule();
                        }
                        if (e.key === 'Escape') editingRuleIndex = null;
                      }}
                      autofocus
                    />
                    <Button size="sm" onclick={commitEditRule} disabled={!editingRuleDraft.trim()}>
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onclick={() => (editingRuleIndex = null)}>
                      Cancel
                    </Button>
                  </div>
                {:else}
                  <div class="flex items-start gap-2">
                    <span class="flex-1" data-testid="equipment-rule-text">{rule}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => startEditRule(idx)}
                      aria-label="Edit rule"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => (pendingRuleRemoval = { index: idx, text: rule })}
                      aria-label="Remove rule"
                    >
                      Remove
                    </Button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-muted-foreground">No rules yet.</p>
        {/if}

        <!-- Add rule -->
        <div class="flex gap-2">
          <TextField
            bind:value={newRuleText}
            placeholder="e.g. Always use the dough hook for bread"
            disabled={ruleBusy}
            class="flex-1"
            data-testid="equipment-add-rule-input"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddRule();
              }
            }}
          />
          <Button
            variant="outline"
            onclick={handleAddRule}
            loading={ruleBusy}
            disabled={!newRuleText.trim() || ruleBusy}
            data-testid="equipment-add-rule-btn"
          >
            Add rule
          </Button>
        </div>
      </section>
    </div>
  </DetailPage>
{/if}

<!-- Delete equipment confirm dialog -->
<Dialog
  bind:open={deleteOpen}
  onOpenChange={(v) => {
    if (!v) deleteBusy = false;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="equipment-detail-delete-dialog">
      <DialogHeader>
        <DialogTitle>Delete "{item?.name ?? ''}"?</DialogTitle>
        <DialogDescription>This action cannot be undone.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (deleteOpen = false)} disabled={deleteBusy}>
          Cancel
        </Button>
        <Button
          data-testid="equipment-detail-delete-confirm"
          variant="destructive"
          onclick={handleDelete}
          loading={deleteBusy}
          disabled={deleteBusy}
        >
          Delete
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Remove rule confirm dialog -->
<Dialog
  open={pendingRuleRemoval !== null}
  onOpenChange={(v) => {
    if (!v) {
      pendingRuleRemoval = null;
      ruleRemoveBusy = false;
    }
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="equipment-detail-remove-rule-dialog">
      <DialogHeader>
        <DialogTitle>Remove this rule?</DialogTitle>
        <DialogDescription>
          "{pendingRuleRemoval?.text ?? ''}"
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (pendingRuleRemoval = null)}
          disabled={ruleRemoveBusy}
        >
          Cancel
        </Button>
        <Button
          data-testid="equipment-detail-remove-rule-confirm"
          variant="destructive"
          onclick={confirmRemoveRule}
          loading={ruleRemoveBusy}
          disabled={ruleRemoveBusy}
        >
          Remove
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Remove accessory confirm dialog -->
<Dialog
  open={pendingAccessoryRemoval !== null}
  onOpenChange={(v) => {
    if (!v) {
      pendingAccessoryRemoval = null;
      accessoryRemoveBusy = false;
    }
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="equipment-detail-remove-accessory-dialog">
      <DialogHeader>
        <DialogTitle>Remove "{pendingAccessoryRemoval?.name ?? ''}"?</DialogTitle>
        <DialogDescription>This accessory will be removed from this equipment.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (pendingAccessoryRemoval = null)}
          disabled={accessoryRemoveBusy}
        >
          Cancel
        </Button>
        <Button
          data-testid="equipment-detail-remove-accessory-confirm"
          variant="destructive"
          onclick={confirmRemoveAccessory}
          loading={accessoryRemoveBusy}
          disabled={accessoryRemoveBusy}
        >
          Remove
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

{#if item && PromptDialog}
  <PromptDialog
    bind:open={promptOpen}
    family="equipment"
    id={item.id}
    subject={item.name}
    data-testid="equipment-prompt-dialog"
  />
{/if}

{#if item && UploadDialog}
  <UploadDialog
    bind:open={uploadOpen}
    family="equipment"
    id={item.id}
    subject={item.name}
    data-testid="equipment-upload-dialog"
  />
{/if}

{#if item && PhotoDialog}
  <PhotoDialog
    bind:open={photoOpen}
    busy={briefBusy}
    onDescribe={(photo) => handleDescribeFromPhoto(item.name, photo)}
  />
{/if}
