<!--
  Every chat about this dish, on the dish (issue #696). The recipe is the home for
  its own conversations: each entry carries its title, the last thing said and
  when, and tapping one carries on where you left off. The chat a recipe was
  WRITTEN from is in here too — it claims the recipe on "Save as recipe" — so the
  origin story stops disappearing.

  The host owns what "open" means: on a phone it navigates (Phase 2) and later
  raises the drawer; in a column it swaps the docked pane.
-->
<script lang="ts">
  import { formatChatTimestamp } from '../../lib/dateFormat.js';
  import type { ChatSessionDoc } from '@salt/domain/schemas';
  import { isChatReadOnly } from '@salt/domain';
  import { Button, Card, CardContent, CardHeader, CardTitle, Icon } from '@salt/ui-components';

  interface Props {
    /** Already filtered to this recipe and sorted newest first — see recipeChats.ts. */
    chats: readonly ChatSessionDoc[];
    /** The one currently on screen, so the list can mark it. Null when none is. */
    activeId?: string | null;
    onSelect: (session: ChatSessionDoc) => void;
    onNew: () => void;
    creating?: boolean;
  }
  let { chats, activeId = null, onSelect, onNew, creating = false }: Props = $props();

  function lastSaid(session: ChatSessionDoc): string {
    return session.messages.at(-1)?.text.trim() ?? 'No messages yet.';
  }
</script>

<!-- Card takes no rest props, so the testid rides on a wrapper (as recipe-hero does). -->
<div data-testid="recipe-chat-list">
  <Card>
    <CardHeader class="flex flex-row items-center justify-between gap-3 px-4 pt-4 pb-0">
      <CardTitle class="text-sm">Chef chats</CardTitle>
      <Button
        size="sm"
        variant="outline"
        onclick={onNew}
        loading={creating}
        disabled={creating}
        data-testid="recipe-chat-new-btn"
      >
        {#snippet leading()}<Icon name="ChefHat" size={14} />{/snippet}
        New chat
      </Button>
    </CardHeader>
    <CardContent class="px-4 pt-3 pb-4">
      {#if chats.length === 0}
        <p class="text-sm text-muted-foreground">
          No chats about this yet. Ask the chef to scale it, swap something out, or talk you through
          a step.
        </p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each chats as session (session.id)}
            <li>
              <button
                type="button"
                class="flex w-full flex-col gap-0.5 rounded border px-3 py-2 text-left transition-colors hover:bg-accent {session.id ===
                activeId
                  ? 'border-primary bg-accent'
                  : 'border-border'}"
                onclick={() => onSelect(session)}
                data-testid="recipe-chat-list-item"
              >
                <span class="flex items-baseline justify-between gap-3">
                  <span class="min-w-0 truncate text-sm font-medium">{session.title}</span>
                  <span class="shrink-0 text-xs text-muted-foreground"
                    >{formatChatTimestamp(
                      session.updatedAt,
                    )}{#if isChatReadOnly(session, new Date())}
                      · Read-only{/if}</span
                  >
                </span>
                <span class="truncate text-xs text-muted-foreground">{lastSaid(session)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </CardContent>
  </Card>
</div>
