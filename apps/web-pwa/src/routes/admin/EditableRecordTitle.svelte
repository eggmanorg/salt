<script lang="ts">
  import { Icon } from '@salt/ui-components';

  /**
   * The inline-editable identity field of a catalog record (issue #872), rendered
   * into `DetailPage`'s `titleSlot`. A canon item edits its `name` here; a product
   * form edits its `label`.
   *
   * The commit contract (issue #872): blur saves, Enter is a convenience, Escape
   * reverts. Blur must NEVER discard — the previous canon page threw the typed
   * name away on blur, which silently lost every rename that ended with a click
   * somewhere else.
   */
  let {
    value,
    display,
    testId,
    editLabel = 'Edit name',
    error = '',
    onCommit,
  }: {
    /** The record's STORED value — what editing starts from and what Escape reverts to. */
    value: string;
    /** How the value reads when not being edited (title-cased, usually). */
    display: string;
    testId: string;
    editLabel?: string;
    error?: string;
    /** Called with the trimmed draft. The caller decides whether it is a no-op. */
    onCommit: (next: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let input = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    if (editing && input) {
      input.focus();
      input.select();
    }
  });

  function start(): void {
    draft = value;
    editing = true;
  }

  // One exit path for all three gestures. `editing` flips FIRST, so the blur that
  // follows an Enter/Escape exit re-enters here and returns immediately instead of
  // committing a second time (or committing the value Escape just discarded).
  function finish(save: boolean): void {
    if (!editing) return;
    editing = false;
    if (save) onCommit(draft.trim());
  }
</script>

{#if editing}
  <input
    bind:this={input}
    data-testid={testId}
    class="text-2xl font-semibold tracking-tight text-foreground bg-transparent border-b border-foreground/30 w-full min-w-0"
    value={draft}
    oninput={(e) => (draft = e.currentTarget.value)}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        finish(false);
      }
    }}
    onblur={() => finish(true)}
  />
{:else}
  <div class="min-w-0">
    <div class="flex items-center gap-2">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground truncate">{display}</h1>
      <button
        class="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        onclick={start}
        aria-label={editLabel}
        type="button"
      >
        <Icon name="Pencil" size={14} />
      </button>
    </div>
    {#if error}
      <span class="text-sm text-destructive">{error}</span>
    {/if}
  </div>
{/if}
