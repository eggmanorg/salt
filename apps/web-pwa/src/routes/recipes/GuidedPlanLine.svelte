<script lang="ts">
  import { untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { TextField, Textarea } from '@salt/ui-components';

  // ONE LINE OF A GUIDED PLAN, read until you tap it (issue #1453).
  //
  // The review screen has no Save, so it has no form: every line is drawn the way
  // the cook will see it and becomes a box only while it is being changed. Enter
  // (or tapping away) writes it; Escape leaves it as it was.
  //
  // `onCommit` fires only when the text actually CHANGED, which is what lets the
  // "+ cue" row open a blank line safely — opening one and thinking better of it
  // writes nothing, so an abandoned add leaves no empty field in the document.
  // `onClose` fires either way, and is how the parent forgets it was adding.

  let {
    value,
    ariaLabel,
    placeholder = '',
    multiline = false,
    numeric = false,
    startOpen = false,
    onCommit,
    onClose,
    children,
    class: className = '',
  }: {
    value: string;
    ariaLabel: string;
    placeholder?: string;
    multiline?: boolean;
    numeric?: boolean;
    startOpen?: boolean;
    onCommit: (next: string) => void;
    onClose?: () => void;
    children: Snippet;
    class?: string;
  } = $props();

  // Both are SEEDS, not bindings — `untrack` says so rather than leaving it to a
  // compiler warning. A line the user has open must not be yanked shut, or have
  // its half-typed draft replaced, because the optimistic store echoed a value
  // back while they were typing.
  let editing = $state(untrack(() => startOpen));
  let draft = $state(untrack(() => value));
  let box = $state<HTMLElement | null>(null);

  // The field does not exist until the branch below renders it, so there is
  // nothing to focus before then. `autofocus` would do this in a browser and
  // nothing in jsdom, which would leave the tests typing into a field the user
  // could not have been typing into.
  $effect(() => {
    if (editing) box?.querySelector<HTMLElement>('input, textarea')?.focus();
  });

  function open(): void {
    draft = value;
    editing = true;
  }

  function commit(): void {
    if (!editing) return;
    editing = false;
    const next = draft.trim();
    if (next !== value.trim()) onCommit(next);
    onClose?.();
  }

  function cancel(): void {
    editing = false;
    onClose?.();
  }

  function onkeydown(event: KeyboardEvent): void {
    // Enter writes a single-line field. A multi-line one keeps Enter for a new
    // line, so there the write is tapping away — the gesture every other line
    // also accepts.
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }
</script>

{#if editing}
  <div bind:this={box} class={className}>
    {#if multiline}
      <Textarea
        rows={2}
        autoresize
        bind:value={draft}
        aria-label={ariaLabel}
        {placeholder}
        onblur={commit}
        {onkeydown}
        data-testid="guided-plan-line-input"
      />
    {:else}
      <TextField
        bind:value={draft}
        aria-label={ariaLabel}
        {placeholder}
        inputmode={numeric ? 'numeric' : undefined}
        onblur={commit}
        {onkeydown}
        data-testid="guided-plan-line-input"
      />
    {/if}
  </div>
{:else}
  <button
    type="button"
    class="rounded text-left transition-colors hover:bg-muted/50 {className}"
    aria-label="Change {ariaLabel}"
    onclick={open}
    data-testid="guided-plan-line"
  >
    {@render children()}
  </button>
{/if}
