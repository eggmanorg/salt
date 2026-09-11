<script lang="ts">
  import { Icon } from '@salt/ui-components';
  import { tick, type Snippet } from 'svelte';

  /**
   * One tap-to-edit region of the recipe page (issue #1319).
   *
   * The page has a mode, not always-live fields: outside `editing` this renders
   * exactly what the read page always rendered, and nothing is tappable that was
   * not tappable before. Inside it, a filled region grows a pencil beside it and
   * an EMPTY one appears as a dashed `+ Label` slot — which is most of why the
   * mode exists, since a read view cannot show what is absent without junking
   * itself up.
   *
   * The pencil is a SIBLING of the value, never a wrapper around it. Wrapping
   * would nest whatever the region draws — a link, a row of chips — inside a
   * `<button>`, which is invalid for interactive content and would swallow taps
   * the read page still needs. It is also the idiom of the two in-place editors
   * this repo already has (`EquipmentEditPage`, `EditableRecordTitle`).
   *
   * There is no Save and no Cancel anywhere in this feature, so `close` means "I
   * am finished with this field", never "discard". Escape closes the editor and
   * KEEPS what is typed, because by then it has already been written — an Escape
   * that reverted would need an undo buffer this design does not have, and a key
   * that silently binned an edit is one of the two data-loss defects the feature
   * exists to remove.
   */
  let {
    editing,
    filled,
    label,
    slotLabel = '',
    testId,
    class: className = '',
    onOpen,
    view,
    edit,
  }: {
    /** Is the page in edit mode? */
    editing: boolean;
    /** Does the recipe actually have a value here? Drives read-mode visibility. */
    filled: boolean;
    /** Accessible name of the edit affordance, e.g. "Edit servings". */
    label: string;
    /** The dashed slot's words: "Servings" renders `+ Servings`. */
    slotLabel?: string;
    testId?: string;
    class?: string;
    /** Fired as the editor opens — where the caller seeds its draft. */
    onOpen?: () => void;
    /** How the value reads. Rendered in both modes; never interactive. */
    view: Snippet;
    /** The editor. Mounted only while active; `close` finishes the field. */
    edit: Snippet<[() => void]>;
  } = $props();

  // Both composed here rather than interpolated into the markup: a `{value}`
  // inside an attribute or a text node compiles to `value ?? ''`, and on a prop
  // that is always a string that fallback is a branch no test can ever reach.
  const wrapperClass = $derived(`flex min-w-0 items-start gap-1.5 ${className}`);
  const slotText = $derived(`+ ${slotLabel}`);

  let active = $state(false);
  let editEl = $state<HTMLDivElement | undefined>(undefined);

  // Leaving edit mode closes every open editor. Done is the one gesture that ends
  // editing, so a field left open would otherwise still be a text box on a page
  // that now says it is being read.
  $effect(() => {
    if (!editing) active = false;
  });

  async function open(): Promise<void> {
    onOpen?.();
    active = true;
    // One focus call for every field rather than an `autofocus` per input: the
    // attribute is set by Svelte AFTER insertion, which is too late for the
    // browser to honour it. The first text control is the field's own — the
    // pickers that have none (a Select, a Combobox trigger) simply get nothing,
    // which is the right answer for a control opened by a tap on it.
    await tick();
    editEl?.querySelector<HTMLElement>('input, textarea')?.focus();
  }

  function close(): void {
    active = false;
  }
</script>

{#if active && editing}
  <div class="w-full min-w-0" bind:this={editEl}>
    {@render edit(close)}
  </div>
{:else if filled}
  <div class={wrapperClass}>
    {@render view()}
    {#if editing}
      <button
        type="button"
        class="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => void open()}
        aria-label={label}
        data-testid={testId}
      >
        <Icon name="Pencil" size={14} />
      </button>
    {/if}
  </div>
{:else if editing}
  <!-- Dashed already means "offered, not chosen" in Salt — it is what a tag
       suggestion looks like — so an absent field borrows that vocabulary rather
       than inventing one. -->
  <button
    type="button"
    class="inline-flex items-center gap-1 self-start rounded border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
    onclick={() => void open()}
    aria-label={label}
    data-testid={testId}
  >
    {slotText}
  </button>
{/if}
