<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Button,
    Icon,
    ImageCropper,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Textarea,
    TextField,
    type ImageCropperHandle,
  } from '@salt/ui-components';
  import { logObservation } from '../../lib/batchObservationService.js';
  import { addToast } from '../../lib/toastStore.js';

  // "How did it go?" (issue #812, phase 4 of epic #778) — the one screen that writes
  // to a run's observation log.
  //
  // Its own component rather than a fourth block inside BatchDetailPage, for the
  // reason RecipeImportPhotoDialog is its own: the page is long already, and this
  // has real state of its own — a crop in progress, an object URL that must be
  // revoked, an in-flight write with two halves.
  //
  // ─── WHAT IT ASKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────
  //
  // A weight, a note, a photo. Three things, all optional, and a Skip that costs one
  // tap — because the screen is an INVITATION and a bake that nobody wrote anything
  // about is a perfectly good bake. Nothing here is required, nothing here blocks,
  // and closing it writes nothing at all.
  //
  // `ph` and `temperatureC` exist on the document and are not asked for; the service
  // writes them null and says why. A back-fill control for `at` is likewise absent:
  // the log is ordered by WHEN THE READING WAS TAKEN, and until something can be
  // logged for last Tuesday, taken and typed are the same moment (see
  // `batchObservationService`, which is where the instant is read).
  //
  // ─── THE PHOTO COSTS ONLY ITSELF ──────────────────────────────────────────────
  //
  // The entry is written first and the photo attached second, which is forced by the
  // callable's partial update (see `batchObservationSync.ts`). So a photo that will
  // not upload is reported as EXACTLY that — the sheet closes, the reading is in the
  // log, and the toast says the picture did not attach. Telling someone their weight
  // failed when it did not would be the worse lie of the two.
  //
  // The bytes are REQUEST-SCOPED: they live in this component's state for the life
  // of the sheet, go to the callable as base64, and are dropped on close (CLAUDE.md
  // Rule 3 — no localStorage / sessionStorage / IndexedDB). There is no client
  // Storage write anywhere in this path; storage.rules stay `write: if false`.

  interface Props {
    batchId: string;
    open: boolean;
    /** Fired once a reading has actually landed — the page uses it to stop asking. */
    onLogged?: () => void;
  }

  let { batchId, open = $bindable(), onLogged }: Props = $props();

  let weightText = $state('');
  let note = $state('');
  let busy = $state(false);

  // The shot being framed (an object URL) and the shot that was accepted (bare
  // base64, WebP — exactly what `getCroppedBase64()` returned; nothing re-encodes
  // it, the cropper's canvas path IS the transport encoder).
  let pendingSrc = $state<string | null>(null);
  let photoBase64 = $state<string | null>(null);
  let cropper = $state<ImageCropperHandle | undefined>(undefined);
  let cropBusy = $state(false);

  // A blank box is "not weighed", which is a normal entry and not a mistake. Only
  // text that is present and is not a non-negative number is wrong — and it is said
  // on the field rather than in a toast, because it is about the box you are in.
  const weightGrams = $derived.by(() => {
    const raw = weightText.trim();
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  });
  const weightError = $derived(
    weightText.trim() !== '' && weightGrams === null ? 'A weight in grams, or leave it blank.' : '',
  );

  // Nothing typed, nothing photographed — there is no entry to write, so Save has
  // nothing to do and says so by being unavailable. Skip is the button for that.
  const hasSomething = $derived(weightGrams !== null || note.trim() !== '' || photoBase64 !== null);
  const canSave = $derived(hasSomething && weightError === '' && !busy && pendingSrc === null);

  // Object-URL lifecycle: revoke before replacing or clearing, so a re-shoot, a
  // discard or a close cannot leak the blob.
  function clearPending(): void {
    if (pendingSrc) URL.revokeObjectURL(pendingSrc);
    pendingSrc = null;
  }

  function reset(): void {
    clearPending();
    weightText = '';
    note = '';
    photoBase64 = null;
    cropBusy = false;
    busy = false;
  }

  // Re-seed on each open: a sheet reopened next week must not still be holding last
  // week's weight or last week's photograph.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) reset();
    wasOpen = open;
  });

  function handleFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so re-picking the SAME file still fires a change event.
    input.value = '';
    if (!file || busy) return;
    clearPending();
    pendingSrc = URL.createObjectURL(file);
  }

  // `getCroppedBase64()` returns null while a source is still being measured or if
  // it could not be loaded — that is "not ready", not an error, so the shot stays on
  // screen and can simply be accepted again (ui-spec-v06 §1.4/§1.5).
  async function useCurrentPhoto(): Promise<void> {
    if (!cropper || cropBusy || busy) return;
    cropBusy = true;
    const base64 = await cropper.getCroppedBase64();
    cropBusy = false;
    if (!base64) {
      addToast('That photo isn’t ready yet — give it a moment, or take another.', 'destructive');
      return;
    }
    photoBase64 = base64;
    clearPending();
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    busy = true;
    const result = await logObservation({
      batchId,
      weightGrams,
      note: note.trim(),
      photoBase64,
    });
    busy = false;

    if (result.kind !== 'ok') {
      // Nothing was written, so nothing is cleared: everything typed is still on
      // screen to try again with.
      addToast(
        result.error.kind === 'ValidationError' && result.error.message
          ? result.error.message
          : "Couldn't save that reading. Try again.",
        'destructive',
      );
      return;
    }

    open = false;
    onLogged?.();
    if (result.value.photo.kind === 'failed') {
      // The reading landed. Only the picture did not — say precisely that, so nobody
      // goes looking for a weight that is already in the log.
      addToast('Reading saved, but the photo didn’t attach. You can add another.', 'destructive');
      return;
    }
    addToast('Logged.', 'success');
  }
</script>

<Sheet
  bind:open
  side="bottom"
  onOpenChange={(v) => {
    // Closing drops the crop and the bytes — they are request-scoped by design and
    // there is nowhere they are allowed to be kept.
    if (!v) reset();
  }}
>
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>How did it go?</SheetTitle>
    </SheetHeader>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" data-testid="batch-log-sheet">
      <p class="-mt-2 text-sm text-muted-foreground">
        Anything you note here stays on this batch. All of it is optional.
      </p>

      <TextField
        label="Weight (g)"
        inputmode="decimal"
        class="w-40"
        value={weightText}
        error={weightError === '' ? undefined : weightError}
        onValueChange={(v) => (weightText = v)}
        data-autofocus
        data-testid="batch-log-weight"
      />

      <Textarea
        label="Notes"
        rows={3}
        placeholder="e.g. Open crumb, a bit pale on the base…"
        value={note}
        onValueChange={(v) => (note = v)}
        data-testid="batch-log-note"
      />

      <!-- ─── The photo ────────────────────────────────────────────────────────
           One shot, framed 3:2 like the recipe hero — a loaf, a crock, the mould
           on the coppa. `capture="environment"` asks the OS for the rear camera;
           a desktop browser ignores it and shows the file picker. No getUserMedia
           and no permission plumbing of our own. -->
      {#if pendingSrc}
        <ImageCropper bind:this={cropper} src={pendingSrc} />
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onclick={useCurrentPhoto}
            loading={cropBusy}
            disabled={cropBusy}
            data-testid="batch-log-photo-use"
          >
            Use this photo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={clearPending}
            disabled={cropBusy}
            data-testid="batch-log-photo-discard"
          >
            Discard
          </Button>
        </div>
      {:else if photoBase64 !== null}
        <div class="flex items-center gap-3">
          <img
            src={`data:image/webp;base64,${photoBase64}`}
            alt="The crop you framed, ready to attach"
            class="h-20 w-32 rounded border border-border object-cover"
            data-testid="batch-log-photo-thumb"
          />
          <Button
            variant="ghost"
            size="sm"
            onclick={() => (photoBase64 = null)}
            disabled={busy}
            data-testid="batch-log-photo-remove"
          >
            Remove photo
          </Button>
        </div>
      {:else}
        <label
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-input px-4 py-8 text-sm text-muted-foreground hover:bg-muted/50"
        >
          <Icon name="Camera" size={24} />
          <span>Add a photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="sr-only"
            disabled={busy}
            onchange={handleFileChange}
            data-testid="batch-log-photo-input"
          />
        </label>
      {/if}
    </div>

    <SheetFooter class="flex justify-end gap-2">
      <!-- Skip, not Cancel. Nothing was in progress and nothing is being abandoned:
           this screen is an offer, and declining it is the ordinary answer. -->
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}>Skip</Button>
      <Button
        size="sm"
        onclick={handleSave}
        loading={busy}
        disabled={!canSave}
        data-testid="batch-log-save"
      >
        Save
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
