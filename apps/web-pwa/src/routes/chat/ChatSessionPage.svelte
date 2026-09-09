<script lang="ts">
  import {
    Button,
    DetailPage,
    Icon,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
    Spinner,
  } from '@salt/ui-components';
  import { push, router } from 'svelte-spa-router';
  import { goBack } from '../../lib/nav.js';
  import { sessions, isLoadingSessions, claimRecipe } from '../../lib/chatService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { recipes, attachComponentToMeal } from '../../lib/recipeService.js';
  import { readMealParam } from '../../lib/mealReturn.js';
  import { authorRecipeFromChat } from '../../lib/chatRecipeAuthor.js';
  import {
    proposeRecipeAmendment,
    applyRecipeAmendment,
    type RecipeAmendment,
  } from '../../lib/recipeAmend.js';
  import type { Recipe } from '@salt/domain';
  import type { ChatSessionDoc } from '@salt/domain/schemas';
  import { KIND_COPY, kindOf } from '../recipes/recipeKind.js';
  import RecipeChangeSummary from '../recipes/RecipeChangeSummary.svelte';
  import ChatThread from './ChatThread.svelte';
  import { createChatThread } from './chatThreadState.svelte.js';

  interface Props {
    params: { id: string };
  }
  let { params }: Props = $props();

  const session = $derived(($sessions as ChatSessionDoc[]).find((s) => s.id === params.id) ?? null);

  // The transcript, the composer and the send path all live in ChatThread; this
  // page owns the route lookup, the header actions and the review gate.
  const thread = createChatThread();

  // Whether the chat-actions menu is showing. Bound, because each item closes it
  // on the way to its handler (issue #1310).
  let chatActionsOpen = $state(false);

  // "The chef has replied at all" — the one gate on every control in this page's
  // header, the save control and the "View recipe" link alike (issue #1310).
  // Before the first reply there is nothing to keep and nothing to look at; after
  // it, WHICH actions apply is decided by whether this chat is attached to a dish,
  // never by what the chef last said. That is the whole point of the issue: an
  // action that was there a minute ago is there now.
  const hasAssistantTurn = $derived(session?.messages.some((m) => m.role === 'assistant') ?? false);

  // Back goes where you came from. `goBack` uses real browser history first; this
  // route is only the fallback for a cold-launch straight into the chat (issue
  // #696: a chat that belongs to a recipe is reached FROM that recipe, so the
  // recipe — not the chat list — is the right door when there is no history).
  const backTo = $derived(session?.recipeId ? `/recipes/${session.recipeId}` : '/chat');

  // The dish a variation chat started from (issue #763) — resolved for the chip
  // and nothing else. A miss is the ordinary outcome for a base recipe that has
  // since been deleted, and simply drops the chip: the conversation carries on as
  // an ordinary chat and still saves.
  const basedOnRecipe = $derived(
    session?.basedOnRecipeId
      ? ($recipes.find((r) => r.id === session.basedOnRecipeId) ?? null)
      : null,
  );

  // ─── Openers for an empty conversation (issue #878) ─────────────────────────
  // The same door the recipe column offers, worded for where you are standing:
  // this page is not on a dish, so unless the conversation is a variation of one
  // the openers are general ("What shall I cook tonight?"). It follows the
  // `basedOnRecipe` branch `emptyText` already follows rather than inventing a
  // second notion of what this conversation is about.
  const starters = $derived(
    basedOnRecipe
      ? [
          {
            label: 'Make it lighter',
            text: `How would you make ${basedOnRecipe.title} lighter without losing what makes it good?`,
          },
          {
            label: 'Make it vegetarian',
            text: `How would you make ${basedOnRecipe.title} vegetarian?`,
          },
          {
            label: 'Turn up the flavour',
            text: `What would you change about ${basedOnRecipe.title} to make it taste like more of itself?`,
          },
        ]
      : [
          {
            label: 'What shall I cook tonight?',
            text: 'What shall I cook tonight? Ask me anything you need to know first.',
          },
          {
            label: 'Use up what I have',
            text: 'I want to use up what is already in the fridge. Ask me what I have and suggest something.',
          },
          {
            label: 'Something in 20 minutes',
            text: 'Suggest something I can cook from scratch in about twenty minutes.',
          },
        ],
  );

  // Authoring a new recipe out of this conversation. What gets written lives in
  // `chatRecipeAuthor` and is shared with the recipe page's chat column and
  // drawer (issue #798); this page holds only its busy state, its toasts, where
  // it navigates and whether the conversation claims what it produced.
  //
  // One busy flag for both buttons: they are mutually exclusive — one shows only
  // on a general chat, the other only on an attached one.
  let isSavingRecipe = $state(false);

  // The meal this conversation was started FROM, if any (issue #752, Phase 3).
  // Carried in the querystring across both chat hops — /chat then /chat/{id} —
  // and read live off the router, so a reload mid-conversation keeps it. See
  // lib/mealReturn.ts for why it lives in the URL and nowhere else.
  const mealReturnId = $derived(readMealParam(router.querystring));

  /**
   * If a meal sent us here, hang the new dish off it and go back to the meal.
   * Returns true when it has taken responsibility for the navigation.
   *
   * The attach is idempotent and gated purely on the param — same contract as
   * the editor's save path, so the two doors behave identically. A meal that has
   * been deleted meanwhile must not cost the user the recipe they just made:
   * say so, and land them on what was written.
   */
  async function returnToMeal(saved: Recipe): Promise<boolean> {
    const mealId = mealReturnId;
    if (mealId === null) return false;
    const attached = await attachComponentToMeal(mealId, saved.id);
    if (attached.kind !== 'ok') {
      addToast('Saved — but that meal is no longer in the library.', 'destructive');
      push(`/recipes/${saved.id}`);
      return true;
    }
    addToast(`${saved.title} added to the meal.`, 'success');
    push(`/recipes/${mealId}`);
    return true;
  }

  /** The shared leg: author, save, toast a failure. `null` means it did not land. */
  async function runSave(
    transcript: ChatSessionDoc,
    basedOnRecipeId: string | null,
  ): Promise<Recipe | null> {
    isSavingRecipe = true;
    const existingTags = [...new Set($recipes.flatMap((r) => r.metadata.tags))];
    const result = await authorRecipeFromChat({
      messages: transcript.messages,
      existingTags,
      basedOnRecipeId,
    });
    isSavingRecipe = false;
    if (result.kind !== 'ok') {
      addToast(
        result.error.stage === 'author' ? 'Failed to generate recipe.' : 'Failed to save recipe.',
        'destructive',
      );
      return null;
    }
    return result.value;
  }

  // Save as recipe — the general-chat button. The conversation invented this dish,
  // so it goes on to belong to it.
  async function handleSaveAsRecipe(): Promise<void> {
    if (!session || isSavingRecipe) return;
    // `basedOnRecipeId` grounds the librarian on the dish this conversation
    // started from, so a variation carries forward everything the chat never
    // mentioned. It stays the CREATE path: the flow assembles with no base
    // recipe, so the new dish gets its own title, its own hero image and no
    // "makes" link, and the original is untouched (issue #763).
    const saved = await runSave(session, session.basedOnRecipeId);
    if (!saved) return;
    // The conversation now belongs to the dish it produced, so it is listed on
    // that recipe and stops being swept away after a fortnight (issue #696).
    // Best-effort: the recipe is already saved and a failed claim must not read
    // as a failed save.
    await claimRecipe(session.id, saved.id);
    if (await returnToMeal(saved)) return;
    // What the librarian decided it had written (issue #765). The toast is COPY,
    // so it comes from `KIND_COPY` and never from a comparison — say "Cocktail
    // created" when the conversation was about a Negroni. Read off the SAVED
    // document rather than anything on this page: the kind is the flow's answer,
    // and the chat has no opinion about it.
    addToast(KIND_COPY[kindOf(saved)].createdToast, 'success');
    push(`/recipes/${saved.id}`);
  }

  // Save as new recipe — the attached-chat counterpart (issue #798). You asked
  // what would go with the dish and want to keep the answer as its own recipe.
  //
  // `null` for the base, deliberately, even on a chat that started as a variation:
  // passing one switches the librarian into variation mode, which would carry the
  // base dish's ingredients and steps into an accompaniment.
  //
  // No `claimRecipe` either: the conversation belongs to the dish it is attached
  // to and stays listed there. The new recipe has no origin chat, which is right —
  // the chat is not about it, it merely produced it.
  async function handleSaveAsNewRecipe(): Promise<void> {
    if (!session || isSavingRecipe) return;
    const saved = await runSave(session, null);
    if (!saved) return;
    if (await returnToMeal(saved)) return;
    // Same rule as "Save as recipe" above (issue #765): this is a CREATE path
    // (`null` base), so the librarian can classify what it wrote as a cocktail —
    // ask a chat what would go with the dish and it may well produce one. The
    // toast is copy, so it comes from `KIND_COPY` and never from a comparison.
    addToast(KIND_COPY[kindOf(saved)].createdToast, 'success');
    push(`/recipes/${saved.id}`);
  }

  // Update recipe — the review gate. Everything about what gets proposed and
  // what gets written lives in `recipeAmend` and is shared with the recipe
  // page's sidebar/drawer (issue #764); this page holds only its own busy/open
  // state, its toasts and where it goes afterwards. `isProposing` guards the AI
  // call; `isApplying` guards the eventual save.
  let isProposing = $state(false);
  let isApplying = $state(false);
  let summaryOpen = $state(false);
  // The pending proposal: the merged recipe ready to save + its diff for display.
  let pending = $state<RecipeAmendment | null>(null);

  async function handleReviewChanges(): Promise<void> {
    if (!session?.recipeId || isProposing) return;
    const existing = $recipes.find((r) => r.id === session!.recipeId);
    if (!existing) {
      addToast('Recipe not found.', 'destructive');
      return;
    }
    isProposing = true;
    const existingTags = [...new Set($recipes.flatMap((r) => r.metadata.tags))];
    const result = await proposeRecipeAmendment(existing, session.messages, existingTags);
    isProposing = false;
    if (result.kind !== 'ok') {
      addToast('Failed to generate recipe update.', 'destructive');
      return;
    }
    pending = result.value;
    summaryOpen = true;
  }

  // Apply changes — commit the pending proposal (the review gate's confirm).
  async function handleApplyChanges(): Promise<void> {
    if (!pending || isApplying) return;
    isApplying = true;
    const recipeId = pending.updated.id;
    const saveResult = await applyRecipeAmendment(pending);
    isApplying = false;
    if (saveResult.kind !== 'ok') {
      addToast('Failed to save recipe update.', 'destructive');
      return;
    }
    summaryOpen = false;
    pending = null;
    addToast('Recipe updated!', 'success');
    push(`/recipes/${recipeId}`);
  }

  // Discard / keep chatting — drop the proposal, write nothing.
  function handleDiscardChanges(): void {
    summaryOpen = false;
    pending = null;
  }
</script>

{#if session === null}
  <div class="p-4 sm:p-6">
    {#if $isLoadingSessions}
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size={16} />
        Loading…
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">Chat not found.</p>
      <Button variant="outline" class="mt-4" onclick={() => push('/chat')}>Back to chats</Button>
    {/if}
  </div>
{:else}
  <DetailPage
    title={session.title}
    onBack={() => goBack(backTo)}
    backLabel="Back"
    class="p-4 sm:p-6"
  >
    <!-- The header's two controls, and the split between them is what each one does to
         the conversation (issue #1310). "View recipe" GOES somewhere; the save control
         turns this conversation into a dish, or folds it into one. A menu of "things to
         do with this chat" that also contained "go and look at something else" would be
         two ideas in one control, so they stay separate.

         The save control is one glyph either way — Lucide's floppy disc, "keep this" —
         so the header does not change shape as a conversation gains a recipe. It is a
         PLAIN BUTTON when one action applies and a MENU when two or more do: a menu of
         one is a tap that buys nothing. Today that makes a general chat the button case
         and an attached chat the menu case, but the rule is the rule, not the split. -->
    {#snippet actions()}
      {#if hasAssistantTurn}
        {#if session.recipeId}
          <Popover bind:open={chatActionsOpen}>
            <PopoverTrigger>
              {#snippet children()}
                <button
                  type="button"
                  class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Chat actions"
                  data-testid="chat-actions-menu"
                >
                  <Icon name="Save" size={20} />
                </button>
              {/snippet}
            </PopoverTrigger>
            <PopoverContent align="end" class="min-w-44 p-1">
              <!-- "Update recipe" is what `docs/salt-architecture.md` §4 has always
                   called this on the recipe page's own sidebar; the full chat page used
                   to say "Review changes" for the same act. One name (#1310). -->
              <PopoverMenuItem
                icon="RefreshCw"
                onclick={() => {
                  chatActionsOpen = false;
                  void handleReviewChanges();
                }}
                disabled={isProposing || thread.isSending}
                data-testid="chat-apply-changes-btn"
              >
                Update recipe
              </PopoverMenuItem>
              <!-- The other half of the pair (issue #798): Update recipe folds the
                   conversation into THIS dish, this one makes it a different one. -->
              <PopoverMenuItem
                icon="BookOpen"
                onclick={() => {
                  chatActionsOpen = false;
                  void handleSaveAsNewRecipe();
                }}
                disabled={isSavingRecipe || thread.isSending}
                data-testid="chat-save-new-recipe-btn"
              >
                Save as new recipe
              </PopoverMenuItem>
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            variant="outline"
            onclick={() => push(`/recipes/${session!.recipeId}`)}
            data-testid="chat-view-recipe-btn"
          >
            {#snippet leading()}<Icon name="BookOpen" size={16} />{/snippet}
            View recipe
          </Button>
        {:else}
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Save as recipe"
            onclick={handleSaveAsRecipe}
            disabled={isSavingRecipe || thread.isSending}
            data-testid="chat-save-recipe-btn"
          >
            <Icon name="Save" size={20} />
          </button>
        {/if}
      {/if}
    {/snippet}

    <!-- "Based on: <dish>" (issue #763). The whole of what a variation chat needs to
         say about its origin: the recipe itself rides on the session and is read
         server-side, so the transcript stays a conversation instead of opening with a
         wall of pasted recipe text. A link, because the obvious next thing to want is
         to look at the dish you are varying. -->
    {#if basedOnRecipe}
      <button
        type="button"
        class="mb-3 inline-flex items-center gap-1.5 rounded bg-muted px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => push(`/recipes/${basedOnRecipe.id}`)}
        data-testid="chat-based-on-chip"
      >
        <Icon name="Sparkles" size={12} />
        Based on: {basedOnRecipe.title}
      </button>
    {/if}

    <ChatThread
      {session}
      {thread}
      layout="page"
      emptyText={basedOnRecipe
        ? `What would you change about ${basedOnRecipe.title}?`
        : 'Ask me anything about cooking.'}
      {starters}
    />
  </DetailPage>

  <!-- Review-and-approve gate for the pending AI edit (Phase 2) -->
  <RecipeChangeSummary
    diff={pending?.diff ?? null}
    bind:open={summaryOpen}
    applying={isApplying}
    onApply={handleApplyChanges}
    onDiscard={handleDiscardChanges}
  />
{/if}
