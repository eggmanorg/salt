<script lang="ts">
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Icon,
    ListPage,
  } from '@salt/ui-components';
  import { push, router } from 'svelte-spa-router';
  import { isChatReadOnly } from '@salt/domain';
  import { formatChatTimestamp } from '../../lib/dateFormat.js';
  import { auth } from '../../lib/auth.svelte.js';
  import { readMealParam, withMealParam } from '../../lib/mealReturn.js';
  import {
    sessions,
    isLoadingSessions,
    createChatSession,
    removeSession,
  } from '../../lib/chatService.js';
  import { addToast } from '../../lib/toastStore.js';

  const sorted = $derived([...$sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

  // This list is a WAYPOINT when a meal sent you here to invent a dish (issue
  // #752, Phase 3): "Chat with AI" lands on /chat, and the session it makes is
  // the second hop. The meal rides the URL through both, so a reload on either
  // one still knows where it is going back to.
  const mealReturnId = $derived(readMealParam(router.querystring));

  let creating = $state(false);

  async function handleNew(): Promise<void> {
    const uid = auth.user?.uid;
    if (!uid) return;
    creating = true;
    const result = await createChatSession(uid, null);
    creating = false;
    if (result.kind !== 'ok') {
      addToast('Failed to create chat.', 'destructive');
      return;
    }
    push(withMealParam(`/chat/${result.value.id}`, mealReturnId));
  }

  let deleteId = $state<string | null>(null);
  let deleteBusy = $state(false);

  async function handleDelete(): Promise<void> {
    if (!deleteId) return;
    deleteBusy = true;
    const result = await removeSession(deleteId);
    deleteBusy = false;
    deleteId = null;
    if (result.kind !== 'ok') {
      addToast('Failed to delete chat.', 'destructive');
    }
  }
</script>

<ListPage
  title="Chef"
  description="Ask your kitchen assistant anything."
  isLoading={$isLoadingSessions}
  isEmpty={sorted.length === 0}
  class="p-4 sm:p-6"
>
  {#snippet actions()}
    <!--
      The way in to "What I remember" (issue #816). It belongs beside the chats
      rather than in the app nav: the notes exist to shape what the chef says, so
      the place you go to check them is the place you go to talk to it.
    -->
    <Button
      size="sm"
      variant="outline"
      onclick={() => push('/chat/remembered')}
      data-testid="chat-memory-btn"
    >
      {#snippet leading()}<Icon name="StickyNote" size={14} />{/snippet}
      What I remember
    </Button>
    <Button
      size="sm"
      onclick={handleNew}
      loading={creating}
      disabled={creating}
      data-testid="chat-new-btn"
    >
      New chat
    </Button>
  {/snippet}

  {#snippet empty()}
    <EmptyState title="No chats yet.">
      {#snippet actions()}
        <Button size="sm" onclick={handleNew} loading={creating} disabled={creating}>
          Start your first chat
        </Button>
      {/snippet}
    </EmptyState>
  {/snippet}

  {#snippet children()}
    <ul class="flex flex-col gap-1" data-testid="chat-session-list">
      {#each sorted as session (session.id)}
        <li class="flex items-center gap-3 rounded border border-border bg-card px-3 py-2 text-sm">
          <button
            class="min-w-0 flex-1 text-left"
            onclick={() => push(`/chat/${session.id}`)}
            data-testid="chat-session-item"
          >
            <span class="block truncate font-medium">{session.title}</span>
            <span class="block text-xs text-muted-foreground">
              {formatChatTimestamp(session.updatedAt)}{#if session.recipeId}
                · recipe{/if}{#if isChatReadOnly(session, new Date())}
                · Read-only{/if}
            </span>
          </button>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (deleteId = session.id)}
            aria-label="Delete chat"
          >
            <Icon name="Trash2" size={14} />
          </Button>
        </li>
      {/each}
    </ul>
  {/snippet}
</ListPage>

<Dialog
  open={deleteId !== null}
  onOpenChange={(v) => {
    if (!v) deleteId = null;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Delete chat?</DialogTitle>
        <DialogDescription>This action cannot be undone.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (deleteId = null)} disabled={deleteBusy}
          >Cancel</Button
        >
        <Button
          variant="destructive"
          onclick={handleDelete}
          loading={deleteBusy}
          disabled={deleteBusy}
          data-testid="chat-delete-confirm"
        >
          Delete
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
