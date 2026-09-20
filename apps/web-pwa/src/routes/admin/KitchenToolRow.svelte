<script lang="ts">
  import {
    CanonIcon,
    DisclosureChevron,
    DisclosureTrigger,
    EditableRow,
  } from '@salt/ui-components';
  import type { KitchenToolDoc } from '@salt/domain/schemas';
  import KitchenToolNameRow from './KitchenToolNameRow.svelte';

  /**
   * One kitchen tool in the vocabulary list (issue #1489) — the Catalog's row
   * shape on a sibling page, NOT a Catalog component reused: `CatalogRow` is
   * typed on `{ kind: 'canon' | 'form' }` and carries aisle, shopping behaviour,
   * threshold and an approval queue, none of which a tool has.
   *
   * The row displays; the editor edits. The one thing it does in place is open
   * onto the other names the tool answers to — a truncated comma list is the
   * mechanic this page existed to stop, and a name you cannot act on where it is
   * written is the same complaint one step further in.
   */
  let {
    tool,
    expanded,
    onToggle,
    open,
    onOpen,
    onRemoveName,
  }: {
    tool: KitchenToolDoc;
    expanded: boolean;
    onToggle: () => void;
    /** Is the editor on this tool, so the row reads as the active one. */
    open: boolean;
    onOpen: (id: string) => void;
    onRemoveName: (tool: KitchenToolDoc, phrase: string) => void;
  } = $props();

  const otherNames = $derived(tool.matchers.length);
</script>

<!-- The compact row. `EditableRow` renders BOTH snippets into the DOM and hides
     one with CSS, so every testid carries which copy it is — a shared id would
     resolve twice (the trap `CatalogRow` documented). -->
{#snippet label(which: 'narrow' | 'wide')}
  <div
    class="flex min-w-0 flex-1 items-center gap-2"
    data-testid="kitchen-tool-row-{which}"
    data-kit-tool-id={tool.id}
  >
    <!--
      40px, the primary-list-row rung (ui-spec-v04 §14.6.1) and the size the
      asset's framing is tuned for. `version` is the cache-bust nonce (§14.4): a
      regenerated icon reuses the SAME immutable Storage URL, so without it the
      browser keeps serving the picture you just replaced.
    -->
    <CanonIcon
      thumbnail={tool.thumbnail}
      name={tool.label}
      size={40}
      version={tool.iconRequestedAt ?? tool.updatedAt}
    />
    <button
      type="button"
      class="salt-focus-ring-inset min-w-0 flex-1 text-left"
      onclick={() => onOpen(tool.id)}
      data-testid="kitchen-tool-row-name-{which}"
    >
      <span class="block truncate text-sm font-medium">{tool.label}</span>
      {#if otherNames > 0}
        <span
          class="block truncate text-xs text-muted-foreground"
          data-testid="kitchen-tool-row-count-{which}"
        >
          {otherNames} other name{otherNames === 1 ? '' : 's'}
        </span>
      {/if}
    </button>
    {#if otherNames > 0}
      <DisclosureTrigger
        {expanded}
        class="shrink-0 rounded p-1 text-muted-foreground"
        onclick={onToggle}
        aria-label="{expanded ? 'Hide' : 'Show'} the other names for {tool.label}"
        data-testid="kitchen-tool-row-disclosure-{which}"
      >
        <DisclosureChevron {expanded} size={14} />
      </DisclosureTrigger>
    {/if}
  </div>
{/snippet}

<EditableRow selected={open}>
  {#snippet narrow()}{@render label('narrow')}{/snippet}
  {#snippet wide()}{@render label('wide')}{/snippet}
</EditableRow>

<!-- The reveal — a sibling row rather than something inside the one above, so it
     renders ONCE at every breakpoint however the row itself is laid out. -->
{#if expanded && otherNames > 0}
  <li data-testid="kitchen-tool-row-body">
    <ul class="flex flex-col gap-1 pl-4">
      {#each tool.matchers as phrase (phrase)}
        <KitchenToolNameRow
          {phrase}
          toolLabel={tool.label}
          testidPrefix="kitchen-tool-list-name"
          onRemove={() => onRemoveName(tool, phrase)}
        />
      {/each}
    </ul>
  </li>
{/if}
