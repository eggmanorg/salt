<script lang="ts">
  // Import a recipe by pasting its link (issue #616; extracted in #752, Phase 3).
  //
  // Lifted out of RecipeListPage, which used to carry the same sheet twice
  // (once in the empty state, once above the grid) and now carries it nowhere:
  // the meal page needs the identical flow, and a second copy of an import is
  // not something to own. One component, three entry points.
  //
  // Same contract as RecipeImportPhotoDialog next door, deliberately: `bind:open`
  // in, the persisted draft out via `onImported`, and NO NAVIGATION of its own.
  // The host page decides where an import lands — the list page opens the new
  // recipe's own page, the meal page attaches the dish first — so routing cannot
  // live here.
  //
  // The callable PERSISTS the recipe before this returns (issue #616), flagged
  // `needs_approval`. That is why navigating away afterwards still leaves the
  // recipe in the library, and why a hand-off dropped by a closed dialog loses
  // nothing.
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    TextField,
  } from '@salt/ui-components';
  import type { Recipe } from '@salt/domain';
  import {
    importRecipeFromUrl,
    urlImportMessage,
    isSignedOutFailure,
    stashPendingImportUrl,
  } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { auth } from '../../lib/auth.svelte.js';

  interface Props {
    open?: boolean;
    /** Called with the persisted recipe once the import succeeds. The caller
     * stashes it and routes to the recipe's own page — navigation is not this
     * dialog's job. */
    onImported: (recipe: Recipe) => void;
    /** Pre-fills the field. Read ONCE, at mount: the host uses it to hand back a
     * URL rescued from an import that died on a signed-out session (see
     * `stashPendingImportUrl`), so signing back in costs the user nothing. */
    initialUrl?: string;
  }

  let { open = $bindable(false), onImported, initialUrl = '' }: Props = $props();

  // Seeded once and then owned by the field: `initialUrl` is a rescue value the
  // host read out of a single-use stash, not a live binding, and re-applying it
  // would fight whatever the user has since typed. The capture is the point.
  // svelte-ignore state_referenced_locally
  let importUrl = $state(initialUrl);
  let importing = $state(false);

  // Set when the import failed because the session had died (issue #740). Held in
  // the sheet rather than shown as a toast: the recovery is an ACTION (go and
  // sign in), and a toast that counts down and vanishes is a bad place to put the
  // only route out. Every other failure keeps its existing toast.
  let signedOut = $state(false);

  // Clear the stale client session so AuthGate falls through to the sign-in
  // screen. The URL is stashed FIRST: sign-out remounts the tree and takes this
  // component's state with it.
  async function handleSignInAgain(): Promise<void> {
    stashPendingImportUrl(importUrl);
    await auth.signOut();
  }

  async function handleImport(): Promise<void> {
    const url = importUrl.trim();
    if (importing || url === '') return;
    importing = true;
    signedOut = false;
    const result = await importRecipeFromUrl(url);
    importing = false;
    if (result.kind !== 'ok') {
      if (isSignedOutFailure(result.error)) {
        // No toast: the inline block below carries both the message and the way
        // out, and the pasted URL stays in the field for the retry.
        signedOut = true;
        return;
      }
      // Friendly, specific message; the input stays open so the user can fix the
      // URL and retry, or take the page to the chef instead.
      addToast(urlImportMessage(result.error), 'destructive');
      return;
    }
    // Cleared before the hand-off, not after: the recipe is already persisted
    // server-side, so leaving the link in the field would invite a second import
    // of the same page if the host's navigation is what failed.
    importUrl = '';
    onImported(result.value);
  }

  function handleOpenChange(next: boolean): void {
    open = next;
    if (!next) {
      importUrl = '';
      signedOut = false;
      importing = false;
    }
  }
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="recipe-import-url-dialog">
      <DialogHeader>
        <DialogTitle>Import from a link</DialogTitle>
        <DialogDescription>
          Paste a recipe link. We'll read the page and convert it to metric and British terms, save
          it, and open it for you to check.
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-2" data-testid="recipe-import-url-area">
        <div class="flex items-end gap-2">
          <TextField
            label="Recipe URL"
            placeholder="https://example.com/recipe"
            value={importUrl}
            onValueChange={(v) => (importUrl = v)}
            class="flex-1"
            data-testid="recipe-import-url-input"
          />
          <Button
            size="sm"
            onclick={handleImport}
            loading={importing}
            disabled={importUrl.trim() === '' || importing}
            data-testid="recipe-import-url-btn"
          >
            Import
          </Button>
        </div>

        <!--
          The signed-out recovery (issue #740). Deliberately says nothing about
          the recipe site — being signed out is not that page's fault, and
          claiming it was is the whole defect.
        -->
        {#if signedOut}
          <div
            class="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            data-testid="recipe-import-signed-out"
            role="alert"
          >
            <span>You've been signed out — sign in and try again.</span>
            <Button
              size="sm"
              variant="outline"
              onclick={handleSignInAgain}
              data-testid="recipe-import-sign-in-btn"
            >
              Sign in
            </Button>
          </div>
        {/if}
      </div>

      <DialogFooter>
        <Button
          variant="ghost"
          onclick={() => handleOpenChange(false)}
          disabled={importing}
          data-testid="recipe-import-url-cancel"
        >
          Cancel
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
