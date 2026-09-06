<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Button,
    Icon,
    ImageCropper,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Textarea,
    TextField,
    type ImageCropperHandle,
  } from '@salt/ui-components';
  import type { BatchDoc } from '@salt/domain/schemas';
  import { logObservation } from '../../lib/batchObservationService.js';
  import { defaultObservationStageId } from './batchDisplay.js';
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
  // writes them null and says why.
  //
  // ─── THE TWO PRE-FILLED ROWS (issue #1276) ────────────────────────────────────
  //
  // WHICH STAGE and WHEN, both always visible and both seeded on every open. They
  // cost the common case nothing: open the sheet during the bulk ferment, type a
  // weight, Save, and the entry lands against the bulk ferment stamped now — the
  // same two taps as before they existed. They are here for the two cases that had
  // no answer at all: a reading written up an hour later, and a note that belongs to
  // a stage other than the one you are standing in (a skipped one, most of all —
  // #1275 leaves "why did you skip it?" to a note, which only works if a note can
  // name the stage it is about).
  //
  // THIS SHEET READS THE CLOCK, and it is the only thing that WRITES one into the log
  // — `formatWhen` reads one too, but only to choose the word "yesterday".
  // The `datetime-local` box needs a seeded value regardless, so a second read in
  // the service would be two answers to one question — see
  // `batchObservationService`'s header. `at` therefore leaves here already an
  // instant, and a box that cannot be read blocks Save on the field rather than
  // handing the service an instant it cannot use.
  //
  // NEITHER IS EVIDENCE OF A READING. `hasSomething` below still asks for a weight,
  // a note or a photo: a pre-filled default is not something a person typed, so a
  // stage on its own is not an entry.
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
    /**
     * The run itself — for its frozen stages and for the default stage. Handed down
     * from the page, which already holds it: this sheet must not open a second
     * subscription for a document that is already on screen behind it. `null` while
     * the page is still loading, and then the stage row offers the whole batch alone.
     */
    run: BatchDoc | null;
    open: boolean;
    /** Fired once a reading has actually landed — the page uses it to stop asking. */
    onLogged?: () => void;
  }

  let { batchId, run, open = $bindable(), onLogged }: Props = $props();

  // The Select's token for "no stage" — `stageId` on the document is `null`, and a
  // listbox value is a string. Mapped back at the boundary by looking the value up
  // in the run's own stages, so the mapping is "is this one of my stages?" rather
  // than a string comparison that a stage id could ever be on the wrong side of.
  const WHOLE_BATCH = '__whole-batch__';

  let weightText = $state('');
  let note = $state('');
  let busy = $state(false);

  // ─── When ─────────────────────────────────────────────────────────────────────
  //
  // A native `datetime-local`, exactly as `RecipeBakeBatchSheet` uses one and for the
  // reason stated there: an instant is a date and a time and nothing else, so no
  // household convention (a week's first day) makes the native control wrong.

  function pad(value: number): string {
    return String(value).padStart(2, '0');
  }

  /** Now, in the `YYYY-MM-DDTHH:mm` local form a `datetime-local` input wants. */
  function localNow(): string {
    const at = new Date();
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  let whenLocal = $state(localNow());
  let stageValue = $state(WHOLE_BATCH);

  // A `datetime-local` value carries no offset, so it is read as LOCAL time — which
  // is what the person typing it means. `null` while the box is empty or half-typed.
  const atIso = $derived.by(() => {
    const ms = new Date(whenLocal).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  });
  const whenError = $derived(atIso === null ? 'A date and a time — this one can’t be read.' : '');

  const stages = $derived(run?.stages ?? []);
  const selectedStage = $derived(stages.find((stage) => stage.id === stageValue) ?? null);
  /** What actually reaches the document: a stage of THIS run, or no stage at all. */
  const stageId = $derived(selectedStage?.id ?? null);

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
  const canSave = $derived(
    hasSomething && weightError === '' && whenError === '' && !busy && pendingSrc === null,
  );

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
    // Both re-seeded here rather than at declaration: a sheet opened on Thursday must
    // not still be offering Tuesday's clock or the stage the run was on then.
    whenLocal = localNow();
    stageValue = (run === null ? null : defaultObservationStageId(run)) ?? WHOLE_BATCH;
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
    if (!canSave || atIso === null) return;
    busy = true;
    const result = await logObservation({
      batchId,
      at: atIso,
      stageId,
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

      <!-- ─── Which stage, and when ────────────────────────────────────────────
           Both pre-filled, both always visible. A control behind a disclosure is
           one that a person writing up yesterday's reading has to already know
           exists — and pre-filled correctly, these cost nothing to walk past.

           EVERY stage is offered, done and skipped ones included: the back-fill
           case is by definition about a stage that has already ended, and a
           skipped stage is the one a note is most wanted against (#1275).
           Filtering the list would remove exactly the entries this exists for.

           No `portal` prop on the Select: SheetContent publishes itself as the
           portal container, so the listbox opens inside the sheet rather than
           behind the modal's pointer-events barrier (ui-spec-v03 §5; #674/#640). -->
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium">Which stage</span>
        <Select value={stageValue} onValueChange={(v) => (stageValue = v)}>
          <SelectTrigger
            class="w-full"
            aria-label="Which stage this reading is about"
            data-testid="batch-log-stage"
          >
            {selectedStage?.label ?? 'The whole batch'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WHOLE_BATCH}>The whole batch</SelectItem>
            {#each stages as runStage (runStage.id)}
              <SelectItem value={runStage.id}>{runStage.label}</SelectItem>
            {/each}
          </SelectContent>
        </Select>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">When</span>
        <input
          type="datetime-local"
          class="salt-focus-ring w-full rounded border border-input bg-background px-3 py-2 text-sm"
          aria-invalid={whenError === '' ? undefined : 'true'}
          bind:value={whenLocal}
          data-testid="batch-log-when"
        />
        {#if whenError !== ''}
          <!-- On the field, not in a toast: it is about the box you are in, exactly
               as the weight's message is. Save stays unavailable while it stands, so
               the service is never handed an instant it cannot use. -->
          <span role="alert" class="text-sm text-destructive" data-testid="batch-log-when-error">
            {whenError}
          </span>
        {/if}
      </label>

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
