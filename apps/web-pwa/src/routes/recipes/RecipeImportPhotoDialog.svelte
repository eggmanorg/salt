<script lang="ts">
  // Import a recipe by photographing the cookbook page (issue #649, Phase 3).
  //
  // Its own component rather than a third panel inside RecipeListPage: the list
  // page is already long and carries two copies of the URL form, and this flow
  // has real state of its own (a capture queue, a crop in progress, an in-flight
  // extraction). The list page keeps the entry point and the navigation on
  // success; everything between the two lives here.
  //
  // Shape of the flow: shoot a page → frame it → it joins a thumbnail strip →
  // shoot the facing page if the recipe runs across a spread → Import. A recipe
  // routinely spans a spread, which is why the strip exists at all and why the
  // cap is MAX_RECIPE_PAGE_PHOTOS rather than one.
  //
  // The photographs are REQUEST-SCOPED and never persisted anywhere: they live in
  // component state for the life of the import (CLAUDE.md Rule 3 — no
  // localStorage / sessionStorage / IndexedDB), go to the callable as base64, and
  // are dropped when the dialog closes. There is no client Storage write.
  import { onDestroy } from 'svelte';
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    ImageCropper,
    Spinner,
    type ImageCropperHandle,
  } from '@salt/ui-components';
  import type { Recipe } from '@salt/domain';
  import { MAX_RECIPE_PAGE_PHOTOS, type RecipePagePhoto } from '@salt/domain/schemas';
  import { importRecipeFromPhoto, photoImportMessage } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';

  interface Props {
    open?: boolean;
    /** Called with the persisted recipe once extraction succeeds. The caller
     * stashes it and routes to the recipe's own page — navigation is not this
     * dialog's job. */
    onImported: (recipe: Recipe) => void;
  }

  let { open = $bindable(false), onImported }: Props = $props();

  // A captured page, ready for transport. `base64` is exactly what
  // ImageCropper.getCroppedBase64() returned — bare (no `data:` prefix), WebP,
  // 1600px longest edge. No second encode happens in this app: the cropper's
  // canvas path IS the transport encoder.
  interface CapturedPage {
    readonly id: string;
    readonly base64: string;
  }

  let pages = $state<CapturedPage[]>([]);
  // Object URL of the shot currently being framed; null when the strip is idle.
  let pendingSrc = $state<string | null>(null);
  let cropper = $state<ImageCropperHandle | undefined>(undefined);
  let cropBusy = $state(false);
  let importing = $state(false);
  // Bumped on every reset. An extraction that lands after the dialog was
  // dismissed belongs to nobody: the recipe is already saved and flagged
  // Unreviewed in the library (that is the whole point of persisting at
  // extraction time), so dropping the hand-off is honest — yanking someone onto
  // a page they walked away from is not.
  let session = 0;

  const atCapacity = $derived(pages.length >= MAX_RECIPE_PAGE_PHOTOS);
  const canImport = $derived(pages.length > 0 && pendingSrc === null && !importing);

  // Object-URL lifecycle: revoke before replacing or clearing so a re-shoot, a
  // discard or a close cannot leak the blob.
  function clearPending(): void {
    if (pendingSrc) URL.revokeObjectURL(pendingSrc);
    pendingSrc = null;
  }

  function handleFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so re-picking the SAME file still fires a change event.
    input.value = '';
    if (!file || importing) return;
    clearPending();
    pendingSrc = URL.createObjectURL(file);
  }

  // Accept the current framing. `getCroppedBase64()` returns null while a
  // free-mode source is still being measured or if the source could not be
  // loaded (ui-spec-v06 §1.4/§1.5) — that is "not ready", not an error, so the
  // shot stays on screen and the user can simply try again.
  async function useCurrentPage(): Promise<void> {
    if (!cropper || cropBusy || importing) return;
    cropBusy = true;
    const base64 = await cropper.getCroppedBase64();
    cropBusy = false;
    if (!base64) {
      addToast('That photo isn’t ready yet — give it a moment, or take another.', 'destructive');
      return;
    }
    pages = [...pages, { id: crypto.randomUUID(), base64 }];
    clearPending();
  }

  function removePage(id: string): void {
    if (importing) return;
    pages = pages.filter((p) => p.id !== id);
  }

  async function handleImport(): Promise<void> {
    // The guard is the same one that disables the button — a second import must
    // be impossible even if the click lands before the disabled state paints.
    if (!canImport) return;
    importing = true;
    const mine = session;
    const payload: RecipePagePhoto[] = pages.map((p) => ({
      base64: p.base64,
      contentType: 'image/webp',
    }));
    const result = await importRecipeFromPhoto(payload);
    if (session !== mine) return;
    importing = false;
    if (result.kind !== 'ok') {
      // "your photos are still there to retry" — the captures are deliberately
      // NOT cleared, so a blurry-page verdict costs a re-shoot, not the whole set.
      //
      // Signed out (issue #740) is MESSAGE-ONLY here, unlike the URL sheet which
      // offers a sign-in button. The URL path can offer one because a URL is a
      // string it may hold in module memory across the sign-in round trip; these
      // captures are request-scoped image bytes with nowhere they are allowed to
      // live (Rule 3 forbids browser storage, and holding a family's photographs
      // across an auth transition is not a call to make in passing). A sign-in
      // button here would silently destroy the user's shots — worse than the
      // honest message. The issue anticipates this degradation; raised, not
      // absorbed — see the PR notes.
      addToast(photoImportMessage(result.error), 'destructive');
      return;
    }
    onImported(result.value);
  }

  // Closing drops the captures — they are request-scoped by design, and there is
  // nowhere they are allowed to be kept.
  function reset(): void {
    session += 1;
    clearPending();
    pages = [];
    cropBusy = false;
    importing = false;
  }

  function handleOpenChange(next: boolean): void {
    open = next;
    if (!next) reset();
  }

  // Navigating away with a shot on screen must not leak its blob URL — closing
  // the dialog is not the only way out of this component.
  onDestroy(clearPending);
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="recipe-import-photo-dialog">
      <DialogHeader>
        <DialogTitle>Import from photo</DialogTitle>
        <DialogDescription>
          Photograph the recipe page. If it runs across a spread, add the facing page too — up to {MAX_RECIPE_PAGE_PHOTOS}
          pages of the same recipe. We'll read them, convert to metric and British terms, save the recipe,
          and open it for you to check.
        </DialogDescription>
      </DialogHeader>

      {#if importing}
        <!-- Honest in-flight copy rather than a bare spinner: extraction is a
             multimodal read plus an ingredient parse and canon match, so seconds
             is normal and a four-page spread can be noticeably longer. -->
        <div
          class="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-8 text-center"
          data-testid="recipe-import-photo-progress"
        >
          <Spinner />
          <p class="text-sm font-medium text-foreground">
            Reading {pages.length}
            {pages.length === 1 ? 'page' : 'pages'}…
          </p>
          <p class="text-xs text-muted-foreground">
            This usually takes a few seconds. Your recipe is saved as soon as it's read, so you
            won't lose it.
          </p>
        </div>
      {:else if pendingSrc}
        <!-- Free-aspect crop: a cookbook page is portrait, and the 3:2 hero frame
             would cut off either the ingredients or the method (ui-spec-v06 §1.1). -->
        <ImageCropper bind:this={cropper} src={pendingSrc} aspect="free" />
        <p class="text-xs text-muted-foreground">
          Drag to pan, pinch or use the slider to zoom, so the recipe fills the frame.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onclick={useCurrentPage}
            loading={cropBusy}
            disabled={cropBusy}
            data-testid="recipe-import-photo-use"
          >
            Use this page
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={clearPending}
            disabled={cropBusy}
            data-testid="recipe-import-photo-discard"
          >
            Discard shot
          </Button>
        </div>
      {:else}
        <label
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-input px-4 py-10 text-sm text-muted-foreground hover:bg-muted/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-disabled={atCapacity}
        >
          <Icon name="Camera" size={24} />
          <span>
            {pages.length === 0 ? 'Take a photo of the page' : 'Add another page'}
          </span>
          <!-- `capture="environment"` asks the OS for the rear camera; a desktop
               browser ignores it and shows the file picker. No getUserMedia, no
               permission plumbing of our own. -->
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="sr-only"
            disabled={atCapacity}
            onchange={handleFileChange}
            data-testid="recipe-import-photo-input"
          />
        </label>
        {#if atCapacity}
          <p class="text-xs text-muted-foreground" data-testid="recipe-import-photo-capacity">
            That's the {MAX_RECIPE_PAGE_PHOTOS} pages we can read at once — remove one to add another.
          </p>
        {:else}
          <!-- The same handler, without `capture` — the shot may already be in the
               camera roll ("opens the camera, or the photo library"). -->
          <label
            class="cursor-pointer self-start text-xs text-primary hover:underline"
            data-testid="recipe-import-photo-library-label"
          >
            Choose from your photos instead
            <input
              type="file"
              accept="image/*"
              class="sr-only"
              onchange={handleFileChange}
              data-testid="recipe-import-photo-library-input"
            />
          </label>
        {/if}
      {/if}

      {#if pages.length > 0}
        <!-- Thumbnail strip: what has been captured so far, in reading order, each
             droppable so a bad shot can be retaken. The thumbnail IS the transport
             payload rendered back as a data URL — no second copy of the bytes. -->
        <ul class="flex flex-wrap gap-2" data-testid="recipe-import-photo-strip">
          {#each pages as page, i (page.id)}
            <li class="relative">
              <img
                src={`data:image/webp;base64,${page.base64}`}
                alt={`Page ${i + 1}`}
                class="h-20 w-16 rounded border border-border object-cover"
                data-testid="recipe-import-photo-thumb"
              />
              <button
                type="button"
                class="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-50"
                onclick={() => removePage(page.id)}
                disabled={importing}
                aria-label={`Remove page ${i + 1}`}
                data-testid="recipe-import-photo-remove"
              >
                <Icon name="X" size={12} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <DialogFooter>
        <Button
          variant="ghost"
          onclick={() => handleOpenChange(false)}
          disabled={importing}
          data-testid="recipe-import-photo-cancel"
        >
          Cancel
        </Button>
        <Button
          onclick={handleImport}
          loading={importing}
          disabled={!canImport}
          data-testid="recipe-import-photo-btn"
        >
          Import
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
