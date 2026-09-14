<script lang="ts">
  import {
    Button,
    Markdown,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { LIBRARY_PAGE_REVISION_CAP, type LibraryPageRevisionDoc } from '@salt/domain/schemas';
  import { formatInstant } from '../../lib/dateFormat.js';

  /**
   * A page's previous versions (issue #1375) — see one, read it, put it back.
   *
   * Phase 1 of the epic already captured a revision on every editing session and
   * gave the app no way to reach one. This is that way, and nothing more: a list,
   * a preview, a restore.
   *
   * ─── IT KNOWS NOTHING ABOUT THE SERVICE ─────────────────────────────────────
   *
   * It takes an array and hands back an index — `CookTimerSheet`'s shape. The
   * write, the toast and the ordering against a half-typed in-place edit all stay
   * with `LibraryPageDocument`, which already owns the page's one write path. A
   * sheet that called `restoreLibraryRevision` itself would be a second place a
   * library write is issued from, and the first one to forget the session capture.
   *
   * ─── ONE SHEET, TWO VIEWS ───────────────────────────────────────────────────
   *
   * The list and the preview are the same sheet with `selected` set or not, not
   * two sheets and not a sheet over a sheet. A preview is what a list row leads
   * to, so stacking two modals would only add a second thing to dismiss — and
   * `z-dialog` is one rung, deliberately (ui-spec-v02 §4.1).
   *
   * The preview renders through the same `Markdown` primitive and the same
   * `.salt-md-doc` document scale the page body uses, so a version previews as the
   * page it will become rather than as a smaller cousin of it. The styles are
   * duplicated from `LibraryPageDocument` rather than shared: Svelte scopes styles
   * per component, so a shared `.salt-md-doc` would have to become a global
   * stylesheet or a variant on the primitive, and the repo promotes on the second
   * consumer only when the thing promoted is a component. Two copies of six
   * margins is the cheaper of the two.
   */

  interface Props {
    open: boolean;
    /** Newest first, as the document stores them. */
    revisions: readonly LibraryPageRevisionDoc[];
    /**
     * Put this revision back. Resolves when the restore has been issued.
     *
     * The revision itself, not its position: this sheet's `revisions` is a
     * snapshot taken when it opened, and by the time Restore is tapped a
     * concurrent write from another device may have already changed what sits
     * at any given index. Handing back the value the preview actually showed is
     * what lets the caller restore THAT version rather than whatever the index
     * now points at.
     */
    onRestore: (revision: LibraryPageRevisionDoc) => Promise<void>;
  }
  let { open = $bindable(), revisions, onRestore }: Props = $props();

  // Which version is being read, if any. `null` is the list.
  //
  // The revision travels WITH its index rather than the index alone, so the
  // preview reads a value it has rather than an array lookup that can miss, and
  // `restore` takes the index as an argument instead of re-checking a `let` the
  // markup has already proved non-null. An index alone costs a `if (selected ===
  // null) return` that nothing can reach — the arm `EditableZone` warns about.
  let selected = $state<{ index: number; revision: LibraryPageRevisionDoc } | null>(null);
  let restoring = $state(false);

  // Re-seed on each open, the planner sheet's pattern: the sheet is mounted for
  // the life of the page, so without this it would reopen on the version somebody
  // was reading a quarter of an hour ago.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) selected = null;
    wasOpen = open;
  });

  /** When it stopped being current, and who replaced it. */
  function label(revision: LibraryPageRevisionDoc): string {
    const when = formatInstant(new Date(revision.savedAt), {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${when} · replaced by ${revision.savedBy}`;
  }

  /** The title a version carried, for the row. */
  function rowTitle(revision: LibraryPageRevisionDoc): string {
    return revision.title.trim() === '' ? 'Untitled' : revision.title;
  }

  const description = $derived(
    revisions.length === 0
      ? `Nothing yet. The last ${LIBRARY_PAGE_REVISION_CAP} versions are kept once this page has been edited.`
      : `The last ${LIBRARY_PAGE_REVISION_CAP} versions, newest first.`,
  );

  async function restore(revision: LibraryPageRevisionDoc): Promise<void> {
    restoring = true;
    await onRestore(revision);
    restoring = false;
    open = false;
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <!-- Always present: `aria-labelledby` on the dialog points at it
           (ui-spec-v03 §5.5), so a sheet without one announces as unnamed. -->
      <SheetTitle>{selected === null ? 'History' : rowTitle(selected.revision)}</SheetTitle>
      <SheetDescription>
        {selected === null ? description : label(selected.revision)}
      </SheetDescription>
    </SheetHeader>

    {#if selected === null}
      <!-- The list. Empty is a sentence, not a missing control: a page nobody has
           edited yet has a history, and it is empty. -->
      {#if revisions.length === 0}
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="library-history-empty"
        >
          Edit this page and the version you replaced turns up here.
        </p>
      {:else}
        <ul class="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="library-history-list">
          {#each revisions as revision, index (index)}
            <li>
              <button
                type="button"
                class="flex w-full flex-col gap-0.5 rounded border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
                onclick={() => (selected = { index, revision })}
                data-testid="library-history-row"
                data-index={index}
              >
                <span class="min-w-0 truncate font-medium">{rowTitle(revision)}</span>
                <span class="text-xs text-muted-foreground" data-testid="library-history-when">
                  {label(revision)}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      {@const chosen = selected}
      <!-- The preview, before anything changes. -->
      <div class="salt-md-doc min-h-0 overflow-y-auto" data-testid="library-history-preview">
        {#if chosen.revision.body.trim() === ''}
          <p class="text-sm text-muted-foreground">This version had nothing written in it.</p>
        {:else}
          <Markdown text={chosen.revision.body} />
        {/if}
      </div>
      <SheetFooter>
        <Button variant="outline" onclick={() => (selected = null)} disabled={restoring}>
          Back
        </Button>
        <Button
          onclick={() => void restore(chosen.revision)}
          loading={restoring}
          disabled={restoring}
          data-testid="library-history-restore"
        >
          Restore this version
        </Button>
      </SheetFooter>
    {/if}
  </SheetContent>
</Sheet>

<style>
  /* The page body's document scale, so a preview is the size the page will be.
     Two class levels deep, beating the primitive's own `.salt-md :global(h1)` on
     specificity rather than on source order. */
  .salt-md-doc :global(.salt-md p) {
    margin: 0.75rem 0;
  }
  .salt-md-doc :global(.salt-md h1) {
    font-size: 1.5rem;
    margin: 1.25rem 0 0.5rem;
  }
  .salt-md-doc :global(.salt-md h2) {
    font-size: 1.25rem;
    margin: 1.25rem 0 0.5rem;
  }
  .salt-md-doc :global(.salt-md h3) {
    font-size: 1.0625rem;
    margin: 1rem 0 0.375rem;
  }
  .salt-md-doc :global(.salt-md ul),
  .salt-md-doc :global(.salt-md ol) {
    margin: 0.75rem 0;
  }
  .salt-md-doc :global(.salt-md li) {
    margin: 0.25rem 0;
  }
  /* A jar table is the point of this feature, and a phone is narrower than one. */
  .salt-md-doc :global(.salt-md table) {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
  }
</style>
