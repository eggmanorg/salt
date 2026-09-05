<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';

  // Page-local on purpose (issue #717). The recipe notes editor is the only
  // consumer today; the repo's rule is to promote a page-local pattern into
  // @salt/ui-components on a second consumer, not speculatively. If another
  // field ever wants the same three buttons, promote this then.

  interface Props {
    /** The notes <textarea>, via `bind:element` on the shared Textarea. */
    element: HTMLTextAreaElement | undefined;
  }
  let { element }: Props = $props();

  // Every action here works on the live DOM node rather than on the bound
  // string, because what it needs — where the caret is, what is selected — only
  // exists on the node. `setRangeText` deliberately does not fire an `input`
  // event, so each action dispatches one; that is what feeds the edit back
  // through Textarea's own handler into `draft.notes`, keeping one source of
  // truth for the text.
  //
  // Selection is read before focusing: a textarea keeps `selectionStart` /
  // `selectionEnd` across a blur, so tapping a toolbar button does not lose the
  // range, and `focus()` restores it.
  function commit(el: HTMLTextAreaElement): void {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Wrap the selection in `marker`; with no selection, insert the pair and sit between them. */
  function wrap(marker: string): void {
    const el = element;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = el.value.slice(start, end);

    el.focus();
    el.setRangeText(`${marker}${selected}${marker}`, start, end, 'end');
    if (start === end) {
      const caret = start + marker.length;
      el.setSelectionRange(caret, caret);
    }
    commit(el);
  }

  /**
   * Prefix every touched line with `- `. The selection is widened to whole
   * lines first, so a mid-word caret still turns its own line into a bullet.
   * Lines that are already bullets are left alone rather than becoming `- - x`.
   */
  function bulletList(): void {
    const el = element;
    if (!el) return;
    const text = el.value;
    const lineStart = text.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const nextNewline = text.indexOf('\n', el.selectionEnd);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;

    const bulleted = text
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((line) => (line.trimStart().startsWith('- ') ? line : `- ${line}`))
      .join('\n');

    el.focus();
    el.setRangeText(bulleted, lineStart, lineEnd, 'end');
    commit(el);
  }
</script>

<div class="flex items-center gap-1" role="group" aria-label="Notes formatting">
  <Button
    size="icon"
    variant="ghost"
    ariaLabel="Bold"
    onclick={() => wrap('**')}
    data-testid="recipe-notes-bold-btn"
  >
    <Icon name="Bold" size={16} />
  </Button>
  <Button
    size="icon"
    variant="ghost"
    ariaLabel="Italic"
    onclick={() => wrap('*')}
    data-testid="recipe-notes-italic-btn"
  >
    <Icon name="Italic" size={16} />
  </Button>
  <Button
    size="icon"
    variant="ghost"
    ariaLabel="Bulleted list"
    onclick={bulletList}
    data-testid="recipe-notes-list-btn"
  >
    <Icon name="List" size={16} />
  </Button>
</div>
