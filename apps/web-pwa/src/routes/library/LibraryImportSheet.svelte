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
    Textarea,
  } from '@salt/ui-components';
  import { LIBRARY_PAGE_BODY_MAX } from '@salt/domain/schemas';
  import { appendedBody, htmlToMarkdown } from '../../lib/libraryImport.js';

  /**
   * Getting a sous vide table out of a website and into the library (issue #1375).
   *
   * ─── THE PASTE IS READ AS HTML, NOT AS TEXT ─────────────────────────────────
   *
   * A `paste` carries both `text/html` and `text/plain`. Taking the plain text
   * gets a table as space-separated gibberish and makes the converter pointless,
   * so the HTML is read when it is there and converted on the way in. When it is
   * NOT there — a paste out of a plain-text editor — nothing is intercepted at
   * all and the browser's own insertion lands the text verbatim, which is both
   * the correct result and one less code path to keep true.
   *
   * What lands is markdown in an editable box, not a preview of someone else's
   * HTML: it can be tidied here before it is saved, and it is the same text the
   * page will hold.
   *
   * ─── IT KNOWS NOTHING ABOUT THE SERVICE ─────────────────────────────────────
   *
   * Like `LibraryHistorySheet`, it takes a string and hands one back. The two
   * callers differ only in what they do with it — the list makes a new page, the
   * page appends — so the confirm's wording is a prop and the write is theirs.
   *
   * ─── THE LENGTH REFUSAL ─────────────────────────────────────────────────────
   *
   * Over-long content is refused here with a message rather than truncated, and
   * the sum is `appendedBody(...).length`, computed by the same function the write
   * uses. That is not fussiness: `LIBRARY_PAGE_BODY_MAX` is a Zod `.max()`, so a
   * body written past it is a page that fails to parse on the next read and
   * disappears from the list. The box therefore carries NO `maxLength` — the
   * attribute would silently cut a paste off at the limit, which is the one
   * behaviour the spec rules out.
   */

  interface Props {
    open: boolean;
    /** What the confirm does, in the reader's words. */
    confirmLabel: string;
    /** The body this would be added to. Empty when the import makes a new page. */
    existingBody?: string;
    /** Save it. Resolves when the write has been issued. */
    onConfirm: (markdown: string) => Promise<void>;
  }
  let { open = $bindable(), confirmLabel, existingBody = '', onConfirm }: Props = $props();

  let markdown = $state('');
  let saving = $state(false);

  // Re-seed on each open: the sheet is mounted for the life of the page, so
  // without this the second import would open holding the first one's text.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) markdown = '';
    wasOpen = open;
  });

  const tooLong = $derived(appendedBody(existingBody, markdown).length > LIBRARY_PAGE_BODY_MAX);
  const ready = $derived(markdown.trim() !== '' && !tooLong && !saving);

  function handlePaste(event: ClipboardEvent): void {
    const html = event.clipboardData?.getData('text/html') ?? '';
    // No HTML on the clipboard: let the browser paste the plain text itself.
    if (html.trim() === '') return;
    event.preventDefault();
    // Added to what is already staged rather than replacing it, so a second paste
    // does not silently throw away the first and any tidying done to it. At the
    // end rather than at the caret: this box is a staging area for whole chunks of
    // a web page, and caret-precise insertion would buy a DOM selection dance and
    // a second source of truth for the text. `appendedBody` is the same joiner the
    // page itself appends with, so the blank line is the same blank line.
    markdown = appendedBody(markdown, htmlToMarkdown(html));
  }

  async function confirm(): Promise<void> {
    saving = true;
    await onConfirm(markdown.trim());
    saving = false;
    open = false;
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Paste it in</SheetTitle>
      <SheetDescription>
        Copy from a website and paste here. Headings, lists and tables come across as markdown.
      </SheetDescription>
    </SheetHeader>

    <div class="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <Textarea
        label="Pasted content"
        placeholder="Paste here…"
        bind:value={markdown}
        onpaste={handlePaste}
        rows={6}
        error={tooLong
          ? 'That is too long for one page. Paste less of it, or start a new page.'
          : undefined}
        data-testid="library-import-input"
      />

      {#if markdown.trim() !== ''}
        <!-- Exactly what saving will produce: the same renderer and the same
             document scale the page body uses. -->
        <div
          class="salt-md-doc rounded border border-border p-3"
          data-testid="library-import-preview"
        >
          <Markdown text={markdown} />
        </div>
      {/if}
    </div>

    <SheetFooter>
      <Button
        variant="outline"
        onclick={() => (open = false)}
        disabled={saving}
        data-testid="library-import-cancel"
      >
        Cancel
      </Button>
      <Button
        onclick={() => void confirm()}
        loading={saving}
        disabled={!ready}
        data-testid="library-import-confirm"
      >
        {confirmLabel}
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>

<style>
  /* The page body's document scale, so the preview is the size the page will be. */
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
