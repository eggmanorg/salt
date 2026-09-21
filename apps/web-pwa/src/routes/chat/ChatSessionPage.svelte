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
  import {
    sessions,
    isLoadingSessions,
    claimRecipe,
    consumeSaveIntent,
  } from '../../lib/chatService.js';
  import { chatSaveGate } from '../../lib/featureGate.js';
  import { addToast } from '../../lib/toastStore.js';
  import { withStartedToast } from '../../lib/startedToast.js';
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
  import SaveIntentChoice from './SaveIntentChoice.svelte';
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
   * The attach is idempotent and gated purely on the param. It used to be one of
   * two doors and was written to match the editor's save path exactly; #1319
   * Phase 8 deleted that one, and Phase 7 moved the imports' attach to the moment
   * the dish is created, so there is no longer a second door for this to agree
   * with — chat is the only path whose dish does not exist until the conversation
   * makes it. A meal that has been deleted meanwhile must not cost the user the
   * recipe they just made: say so, and land them on what was written.
   */
  async function returnToMeal(saved: Recipe): Promise<boolean> {
    const mealId = mealReturnId;
    if (mealId === null) return false;
    const attached = await attachComponentToMeal(mealId, saved.id, saved);
    if (attached.kind !== 'ok') {
      addToast('Saved — but that meal is no longer in the library.', 'destructive');
      push(`/recipes/${saved.id}`);
      return true;
    }
    addToast(`${saved.title} added to the meal.`, 'success');
    push(`/recipes/${mealId}`);
    return true;
  }

  /**
   * The shared leg: author it and toast a failure. `null` means it did not land.
   * The saving is the Cloud Function's since issue #1431, which is why there is
   * one failure message below and not two.
   *
   * `startedMessage` is the caller's, not this function's: both buttons come
   * through here and the point of the acknowledgement is that it says WHICH one
   * was tapped (issue #1439). The trigger is gone by the time this runs — a
   * popover item for one caller, an icon-only button for the other — so the
   * toast is the only thing left saying anything is happening.
   */
  async function runSave(
    transcript: ChatSessionDoc,
    basedOnRecipeId: string | null,
    startedMessage: string,
  ): Promise<Recipe | null> {
    isSavingRecipe = true;
    const existingTags = [...new Set($recipes.flatMap((r) => r.metadata.tags))];
    const result = await withStartedToast(startedMessage, () =>
      authorRecipeFromChat({
        messages: transcript.messages,
        existingTags,
        basedOnRecipeId,
      }),
    );
    // A save that LANDED has answered the chef's recorded request too, so the
    // deferred retry below is dropped rather than making a second recipe (issue
    // #1505). Cleared in the same synchronous step as `isSavingRecipe`, before
    // the effect watching that flag can be flushed — an `await` between the two
    // is the gap through which the retry would fire.
    if (result.kind === 'ok') pendingSaveRetry = false;
    isSavingRecipe = false;
    if (result.kind !== 'ok') {
      // ONE message, because there is one leg left that can fail (issue #1431).
      // The recipe is written by the flow that authors it, and that write is
      // best-effort by design — it never fails the call — so "it was written but
      // not kept" is not news this page can be given, and a branch for it would
      // be a message nothing can produce.
      addToast('Failed to generate recipe.', 'destructive');
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
    const saved = await runSave(session, session.basedOnRecipeId, 'Writing the recipe…');
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

  // ─── Asking the chef to save it (issue #1480) ───────────────────────────────
  //
  // The second door onto "Save as recipe", and it opens onto the SAME handler:
  // say "create a recipe from this" and what runs is `handleSaveAsRecipe` below,
  // line for line, so the recipe, the claim, the toast and the landing page
  // cannot differ from the button's. That is the point of the issue — a recipe
  // saved by asking is indistinguishable from one saved by tapping.
  //
  // The chef RECOGNISES; it does not save. `chefChat`'s `saveRecipe` tool writes
  // nothing and only lets the flow record the request on the chat document
  // (`pendingSaveIntent`), which arrives here on the subscription the page is
  // already running. So a model that mishears costs an unwanted recipe somebody
  // can delete, never a dish quietly rewritten.
  //
  // A CHAT ATTACHED TO A DISH IS ASKED, a general one is not — there is only one
  // thing the ask can mean here, and asking anyway would not be "exactly the same
  // as pressing the save button". Standing on a dish there are two, so
  // `SaveIntentChoice` offers the menu's own two names and neither handler runs
  // until one is picked.
  let saveChoiceOpen = $state(false);

  // A request already sitting on the document the FIRST time this page observes
  // it is one nobody was here to take (issue #1490 review, Finding 1) — a
  // conversation you finished, closed, and reopened days later carries exactly
  // this shape, and firing the save unprompted on that reopen is the bug. A
  // legitimate request always arrives at a MOUNTED page through the realtime
  // subscription, i.e. as a snapshot after the first one, so gating on "is this
  // the first snapshot" costs only the case where the browser reloads between
  // the flow recording the request and the subscription delivering it — and
  // losing a request there is safe (the person asks again), where firing
  // unprompted is not.
  let sawFirstSnapshot = false;

  // A request that resolves while a save is ALREADY RUNNING (issue #1505). The
  // request is cleared from the document before anything happens — the "taken,
  // not read" contract — so `handleSaveAsRecipe`'s `isSavingRecipe` guard used to
  // drop it with nothing left anywhere saying it had ever been made. It is held
  // here instead and run when the in-flight save settles.
  //
  // THE BOUNDARY (CLAUDE.md Rule 12): this recovers the case the in-flight save
  // FAILS. One that succeeds clears this flag in `runSave` and then navigates to
  // the recipe it wrote — the ask has been honoured by that save, and a retry
  // there would be a duplicate dish, not a recovery.
  let pendingSaveRetry = $state(false);

  $effect(() => {
    // Reads both, so it re-runs when the in-flight save releases the flag.
    if (isSavingRecipe || !pendingSaveRetry) return;
    pendingSaveRetry = false;
    void handleSaveAsRecipe();
  });

  $effect(() => {
    const current = session;
    if (!current) return;
    const isFirstSnapshot = !sawFirstSnapshot;
    sawFirstSnapshot = true;
    if (current.pendingSaveIntent === null) return;
    if (!$chatSaveGate.enabled) return;
    void (async () => {
      // Clears the request before anything happens, and answers false if another
      // effect run, or another surface, already took this one — see
      // `consumeSaveIntent`. Taken when the QUESTION is asked, not when it is
      // answered: a question you dismissed has been answered, and leaving the
      // request on the document would re-ask it on every reload.
      const taken = await consumeSaveIntent(current);
      // A first-snapshot request is cleared above and stops here regardless of
      // `taken` — it is not this page's to act on, only to stop re-arming.
      if (isFirstSnapshot || !taken) return;
      if (current.recipeId !== null) {
        saveChoiceOpen = true;
        return;
      }
      // Not `handleSaveAsRecipe()` straight off: its own guard would swallow the
      // call outright if a save is already running (issue #1505), and the request
      // is already cleared from the document by then.
      if (isSavingRecipe) {
        pendingSaveRetry = true;
        return;
      }
      await handleSaveAsRecipe();
    })();
  });

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
    const saved = await runSave(session, null, 'Writing the new recipe…');
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
    // The menu item that started this closed itself on the way here, taking
    // `disabled={isProposing}` with it, so the toast is the acknowledgement
    // (issue #1439). Raised after the "Recipe not found" guard above: that path
    // never starts a call, so it must not leave one announced.
    const result = await withStartedToast('Reading the conversation to update the recipe…', () =>
      proposeRecipeAmendment(existing, session!.messages, existingTags),
    );
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

  <!-- "You asked me to save this — which did you mean?" (issue #1480). Only ever
       raised on an attached chat; "Update recipe" opens the gate above. -->
  <SaveIntentChoice
    bind:open={saveChoiceOpen}
    onUpdate={() => void handleReviewChanges()}
    onSaveNew={() => void handleSaveAsNewRecipe()}
  />
{/if}
