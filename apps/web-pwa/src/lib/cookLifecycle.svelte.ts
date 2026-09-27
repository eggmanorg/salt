import { fromStore } from 'svelte/store';
import { push } from 'svelte-spa-router';
import { trackUsageEvent } from '@salt/observability';
import { makeFreshSession as buildFreshSession, cookSessionId } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';
import { auth } from './auth.svelte.js';
import { goBack } from './nav.js';
import { recipes, isLoadingRecipes } from './recipeService.js';
import {
  cookSession,
  cookSessionEnded,
  isLoadingCookSession,
  initCookSessionSync,
  persistCookSession,
  removeCookSession,
} from './cookSessionService.js';
import { addToast } from './toastStore.js';

/**
 * The session lifecycle a cook screen runs on — subscription, bootstrap, the two
 * ways a cook can end under you, restart, finish and close. Keep-awake is not
 * here: it is one app-wide switch (`./keepAwake.svelte.ts`, issue #1620), and a
 * cook screen leaving does not turn it off.
 *
 * There are two cook screens (plain cook mode and the guided cook, issue #751) and
 * they are the same cook: the SAME `cookSessions/{recipeId}_{uid}` document, so a
 * device switch resumes either one from the other. Until issue #994 they were also
 * the same CODE, copied — which is the failure mode this module exists to close:
 * a fix to one copy's bootstrap guard was a fix to one screen, and nothing said so.
 *
 * WHAT IS HERE AND WHAT IS NOT. Everything in this file is about the session
 * DOCUMENT and the screen's relationship to it. What a mise stage looks like, how a
 * step is ticked, what a timer means, how the pager moves — none of that is here,
 * because that is exactly where the two screens genuinely differ. The one lifecycle
 * difference that survived the merge is the `ready` guard below, and it is a
 * parameter rather than a branch.
 *
 * Runes in a factory, following `./deck.svelte.ts`: state and effects declared here
 * belong to the component that calls it, so its teardown is the component's.
 *
 * The stores are bridged with `fromStore` rather than taken as parameters. A `$store`
 * auto-subscription is component syntax and does not exist in a `.svelte.ts` module,
 * and handing the values in from the page would have put the whole read list back at
 * both call sites — which is the duplication this removes.
 */

export interface CookLifecycleOptions {
  /** The recipe id from the route, read live so a route param change re-subscribes. */
  recipeId: () => string;
  /**
   * Whether the screen knows enough yet to fix the stage it OPENS on. Omit for
   * plain cook mode, where the session is the whole answer. The guided cook passes
   * its plan-loaded condition: until the plan lands there is no prep screen to be
   * past, so a session that arrives first would settle the stage on an emptiness
   * that is only the plan still loading.
   */
  ready?: () => boolean;
}

export function createCookLifecycle(options: CookLifecycleOptions) {
  const recipesValue = fromStore(recipes);
  const loadingRecipes = fromStore(isLoadingRecipes);
  const session = fromStore(cookSession);
  const sessionEnded = fromStore(cookSessionEnded);
  const loadingSession = fromStore(isLoadingCookSession);

  const ready = (): boolean => options.ready?.() ?? true;

  // Recipe + identity, derived exactly as RecipeViewPage does.
  const recipe = $derived(recipesValue.current.find((r) => r.id === options.recipeId()) ?? null);
  const uid = $derived(auth.user?.uid ?? null);
  // Deterministic session id — one session per user per recipe, and the SAME one
  // whichever of the two screens is cooking it.
  const sessionId = $derived(uid ? cookSessionId(options.recipeId(), uid) : null);

  // ─── Subscription lifecycle ────────────────────────────────────────────────────
  // Re-subscribe whenever the session id changes (uid resolves, or the route param
  // changes). The effect's cleanup disposes the previous subscription.
  let unsub: (() => void) | null = null;
  $effect(() => {
    const sid = sessionId;
    if (!sid) return;
    unsub?.();
    unsub = initCookSessionSync(sid);
    return () => {
      unsub?.();
      unsub = null;
    };
  });

  // ─── Session bootstrap ─────────────────────────────────────────────────────────
  // Once the recipe and the session subscription have both resolved and there is no
  // session yet, create a fresh one stamping the live recipe's `updatedAt` as the
  // baseline. Guarded so it runs once per absent session.
  let bootstrapping = $state(false);

  function makeFreshSession(): CookSessionDoc {
    return buildFreshSession({
      id: sessionId!,
      ownerUid: uid!,
      recipeId: options.recipeId(),
      recipeUpdatedAtAtStart: recipe!.updatedAt,
      nowIso: new Date().toISOString(),
    });
  }

  async function createFreshSession(): Promise<void> {
    if (!sessionId || !uid || !recipe) return;
    bootstrapping = true;
    const result = await persistCookSession(makeFreshSession());
    bootstrapping = false;
    if (result.kind !== 'ok') addToast('Failed to start cooking.', 'destructive');
    // Bootstrap only — a Restart mid-cook re-persists a session but is the same
    // cook, not a new start (issue #684). One event for both screens, too: a guided
    // cook IS a cook, and splitting it would silently halve the series #684 plots.
    else trackUsageEvent('cook.started', { recipe_id: options.recipeId() });
  }

  $effect(() => {
    if (!uid || !recipe || !sessionId) return;
    if (loadingSession.current || bootstrapping) return;
    if (session.current) return; // already have one
    // A null store means "no session yet" ONLY when nothing has ended one. A cook
    // finished on another device, and the gap between a local Complete / Restart
    // clearing the store and its navigation, both read as null here — bootstrapping
    // into either would write the session straight back and resurrect the delete
    // (issue #559). (`completing` / `restarting` are declared with their handlers
    // further down.)
    if (sessionEnded.current || completing || restarting) return;
    void createFreshSession();
  });

  // ─── Ended on another device ───────────────────────────────────────────────────
  // The document vanished while we were cooking it: someone hit Finish or Restart on
  // another device. Tell the cook and return to the recipe, rather than leaving a
  // session on screen that no longer exists anywhere. Runs once.
  let endedElsewhere = $state(false);
  $effect(() => {
    if (!sessionEnded.current || endedElsewhere) return;
    endedElsewhere = true;
    addToast('This cook was finished on another device.');
    push(`/recipes/${options.recipeId()}`);
  });

  // ─── Deleted-recipe orphan handling ────────────────────────────────────────────
  // If the recipe resolves to null AFTER the recipes store has loaded, it was
  // deleted elsewhere. Alert the cook, delete the orphaned session, and bounce to
  // the recipe list. Runs once.
  let orphaned = $state(false);
  $effect(() => {
    if (loadingRecipes.current) return; // still loading — not an orphan yet
    if (recipe !== null) return;
    if (orphaned) return;
    orphaned = true;
    void handleOrphan();
  });

  async function handleOrphan(): Promise<void> {
    if (sessionId) await removeCookSession(sessionId);
  }

  // ─── The opening stage ─────────────────────────────────────────────────────────
  // `mise` is the gathering stage — the ingredient checklist in plain cook mode, the
  // prep board in the guided one; `steps` is the cook itself. Default is `mise`.
  let stage = $state<'mise' | 'steps'>('mise');

  // One-shot resume: when the session first resolves already carrying step progress,
  // open straight into steps so reopening a half-cooked recipe drops you back where
  // you were (each page's land-on-first-incomplete finds the exact step). A plain
  // boolean guard (not `$state`) keeps this from re-firing as the session updates.
  //
  // `ready()` is what makes the decision wait for everything the screen needs — see
  // `CookLifecycleOptions.ready`. It is checked HERE and only here: the guard is
  // about which stage to open on, and nothing else about a session's life waits.
  let stageInitialised = false;
  $effect(() => {
    if (stageInitialised) return;
    const s = session.current;
    if (!s || !ready()) return;
    stageInitialised = true;
    if (s.completedStepIds.length > 0) stage = 'steps';
  });

  // ─── Restart ───────────────────────────────────────────────────────────────────
  // Discard the current session and start a fresh one against the CURRENT recipe
  // (new baseline, cleared ticks), staying on the cook page so the user keeps
  // cooking the updated recipe.
  let restarting = $state(false);
  async function handleRestart(): Promise<void> {
    if (!sessionId || !uid || !recipe || restarting) return;
    restarting = true;
    await removeCookSession(sessionId);
    const result = await persistCookSession(makeFreshSession());
    restarting = false;
    if (result.kind !== 'ok') {
      addToast('Failed to restart.', 'destructive');
      return;
    }
    addToast('Started fresh with the updated recipe.', 'success');
  }

  // ─── Complete / close ──────────────────────────────────────────────────────────
  // Complete clears the session (delete the doc) and returns to the recipe view.
  let completing = $state(false);
  async function handleComplete(): Promise<void> {
    if (!sessionId || completing) return;
    completing = true;
    await removeCookSession(sessionId);
    // The explicit "Finish cooking" gesture — restarts and closes are not
    // completions (issue #684).
    trackUsageEvent('cook.completed', { recipe_id: options.recipeId() });
    // Deliberately left true: removeCookSession clears the store synchronously, and
    // this flag is what stops the bootstrap effect from creating a replacement
    // session in the gap before the navigation tears the page down.
    push(`/recipes/${options.recipeId()}`);
  }

  // Close leaves the session intact so it can be resumed later / on another device.
  // Back goes where you came from (the recipe, or Mine if you launched it there),
  // falling back to the recipe view on a cold-launch straight into cook mode.
  function handleClose(): void {
    goBack(`/recipes/${options.recipeId()}`);
  }

  return {
    /** The recipe being cooked, or `null` once the store has loaded without it. */
    get recipe(): Recipe | null {
      return recipe;
    },
    /** Which stage the screen is showing. Writable — the footer moves it. */
    get stage(): 'mise' | 'steps' {
      return stage;
    },
    set stage(next: 'mise' | 'steps') {
      stage = next;
    },
    /** A restart is in flight; the Restart button shows it and refuses a second. */
    get restarting(): boolean {
      return restarting;
    },
    /** A completion is in flight, and stays true through the navigation out. */
    get completing(): boolean {
      return completing;
    },
    handleRestart,
    handleComplete,
    handleClose,
  };
}
