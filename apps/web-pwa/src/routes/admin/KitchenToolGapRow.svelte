<script lang="ts">
  import {
    Button,
    CanonIcon,
    Icon,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
  } from '@salt/ui-components';
  import type { KitchenToolDoc, KitchenToolProposal } from '@salt/domain/schemas';

  /**
   * One word the library already uses that nothing draws (issue #1489, Phase 3).
   *
   * A ROW IN THE SAME LIST, not a queue of its own. Until #1489 this was a
   * separate section with its own markup, its own buttons and its own dialog —
   * a third mechanic on a page that already had two. An aliased phrase and an
   * unrecognised phrase are the same thing (a word with no picture of its own),
   * differing only in whether a tool has claimed it yet, so they wear the same
   * row shape and offer the same verbs.
   *
   * THERE IS NO DOCUMENT BEHIND IT. Nothing here opens the editor: the name is
   * plain text rather than a button, because an editor over a record that does
   * not exist is a lie and every field in it would have to be disabled. The row
   * disappears the moment the vocabulary can name the word — no reread, no
   * rewrite, no page reload.
   *
   * TWO VERBS, NOT THREE. Remove is absent, and deliberately: the word is in the
   * library's own content, and this page curates the vocabulary rather than the
   * recipes and plans that read it.
   *
   * THE SHELL IS `EditableRow`'S CLASSES, NOT `EditableRow`. Its siblings in the
   * vocabulary list use the component, and they need it: it renders a narrow and
   * a wide snippet and hides one with CSS, which is how `CatalogRow` lays a
   * record out differently on a phone. A gap row is identical at every
   * breakpoint, has no selection state and no checkbox, so the component would
   * buy it nothing and cost it a second copy of its own popover menu in the DOM.
   * This is the same call `KitchenToolNameRow` and `shoppingRowShell.ts` (#930)
   * already make. The shell string is copied, so a change to `EditableRow`'s own
   * padding or border does NOT reach this row — check it by eye if you move one.
   */
  let {
    label,
    count,
    suggestion,
    proposal,
    suggestBusy,
    suggestDisabled,
    onAcceptSuggestion,
    onMakeTool,
    onAlias,
  }: {
    label: string;
    /** How many times the library says it — recipe kit labels plus plan containers. */
    count: number;
    /**
     * The tool this row's one press would alias the word to, or `null` when there
     * is none and "Make it a tool" leads instead.
     *
     * THE PAGE DECIDES THIS, NOT THIS COMPONENT (issue #1458, Phase 2). It is
     * `suggestKitchenToolParent`'s head-noun guess until Salt's proposal arrives
     * and the tool Salt named where it has, so the sentence below and the button
     * beside it are two readings of ONE value and cannot come to disagree.
     */
    suggestion: KitchenToolDoc | null;
    /**
     * Salt's own answer for this word, or `null` before one arrives and whenever
     * the model had nothing to say (issue #1458, Phase 2).
     *
     * A SENTENCE AND NOTHING ELSE. It changes no verb on this row: there is no
     * accept button of its own, because accepting it IS the press the row already
     * carries, and there is no dismiss, because a word this page cannot name is
     * the library's own content and there is nowhere honest to record that
     * somebody disagreed. The menu overrides it in one press either way.
     */
    proposal: KitchenToolProposal | null;
    suggestBusy: boolean;
    suggestDisabled: boolean;
    onAcceptSuggestion: () => void;
    /** Mint a tool for this word. Opens the pre-filled Add dialog, which is where
     *  the near-duplicate warning lives (#956's bloat defence). */
    onMakeTool: () => void;
    /** Hand this word to a tool that already draws. Opens the shared move dialog. */
    onAlias: () => void;
  } = $props();

  let menuOpen = $state(false);

  // The menu's accessible name is built here, and the suggestion's below, inside
  // the `{#if}` that guarantees there is one. Neither is interpolated into the
  // markup, because a template inside an attribute or a mixed text node compiles
  // to `${x ?? ''}` — a null arm no test can ever reach, and so a permanently
  // uncovered branch on the coverage ratchet for no behaviour at all. A whole
  // expression set directly carries no such arm.
  const actionsLabel = $derived(`Actions for “${label}”`);

  // Salt's answer in plain words, built whole for the same reason `actionsLabel`
  // is. `null` is "say nothing": no proposal yet, or an alias whose tool the page
  // could not find, which it reports by passing `proposal: null` rather than by
  // leaving this to guess.
  //
  // THE ALIAS SENTENCE READS `suggestion`, NOT THE PROPOSAL'S OWN `toolId`. That
  // is what makes the sentence and the button one statement: whatever tool the
  // page put on this row is the tool the words name, so the two cannot drift.
  const proposalSentence = $derived.by((): string | null => {
    if (proposal === null) return null;
    if (proposal.kind === 'not-kit') return 'Salt thinks this is not a piece of kit at all.';
    if (proposal.kind === 'new')
      return `Salt thinks this is a new tool — call it ${proposal.suggestedLabel}.`;
    return suggestion === null ? null : `Salt thinks this is another name for ${suggestion.label}.`;
  });
</script>

<li
  class="flex items-center gap-3 rounded border border-border bg-card px-3 py-2"
  data-testid="kitchen-tool-gap-row"
  data-kit-label={label}
>
  <!-- A bare tile at the same 40px rung as a drawn tool's (ui-spec-v04 §14.6.1),
       so the two groups read as one list and the text column stays straight.
       `thumbnail={null}` is the honest value: there is no document, so there is
       nothing that could have a picture. -->
  <CanonIcon thumbnail={null} name={label} size={40} />
  <!-- Plain text, not a button. #1458 Phase 2 hangs its AI proposal sentence off
       this column, below the marker line. -->
  <div class="min-w-0 flex-1">
    <span class="block truncate text-sm font-medium">{label}</span>
    <span class="block truncate text-xs text-muted-foreground">
      Not drawn yet · said
      <span data-testid="kitchen-tool-gap-count">{count}</span>
      time{count === 1 ? '' : 's'}
    </span>
    <!-- Salt's proposal, below the marker line (issue #1458, Phase 2). NOT
         truncated: the sentence is the whole of what this phase adds and a word
         cut off mid-name is worth less than the row's extra line. -->
    {#if proposalSentence}
      <span class="block text-xs text-muted-foreground" data-testid="kitchen-tool-gap-proposal"
        >{proposalSentence}</span
      >
    {/if}
  </div>
  <!--
    THE FREE ACTION LEADS. Aliasing reuses a picture the vocabulary already has;
    minting a tool spends a Gemini image and a document, and does it again for the
    next adjective. Where Salt can name a likely parent the one-press alias is
    solid and everything else is in the menu; where it cannot, there is no free
    single press to offer and "Make it a tool" is the right first move.
  -->
  {#if suggestion}
    {@const suggestLabel = `Also call it ${suggestion.label}`}
    <Button
      size="sm"
      onclick={onAcceptSuggestion}
      loading={suggestBusy}
      disabled={suggestDisabled}
      data-testid="kitchen-tool-gap-suggest"
    >
      {suggestLabel}
    </Button>
  {:else}
    <Button size="sm" onclick={onMakeTool} data-testid="kitchen-tool-gap-new">
      Make it a tool
    </Button>
  {/if}
  <Popover bind:open={menuOpen}>
    <PopoverTrigger>
      {#snippet children()}
        <button
          type="button"
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={actionsLabel}
          data-testid="kitchen-tool-gap-menu"
        >
          <Icon name="EllipsisVertical" size={16} />
        </button>
      {/snippet}
    </PopoverTrigger>
    <!-- The same two verbs a name row carries, in the same order and the same
         words — cheapest first, and the expensive one says what it costs rather
         than a confirmation asking whether you meant it. -->
    <PopoverContent align="end" class="min-w-56 p-1">
      <PopoverMenuItem
        icon="ArrowRight"
        onclick={() => {
          menuOpen = false;
          onAlias();
        }}
        data-testid="kitchen-tool-gap-alias"
      >
        Make it another name for…
      </PopoverMenuItem>
      <PopoverMenuItem
        icon="ImagePlus"
        onclick={() => {
          menuOpen = false;
          onMakeTool();
        }}
        data-testid="kitchen-tool-gap-promote"
      >
        Give it its own picture — draws a new one
      </PopoverMenuItem>
    </PopoverContent>
  </Popover>
</li>
