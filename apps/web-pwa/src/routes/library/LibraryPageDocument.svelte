<script lang="ts">
  import {
    Button,
    Chip,
    DetailPage,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Markdown,
    TextField,
    Textarea,
  } from '@salt/ui-components';
  import { LIBRARY_PAGE_BODY_MAX, LIBRARY_PAGE_TITLE_MAX } from '@salt/domain/schemas';
  import type { LibraryPageDoc, LibraryPageRevisionDoc } from '@salt/domain/schemas';
  import { goBack } from '../../lib/nav.js';
  import { addToast } from '../../lib/toastStore.js';
  import {
    appendToLibraryPage,
    beginLibraryEdit,
    endLibraryEdit,
    flushLibraryWrites,
    queueLibraryEdit,
    restoreLibraryRevision,
  } from '../../lib/libraryService.js';
  import LibraryHistorySheet from './LibraryHistorySheet.svelte';
  import LibraryImportSheet from './LibraryImportSheet.svelte';
  import { parseTagLine } from './libraryTags.js';

  /**
   * One library page, once there is one (epic #1372, Phase 1).
   *
   * Split from `LibraryPageView` so `page` can be REQUIRED here. The route half
   * has three states — loading, gone, present — and folding them into this file
   * meant every field reading `page?.title ?? ''` and every handler opening with a
   * guard against a value the markup around it already guarantees: a dozen arms
   * no test could ever reach, on a component whose whole job is reachable.
   *
   * ─── THERE IS NO EDIT MODE, AND NO SAVE BUTTON ──────────────────────────────
   *
   * Tap a field, it becomes a text box; tap away, it is written. That is how recipe
   * notes already behave and it is what the feature is specified as. It is
   * deliberately NOT the recipe page's shape: that page has a MODE, because a read
   * view of a recipe cannot show an absent field without junking itself up. A
   * library page has three fields, all of them always present, so there is nothing
   * a mode would reveal and it would only be a switch to forget to flip.
   *
   * Closing on blur is therefore correct here where it is wrong on the recipe notes
   * card — that card keeps a formatting toolbar beside the textarea, and every
   * toolbar press is a blur. There is no toolbar here, so "tap away" means what it
   * says.
   *
   * ─── WHAT THE RENDERER DOES AND DOES NOT DO ─────────────────────────────────
   *
   * `Markdown` renders through an AST → Svelte pipeline with `gfmPlugin()`, so
   * tables — the point of this feature — render as tables. `sanitizedHtml` is the
   * library's own opt-in on top of that (#1376): raw HTML in a body is parsed and
   * then passed through the SVG allowlist in
   * `ui-components/src/primitives/Markdown/svgSanitizeSchema.ts`, so a drawing
   * renders and a `<script>`, an `<iframe>` or an `on*` handler does not survive.
   * Salt serves no Content-Security-Policy, so that allowlist is the entire
   * defence and its test suite is the only thing checking it — read the module
   * header before widening anything.
   *
   * The prop is deliberately NOT on anywhere else. A `<svg>` typed into a recipe
   * note or arriving in a chef's reply still renders as visible markup source, and
   * the chat is the reason: its text is written by a model, which is the one place
   * in this app markup should not be accepted from.
   *
   * The body renders at `scale="doc"`. `Markdown`'s default sizes are tuned for a
   * two-line note inside a card (h1 at 1.125rem, `p` margin 0); a page is a
   * document and wants document proportions. The rules themselves are the
   * primitive's (ui-spec-v04 §12.3.2), not this file's — three surfaces render a
   * page body at that scale and the thing they share is the primitive they
   * already share (#1394).
   */
  let {
    page,
    onDelete,
  }: {
    page: LibraryPageDoc;
    /** Delete this page. Owned by the route, which is what navigates afterwards. */
    onDelete: () => Promise<boolean>;
  } = $props();

  // Which field is open, if any. One at a time: the fields are stacked, and two
  // open editors on a phone is most of a screen of chrome.
  type Field = 'title' | 'tags' | 'body';
  let openField = $state<Field | null>(null);
  let editorEl = $state<HTMLDivElement | undefined>(undefined);

  let deleteOpen = $state(false);
  let deleting = $state(false);
  let historyOpen = $state(false);
  let importOpen = $state(false);

  function open(field: Field): void {
    beginLibraryEdit(page.id);
    openField = field;
  }

  async function close(): Promise<void> {
    openField = null;
    endLibraryEdit(page.id);
    // The debounce alone loses the last edit when the page is navigated away from
    // inside its window, and `writeCoalescer`'s own `pagehide` handler only covers
    // the tab going away.
    await flushLibraryWrites();
  }

  // Every edit rebuilds the WHOLE document and queues it: the write shape is
  // full-document LWW and only its timing is deferred. Failures surface as one
  // toast per burst — the coalescer hands every edit in a window the same promise,
  // so comparing against the last one toasted is what reduces the burst.
  let lastFailureToasted: Promise<unknown> | null = null;
  function edit(patch: Partial<LibraryPageDoc>): void {
    const write = queueLibraryEdit({ ...page, ...patch });
    void write.then((result) => {
      if (result.kind === 'err' && lastFailureToasted !== write) {
        lastFailureToasted = write;
        addToast("Couldn't save that change.", 'destructive');
      }
    });
  }

  // Closes only when focus has genuinely left the editor, not when it moved to
  // something inside it — `relatedTarget` is null for a tap on nothing, which is
  // "tap away" and does close.
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && editorEl?.contains(next)) return;
    void close();
  }

  /**
   * Open a modal surface over the page, having first LANDED whatever is half-typed.
   *
   * `close()` is what ends the editing session and flushes it, so what History and
   * Paste-in then act on is the text actually on screen. Skip it before a restore
   * and an open editor's pending snapshot would still be waiting when
   * `restoreLibraryRevision` calls `beginLibraryEdit` — which is idempotent, keeps
   * the older snapshot, and would quietly drop the text the restore overwrote.
   */
  async function openOver(which: 'history' | 'import'): Promise<void> {
    await close();
    if (which === 'history') historyOpen = true;
    else importOpen = true;
  }

  /**
   * Put a version back. The write is the page's, not the sheet's — one write path
   * for this document, and it is this file.
   */
  async function handleRestore(revision: LibraryPageRevisionDoc): Promise<void> {
    const write = restoreLibraryRevision(page.id, revision);
    // A restore is a deliberate act, not a keystroke: it has no burst to wait for
    // and no reason to sit out the debounce window.
    await flushLibraryWrites();
    if ((await write).kind === 'err') addToast("Couldn't restore that version.", 'destructive');
  }

  /**
   * Add pasted content to the end of this page. `appendToLibraryPage` owns the
   * flush-then-append ordering, so this is the toast and nothing else.
   */
  async function handleImport(markdown: string): Promise<void> {
    const result = await appendToLibraryPage(page.id, markdown);
    await flushLibraryWrites();
    if (result.kind === 'err') addToast("Couldn't add that to the page.", 'destructive');
  }

  async function handleDelete(): Promise<void> {
    deleting = true;
    const ok = await onDelete();
    deleting = false;
    deleteOpen = false;
    if (!ok) addToast("Couldn't delete that page.", 'destructive');
  }

  // Composed here rather than interpolated into the markup: a bare `{value}` in a
  // text node compiles to `value ?? ''`, which on a field that is always a string
  // is an arm no test can reach (the idiom `EditableZone` records).
  const editedBy = $derived(`Last edited by ${page.lastEditedBy}`);
  const tagLine = $derived(page.tags.join(', '));
</script>

<DetailPage
  title={page.title}
  {titleSlot}
  onBack={() => void goBack('/library')}
  backLabel="Library"
  {actions}
  class="p-4 sm:p-6"
>
  {#snippet children()}
    <div class="flex flex-col gap-4" data-testid="library-page-view" data-page-id={page.id}>
      <!-- ─── Tags ────────────────────────────────────────────────────────── -->
      {#if openField === 'tags'}
        <div bind:this={editorEl} onfocusout={onFocusOut}>
          <TextField
            label="Tags"
            description="Separate with commas."
            value={tagLine}
            onValueChange={(line) => edit({ tags: parseTagLine(line) })}
            data-testid="library-tags-input"
          />
        </div>
      {:else}
        <button
          type="button"
          class="flex flex-wrap items-center gap-1 self-start rounded text-left"
          onclick={() => open('tags')}
          aria-label="Edit tags"
          data-testid="library-edit-tags"
        >
          {#if page.tags.length > 0}
            {#each page.tags as tag (tag)}
              <Chip variant="tag" data-testid="library-page-tag">{tag}</Chip>
            {/each}
          {:else}
            <!-- Dashed already means "offered, not chosen" in Salt. -->
            <span
              class="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs text-muted-foreground"
            >
              + Tags
            </span>
          {/if}
        </button>
      {/if}

      <!-- ─── Body ────────────────────────────────────────────────────────── -->
      {#if openField === 'body'}
        <div bind:this={editorEl} onfocusout={onFocusOut}>
          <Textarea
            label="Page"
            placeholder="Markdown — ## headings, **bold**, - lists, and | pipe | tables |"
            value={page.body}
            onValueChange={(body) => edit({ body })}
            maxLength={LIBRARY_PAGE_BODY_MAX}
            rows={16}
            autoresize
            data-testid="library-body-input"
          />
        </div>
      {:else}
        <!-- The rendered markdown IS the read state, so there is no preview to
             switch to and the two cannot disagree. A div with a click handler
             rather than a <button>: a body contains links and tables, which are
             interactive content and invalid inside a button — and a link inside
             one would be unreachable. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="min-h-24 cursor-text rounded"
          onclick={() => open('body')}
          data-testid="library-body"
        >
          {#if page.body.trim() === ''}
            <p class="text-sm text-muted-foreground">
              Nothing written yet. Tap to start — markdown, including tables.
            </p>
          {:else}
            <Markdown text={page.body} sanitizedHtml scale="doc" />
          {/if}
        </div>
        <!-- The keyboard route in. The body region above is a mouse/touch
             affordance over content that must stay selectable and linkable; this is
             the focusable control that does the same thing. -->
        <Button
          variant="outline"
          size="sm"
          class="self-start"
          onclick={() => open('body')}
          data-testid="library-edit-body"
        >
          Edit page
        </Button>
      {/if}

      <p class="text-xs text-muted-foreground" data-testid="library-page-meta">{editedBy}</p>
    </div>
  {/snippet}
</DetailPage>

<!-- Outside the DetailPage for the same reason the delete dialog is: a restore
     re-renders the page underneath it. -->
<LibraryHistorySheet bind:open={historyOpen} revisions={page.revisions} onRestore={handleRestore} />

<LibraryImportSheet
  bind:open={importOpen}
  confirmLabel="Add to this page"
  existingBody={page.body}
  onConfirm={handleImport}
/>

<!-- Outside the DetailPage so the dialog is not torn out from under itself when
     the delete lands before the animation finishes. -->
<Dialog bind:open={deleteOpen}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="library-delete-dialog">
      <DialogHeader>
        <DialogTitle>Delete this page?</DialogTitle>
        <DialogDescription>
          It goes for everyone, and its previous versions go with it. There's no way back.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (deleteOpen = false)} disabled={deleting}>
          Keep it
        </Button>
        <Button
          variant="destructive"
          onclick={() => void handleDelete()}
          loading={deleting}
          disabled={deleting}
          data-testid="library-delete-confirm"
        >
          Delete
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

{#snippet titleSlot()}
  {#if openField === 'title'}
    <div class="w-full" bind:this={editorEl} onfocusout={onFocusOut}>
      <TextField
        label="Title"
        value={page.title}
        onValueChange={(title) => edit({ title })}
        maxlength={LIBRARY_PAGE_TITLE_MAX}
        data-testid="library-title-input"
      />
    </div>
  {:else}
    <button
      type="button"
      class="min-w-0 truncate text-left text-xl font-semibold"
      onclick={() => open('title')}
      aria-label="Edit title"
      data-testid="library-edit-title"
    >
      {page.title}
    </button>
  {/if}
{/snippet}

{#snippet actions()}
  <!-- Always offered, including on a page nobody has edited yet: the sheet says
       the history is empty, which is a fact about the page. A control that came
       and went would read as one that had broken. -->
  <Button
    variant="ghost"
    size="sm"
    onclick={() => void openOver('import')}
    data-testid="library-page-import"
  >
    Paste in
  </Button>
  <Button
    variant="ghost"
    size="sm"
    onclick={() => void openOver('history')}
    data-testid="library-page-history"
  >
    History
  </Button>
  <Button
    variant="ghost"
    size="sm"
    onclick={() => (deleteOpen = true)}
    data-testid="library-delete-page"
  >
    Delete
  </Button>
{/snippet}
