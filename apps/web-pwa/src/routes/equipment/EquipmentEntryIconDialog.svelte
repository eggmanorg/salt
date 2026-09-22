<script lang="ts">
  import {
    Button,
    CanonIcon,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Icon,
    TextField,
    Textarea,
  } from '@salt/ui-components';
  import {
    CANON_ICON_HIDDEN,
    equipmentEntrySubjectName,
    equipmentIconAwaitingApproval,
  } from '@salt/domain';
  import type { Accessory, EquipmentItem } from '@salt/domain';
  import {
    equipmentIcons,
    equipmentIconFor,
    authorEntryIconBrief,
    drawEquipmentIcon,
    hideEquipmentIconFor,
    reviseEquipmentBrief,
  } from '../../lib/equipmentService.js';
  import { addToast } from '../../lib/toastStore.js';
  import ImagePromptDialog from '../../components/ImagePromptDialog.svelte';
  import ImageUploadDialog from '../../components/ImageUploadDialog.svelte';

  // One ENTRY's picture (issue #1465, Phase 2) — the item panel's review gate, at
  // entry scale.
  //
  // It is the SAME pipeline, not a parallel one. `equipmentIcons` is keyed by
  // document id and an entry's document id is its accessory uuid, so Draw, Upload
  // and Prompt are the item's three callables called with a different id. The one
  // thing that differs is where the description comes from: an item's is written
  // by the manifest trigger before anyone looks, an entry's only when somebody
  // presses "Describe it" here. That is why this opens on an empty state rather
  // than on a sentence.
  //
  // WHY A DIALOG RATHER THAN AN EXPANDING ROW. The list is long — the Magimix
  // alone has a dozen accessories — and the panel this mirrors is a description,
  // a correction box and five buttons. Inlined per row it would bury the list it
  // is attached to; as a dialog the row keeps one tile and one button.
  //
  // This component is LAZY-LOADED by the page (see its import comment): it pulls
  // in ImageUploadDialog, and behind that `svelte-easy-crop`, which must not reach
  // the boot graph of an eagerly-routed page.
  //
  // NOT OFFERED HERE, deliberately: "Use a photo" and "Start over from the name".
  // Both are item-scale acts on a make and model you can photograph; an entry is
  // a part, and "Describe it" already re-authors from the name whenever the name
  // has moved. Revise is kept because it is the loop that actually fixes a wrong
  // drawing at its cause.

  interface Props {
    open: boolean;
    /** Closed by the sheet's own dismiss as well as by the X — the page owns the state. */
    onClose: () => void;
    item: EquipmentItem;
    accessory: Accessory;
  }
  let { open, onClose, item, accessory }: Props = $props();

  const icon = $derived(equipmentIconFor($equipmentIcons, accessory.id));
  const hidden = $derived(icon?.thumbnail === CANON_ICON_HIDDEN);
  // The item panel's review signal, at entry scale (issue #1518). Same pure
  // predicate — true whenever `sourceName` differs from `briefSourceName` —
  // and deliberately NOT the same thing as the Redraw/Draw it label below:
  // that label says only whether a picture was ever drawn; this compares the
  // SUBJECT NAME the picture was drawn from against the one the current brief
  // was authored from.
  //
  // Its real boundary: it fires when nothing has been drawn yet (the ordinary
  // state for most entries — a brief exists only once "Describe it" has been
  // pressed) and once a re-authored brief has actually landed under a changed
  // name. It does NOT fire from a rename alone. `onEquipmentManifestWritten`'s
  // brief-authoring loop is item-only, so renaming this accessory never moves
  // `briefSourceName` — `sourceName === briefSourceName` survives the rename,
  // and this banner stays silent until someone presses "Describe it again".
  // Closing that gap is a separate call, not this change (issue #1518).
  //
  // Also not implied: "there is a picture on screen to compare against" — the
  // never-drawn case above has none — and an upload does not clear it either
  // (`setIconUpload` writes only `thumbnail`/`iconRequestedAt`, never
  // `sourceName`), so an entry carrying a user's own photo reads "waiting for
  // you" until it is drawn over.
  const awaitingApproval = $derived(equipmentIconAwaitingApproval(icon));
  // The words the brief was authored FROM — an appliance's part qualified by its
  // appliance, a family member standing alone. Revise needs them: rewriting prose
  // about an appliance without knowing which appliance is exactly the drift the
  // describe step exists to prevent. Nothing displays them; every heading and
  // label here is the entry's own name.
  const subject = $derived(equipmentEntrySubjectName(item, accessory));

  let busy = $state(false);
  let promptOpen = $state(false);
  let uploadOpen = $state(false);

  // The editable copy, re-seeded when the STORED description changes identity —
  // the same treatment, and the same reason, as the item panel's: a redraw
  // stamping the same brief back must not wipe an edit in progress.
  let briefDraft = $state('');
  let briefDraftKey = $state('');
  $effect(() => {
    const key = icon ? `${icon.briefSourceName}\u0000${icon.subjectBrief}` : '';
    if (key !== briefDraftKey) {
      briefDraftKey = key;
      briefDraft = icon?.subjectBrief ?? '';
    }
  });

  let briefSteer = $state('');
  let briefBusy = $state(false);

  async function handleDescribe(): Promise<void> {
    busy = true;
    const result = await authorEntryIconBrief(item.id, accessory.id);
    busy = false;
    if (result.kind !== 'ok') addToast("Couldn't write a description.", 'destructive');
  }

  async function handleDraw(): Promise<void> {
    // No empty-brief guard of its own, unlike the item panel's: there the check
    // also covers a missing item, and here the Draw button's `disabled` is the
    // whole gate — it is the only caller, and Enter in the correction field goes
    // to Revise, not here. A second caller would need one back.
    const trimmed = briefDraft.trim();
    busy = true;
    // The entry's OWN document id, which is its accessory id — the whole of what
    // makes this the item pipeline rather than a second one.
    const result = await drawEquipmentIcon(accessory.id, trimmed);
    busy = false;
    if (result.kind === 'ok') {
      addToast('Drew the picture.', 'success');
    } else if (result.error.kind === 'ValidationError') {
      addToast('Drawing is switched off for this environment.', 'destructive');
    } else {
      addToast('Failed to draw the picture.', 'destructive');
    }
  }

  async function handleRevise(): Promise<void> {
    const steer = briefSteer.trim();
    const brief = briefDraft.trim();
    if (!steer || !brief) return;
    briefBusy = true;
    const result = await reviseEquipmentBrief(subject, brief, steer);
    briefBusy = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't rewrite the description — your text is unchanged.", 'destructive');
      return;
    }
    briefDraft = result.value;
    briefSteer = '';
  }

  async function handleHide(): Promise<void> {
    busy = true;
    const result = await hideEquipmentIconFor(item.id, accessory.id);
    busy = false;
    if (result.kind !== 'ok') addToast('Failed to hide the picture.', 'destructive');
  }
</script>

<Dialog
  {open}
  onOpenChange={(v) => {
    if (!v) onClose();
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="equipment-entry-icon-dialog">
      <DialogHeader>
        <DialogTitle>Picture for "{accessory.name}"</DialogTitle>
        <DialogDescription>
          It shows on every recipe that names this one. Until it has its own, it shows {item.name}'s.
        </DialogDescription>
      </DialogHeader>

      {#if icon === null}
        <!-- The empty state an item never has: nothing is described until asked. -->
        <p class="text-sm text-muted-foreground">
          Nothing has been described for this one yet. Salt will write what it looks like; you read
          it and correct it before anything is drawn.
        </p>
        <div>
          <Button
            onclick={handleDescribe}
            loading={busy}
            disabled={busy}
            data-testid="equipment-entry-describe-btn"
          >
            Describe it
          </Button>
        </div>
      {:else}
        <div class="flex items-start gap-3">
          <CanonIcon
            thumbnail={icon.thumbnail}
            name={accessory.name}
            size={64}
            version={icon.iconRequestedAt}
          />
          <p class="text-xs text-muted-foreground">
            What this one looks like. Correct anything wrong here, then draw it — getting the words
            right costs a moment; getting the picture wrong costs a redraw.
          </p>
        </div>

        <!-- The same heading the item panel carries, for the same reason: the
             "waiting for you" suffix needs something to hang off, and a bare
             middot floating above a box says nothing on its own. -->
        <p class="text-sm font-medium">
          Description
          {#if awaitingApproval}
            <span
              class="ml-1 font-normal text-muted-foreground"
              data-testid="equipment-entry-awaiting-approval"
            >
              · waiting for you
            </span>
          {/if}
        </p>

        <Textarea
          bind:value={briefDraft}
          label=""
          aria-label="Description of {accessory.name}"
          rows={4}
          autoresize
          maxLength={2000}
          disabled={busy || briefBusy}
          data-testid="equipment-entry-brief"
        />

        <div class="flex items-end gap-2">
          <TextField
            class="flex-1"
            label="Ask for a correction"
            placeholder="e.g. it's perforated stainless, not plastic"
            maxlength={200}
            value={briefSteer}
            onValueChange={(v) => (briefSteer = v)}
            disabled={busy || briefBusy}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleRevise();
              }
            }}
            data-testid="equipment-entry-steer"
          />
          <Button
            variant="outline"
            onclick={handleRevise}
            loading={briefBusy}
            disabled={busy || briefBusy || !briefSteer.trim() || !briefDraft.trim()}
            data-testid="equipment-entry-revise-btn"
          >
            Revise
          </Button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            onclick={handleDraw}
            loading={busy}
            disabled={busy || briefBusy || !briefDraft.trim()}
            data-testid="equipment-entry-draw-btn"
          >
            {icon.sourceName ? 'Redraw' : 'Draw it'}
          </Button>
          <Button
            variant="outline"
            onclick={() => (promptOpen = true)}
            data-testid="equipment-entry-prompt-btn"
          >
            {#snippet leading()}
              <Icon name="Copy" size={16} />
            {/snippet}
            Prompt
          </Button>
          <Button
            variant="outline"
            onclick={() => (uploadOpen = true)}
            disabled={busy || briefBusy}
            data-testid="equipment-entry-upload-btn"
          >
            {#snippet leading()}
              <Icon name="Upload" size={16} />
            {/snippet}
            Upload
          </Button>
          {#if !hidden}
            <!-- Hiding an entry's picture withdraws any picture it borrows too
                 (hideEquipmentIconFor) and, with nothing left to read, falls
                 back to no picture at all rather than to the record's own.
                 kitIcons.ts carries the read order and the reason. -->
            <Button
              variant="outline"
              onclick={handleHide}
              disabled={busy || briefBusy}
              data-testid="equipment-entry-hide-btn"
            >
              Hide
            </Button>
          {/if}
          <!-- Re-describe. Idempotent on the subject name server-side, so this
               costs nothing until the entry or its record has been renamed —
               which is the item trigger's rewrite-on-rename, reached by a press. -->
          <button
            type="button"
            class="text-xs text-primary hover:underline disabled:opacity-50"
            onclick={handleDescribe}
            disabled={busy || briefBusy}
            data-testid="equipment-entry-redescribe-btn"
          >
            Describe it again
          </button>
        </div>
      {/if}
    </div>
  </DialogContent>
</Dialog>

<ImagePromptDialog
  bind:open={promptOpen}
  family="equipment"
  id={accessory.id}
  subject={accessory.name}
/>

<ImageUploadDialog
  bind:open={uploadOpen}
  family="equipment"
  id={accessory.id}
  subject={accessory.name}
/>
