<!--
  One chef conversation: the transcript, the streaming placeholder, auto-scroll to
  the newest message and the composer. It is the ONLY implementation of any of
  those — the full chat page and the recipe page's chat column both render this,
  so a fix to either lands on both.

  What it deliberately does NOT own is anything that differs by host. The recipe
  actions, "Open full chat", "View recipe" and the panel's card chrome are the host's
  to place — each surface puts them in its own header (issue #1310). The hooks offered
  here are `starters`, the doors offered into an empty conversation, worded by the host
  exactly as `emptyText` is, and `aboveTranscript`, a snippet dropped INSIDE the
  panel's scroll box above the messages — so what the host puts there scrolls away with
  the conversation instead of costing it permanent height. There is no branching on
  which surface is rendering beyond `layout`, which is a layout choice and nothing
  more:

  - `page`  — the transcript scrolls with the document and the composer is a bar
              fixed above the bottom navigation (the /chat/:id route).
  - `panel` — the transcript scrolls inside its own box and the composer sits in
              flow beneath it, so the whole thing fits a column or a card.

  Live turn state (the partial reply, whether a send is in flight) lives in the
  `thread` controller the host passes in — see `chatThreadState.svelte.ts` for why
  it is not held here.
-->
<script lang="ts">
  import type { ChatSessionDoc } from '@salt/domain/schemas';
  import { parseChatCommand, isChatReadOnly } from '@salt/domain';
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Icon,
    Markdown,
    Spinner,
  } from '@salt/ui-components';
  import type { Snippet } from 'svelte';

  import { addToast } from '../../lib/toastStore.js';
  import { reopenChatSession } from '../../lib/chatService.js';
  import type { ChatThreadState } from './chatThreadState.svelte.js';

  interface Props {
    session: ChatSessionDoc;
    thread: ChatThreadState;
    layout: 'page' | 'panel';
    /** Shown when the conversation is empty — the invitation, worded by the host. */
    emptyText: string;
    /**
     * Doors into an EMPTY conversation, worded by the host for the same reason
     * `emptyText` is: what is worth asking about a dish is not what is worth asking
     * about cooking in general, and this component knows about neither. Each is a
     * button that sends `text` down the ordinary send path — the same turn you would
     * have got by typing it — with `label` as the short thing it says on the tin.
     *
     * Shown only while the transcript is empty: it is the blank page they answer, and
     * a conversation with content has its own next thing to say.
     *
     * `| undefined` is `exactOptionalPropertyTypes`: a host that forwards its own
     * optional value has to be able to forward the one it does not have.
     */
    starters?: { label: string; text: string }[] | undefined;
    /**
     * Host content that belongs at the TOP of the conversation and should scroll away
     * with it — the recipe page's list of chats (#737). Rendered inside the panel's
     * scroll box above the messages, so a long reply gets the column's full height and
     * the affordance is still there when you scroll back up. `panel` only: in `page`
     * layout the document scrolls and there is no box to put it in.
     *
     * Note the intended consequence: the auto-scroll-to-newest below scrolls this off
     * as soon as the conversation has content, and again when the host swaps sessions.
     */
    aboveTranscript?: Snippet | undefined;
  }
  let { session, thread, layout, emptyText, starters, aboveTranscript }: Props = $props();

  const panel = $derived(layout === 'panel');

  // Read-only after two days (issue #1270), with an explicit costed reopen. The
  // composer is the PRIMARY gate — the one shared implementation, so every host
  // inherits it — with `sendMessage` refusing again as defence-in-depth.
  const readOnly = $derived(isChatReadOnly(session, new Date()));
  let reopenDialogOpen = $state(false);
  let reopening = $state(false);

  async function handleReopen(): Promise<void> {
    reopening = true;
    const result = await reopenChatSession(session);
    reopening = false;
    if (result.kind !== 'ok') {
      addToast('Failed to reopen chat.', 'destructive');
      return;
    }
    reopenDialogOpen = false;
  }

  // Held here rather than written inline: a conditional beside a long class list is
  // exactly where a stray space becomes interior whitespace in the rendered text.
  const emptyWrapClass = $derived(`flex flex-col items-center gap-3 ${panel ? 'py-8' : 'py-12'}`);
  const emptyTextClass = $derived(
    `text-center text-muted-foreground ${panel ? 'text-xs' : 'text-sm'}`,
  );
  // `h-auto whitespace-normal` because `Button`'s sizes are fixed-height single
  // lines, and a starter has to be allowed to wrap in a 300px column.
  const starterClass = $derived(
    `h-auto whitespace-normal py-1.5 text-left ${panel ? 'text-xs' : 'text-sm'}`,
  );

  let inputText = $state('');
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let messagesEnd = $state<HTMLDivElement | undefined>(undefined);
  let scrollBox = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    // Read these reactive values so the effect re-runs and scrolls to the bottom
    // whenever messages or streaming text change — and whenever the host swaps in
    // a different conversation.
    session.id;
    session.messages.length;
    thread.streamingText;
    if (panel) {
      // The panel scrolls ITSELF. `scrollIntoView` walks every scrollable ancestor,
      // so in a column beside a recipe it drags the page with it — and "the recipe
      // does not move when you pick another chat" is the point of docking it there.
      // Optional call: jsdom lays nothing out and ships no element scroller, so in the
      // unit suite there is genuinely nothing to scroll.
      scrollBox?.scrollTo?.({ top: scrollBox.scrollHeight, behavior: 'smooth' });
    } else {
      // On the full page the document IS the scroller, so this is the right tool.
      messagesEnd?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  async function handleSend(): Promise<void> {
    const text = inputText.trim();
    if (!text || thread.isSending) return;
    // A bare `/remember` is answered HERE and nothing is sent (issue #816). The
    // typed line stays in the box so the fix is to keep typing, and the chef is
    // never asked what to make of the word "/remember" on its own.
    const command = parseChatCommand(text);
    if (command !== null && command.text === '') {
      addToast('Add what to remember after /remember — like "/remember we hate coriander".');
      return;
    }
    inputText = '';
    if (inputEl) inputEl.style.height = '';
    const ok = await thread.send(session, text);
    if (!ok) inputText = text;
  }

  // A starter leaves by the SAME send path a typed message does — `thread.send`,
  // the only one there is — but deliberately not through the input box. Staging it
  // in `inputText` would wipe a draft the user had already begun, and a failed send
  // would hand a five-paragraph canned prompt back into the textarea to delete by
  // hand; `chatThreadState` says the same thing about canned prompts from a host.
  // Nothing is lost on failure: the transcript is still empty, so the buttons are
  // still there to press again.
  async function handleStarter(text: string): Promise<void> {
    if (thread.isSending) return;
    await thread.send(session, text);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    inputText = el.value;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
</script>

{#snippet transcript()}
  {#if session.messages.length === 0 && !thread.isSending}
    <div class={emptyWrapClass}>
      <p class={emptyTextClass}>{emptyText}</p>
      {#if starters && starters.length > 0}
        <!-- Ordinary buttons in ordinary source order, so the keyboard and a screen
             reader are offered the same door as the pointer. -->
        <div
          class="flex flex-wrap justify-center gap-2"
          role="group"
          aria-label="Suggested questions"
        >
          {#each starters as starter (starter.label)}
            <Button
              size="sm"
              variant="outline"
              class={starterClass}
              disabled={thread.isSending}
              onclick={() => void handleStarter(starter.text)}
              data-testid="chat-starter"
            >
              {starter.label}
            </Button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#each session.messages as msg (msg.id)}
    <!--
      A stored `/remember …` is an ORDINARY user message (no third role on
      MessageSchema); what makes it a chip is re-parsing its text here. So the
      command needs no schema change, and a transcript written before this shipped
      renders correctly the moment the parser exists.
    -->
    {@const note = msg.role === 'user' ? parseChatCommand(msg.text) : null}
    {#if note !== null && note.text !== ''}
      <!--
        Deliberately an ASIDE, not a speech bubble: you said it, the chef did not
        answer, and the conversation simply carries on underneath. Small, quiet,
        and still on the user's side of the thread so it reads as something you did.
      -->
      <div class="flex justify-end" data-testid="chat-message-remembered">
        <div
          class="flex max-w-[85%] items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
        >
          <Icon name="StickyNote" size={12} />
          <span><span class="font-medium">Remembered</span> — {note.text}</span>
        </div>
      </div>
    {:else}
      <div
        class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}"
        data-testid="chat-message-{msg.role}"
      >
        <div
          class="text-sm {panel ? 'max-w-[90%]' : 'max-w-[85%]'} {msg.role === 'user'
            ? 'rounded-lg bg-muted px-3 py-2'
            : ''}"
        >
          {#if msg.role === 'assistant'}
            <Markdown text={msg.text} />
          {:else}
            {msg.text}
          {/if}
        </div>
      </div>
    {/if}
  {/each}

  {#if thread.isSending && thread.streamingText}
    <div class="flex justify-start" data-testid="chat-message-streaming">
      <div class="text-sm {panel ? 'max-w-[90%]' : 'max-w-[85%]'}">
        <Markdown text={thread.streamingText} />
      </div>
    </div>
  {:else if thread.isSending}
    <div class="flex items-center gap-2 text-muted-foreground {panel ? 'text-xs' : 'text-sm'}">
      <Spinner size={panel ? 12 : 14} />
      Thinking…
    </div>
  {/if}

  <div bind:this={messagesEnd}></div>
{/snippet}

{#snippet composer()}
  {#if readOnly}
    <!-- The composer's read-only counterpart (issue #1270): this chat's first
         message was sent more than two days ago, so it is browsing history —
         reopening it is an explicit, cost-warned action, not something typing
         silently does. -->
    <div
      class="flex items-center justify-between gap-3 {panel ? '' : 'mx-auto max-w-2xl'}"
      data-testid="chat-readonly-notice"
    >
      <p class="text-xs text-muted-foreground">This chat has gone quiet.</p>
      <Button
        size="sm"
        variant="outline"
        onclick={() => (reopenDialogOpen = true)}
        data-testid="chat-reopen-btn"
      >
        Make read-write
      </Button>
    </div>
  {:else}
    <div class="flex items-end {panel ? 'gap-2' : 'mx-auto max-w-2xl gap-3'}">
      <div
        class="salt-focus-ring-within flex flex-1 items-start rounded-md border border-input bg-background px-3 text-sm {thread.isSending
          ? 'opacity-50'
          : ''}"
      >
        <textarea
          bind:this={inputEl}
          class="flex-1 resize-none bg-transparent py-2 outline-none"
          rows={panel ? 1 : 3}
          placeholder="Message the chef… or /remember something"
          value={inputText}
          onkeydown={handleKeydown}
          oninput={handleInput}
          disabled={thread.isSending}
          data-testid="chat-input"></textarea>
      </div>
      <!-- Icon-only in a panel: a fifth of a 300px column spent on the word "Send" is
           width the message being typed wants more. `ariaLabel` rather than a raw
           attribute so `size="icon"` gets the name it insists on — the accessible name
           is "Send" on both layouts, which is what makes dropping the word free. -->
      <Button
        size={panel ? 'icon' : 'md'}
        onclick={handleSend}
        disabled={thread.isSending || !inputText.trim()}
        loading={thread.isSending}
        ariaLabel="Send"
        data-testid="chat-send-btn"
      >
        {#snippet leading()}<Icon name="SendHorizontal" size={16} />{/snippet}
        {#if !panel}Send{/if}
      </Button>
    </div>
  {/if}
{/snippet}

{#if panel}
  <div bind:this={scrollBox} class="min-h-0 flex-1 overflow-y-auto p-4">
    {@render aboveTranscript?.()}
    <div class="flex flex-col gap-3" data-testid="chat-messages">
      {@render transcript()}
    </div>
  </div>

  <div class="shrink-0 border-t p-3">
    {@render composer()}
  </div>
{:else}
  <!-- pb-36 keeps the last message clear of the fixed input bar -->
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 pb-36" data-testid="chat-messages">
    {@render transcript()}
  </div>

  <!-- Input bar — fixed above BottomNav on mobile, at viewport bottom on desktop -->
  <div
    class="fixed inset-x-0 bottom-14 z-20 border-t border-border bg-card px-4 py-3 lg:bottom-0"
    data-testid="chat-input-bar"
  >
    {@render composer()}
  </div>
{/if}

<Dialog
  open={reopenDialogOpen}
  onOpenChange={(v) => {
    if (!v) reopenDialogOpen = false;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Reopen this chat?</DialogTitle>
        <DialogDescription>
          Reopening means its whole history is sent to the AI again with every message, which costs
          more than a new chat. It goes quiet again two days from now unless you reopen it once
          more.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (reopenDialogOpen = false)} disabled={reopening}
          >Cancel</Button
        >
        <Button onclick={handleReopen} loading={reopening} data-testid="chat-reopen-confirm">
          Reopen
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
