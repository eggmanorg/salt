<script lang="ts">
  import { Button, CanonIcon, EmptyState, Icon } from '@salt/ui-components';
  import { onDestroy, onMount } from 'svelte';
  import {
    cookSession,
    persistCookSession,
    getCookSessionSnapshot,
  } from '../../lib/cookSessionService.js';
  // The session lifecycle — subscribe, bootstrap, ended-elsewhere, orphan, restart,
  // finish, close, keep-awake — shared with guided cook (issue #994), because both
  // screens are the same cook on the same session document.
  import { createCookLifecycle } from '../../lib/cookLifecycle.svelte.js';
  // The step timers — projection, tick, start/dismiss/progress and the sheet — also
  // shared with guided cook (issue #994), because they are the same timers on that
  // same document. The defaults and the push floor it runs on live in
  // `$lib/timerDefaults`, which it imports rather than this page.
  import { createCookTimers } from '../../lib/cookTimers.svelte.js';
  // The ingredient picture and the press-and-hold "add to the list" — shared with
  // guided cook (issue #994), because both screens draw the same rows.
  import {
    ingredientIcons,
    ingredientLabel,
    addIngredientToShoppingList,
  } from '../../lib/cookIngredientIcons.js';
  import { createCheckOffHold } from '../../lib/checkOffHold.svelte.js';
  import { longpress } from '../../lib/longpress.svelte.js';
  import { tick as hapticTick } from '../../lib/haptics.js';
  // The step deck — element registry, the pager, the probe, the peek, advancing and
  // where it lands on entry — lives in `$lib/stepDeck` (issue #994), shared with the
  // guided cook. Under it: the gesture-owned pager in `$lib/deck` (spring,
  // pointer/wheel/keyboard, element measurement) and the pure viewport arithmetic in
  // `$lib/cookDeck` (issue #556), whose numbers the markup below still reads.
  import { createStepDeck } from '../../lib/stepDeck.svelte.js';
  import { sectionMinHeight, PEEK_MAX_PX } from '../../lib/cookDeck.js';
  import IngredientText from './IngredientText.svelte';
  import CookTimerSheet from './CookTimerSheet.svelte';
  // The regions this screen draws byte-for-byte the same way the guided cook does
  // (issue #994). Composition, not a design-system primitive: they are app-level
  // arrangements of `@salt/ui-components` parts with exactly two call sites, and
  // promoting one into the package would need a ui-spec of its own.
  //
  // The one that carries a per-mode difference is `CookStepCollapsed`, and it takes
  // that difference as two class props written out below — never as a mode flag.
  import CookLoadingOrphan from './CookLoadingOrphan.svelte';
  import CookTimeline from './CookTimeline.svelte';
  import CookRecipeChangedBanner from './CookRecipeChangedBanner.svelte';
  import CookTimersBar from './CookTimersBar.svelte';
  import CookStepCollapsed from './CookStepCollapsed.svelte';
  import CookStepKit from './CookStepKit.svelte';
  import CookStepTimer from './CookStepTimer.svelte';
  import CookStepDoneControls from './CookStepDoneControls.svelte';
  // Pure cook-session logic lives in `@salt/domain` (issue #556) — every producer
  // is immutable, none of them stamp `updatedAt` (the service owns that), and
  // every timestamp they need is passed in from here rather than read there.
  import {
    withIngredientChecked,
    withAllIngredientsChecked,
    withGroupChecked,
    firstUseByStep as groupIngredientsByFirstUse,
    kitByStep as groupKitByStep,
    miseProgress,
    progressOver,
    hasRecipeChanged,
  } from '@salt/domain';
  import type { IngredientDoc, IngredientGroupDoc } from '@salt/domain/schemas';

  // Cook mode (cooking mode, Phase 1). The first FULL-VIEWPORT page in the app: it
  // owns its own `fixed inset-0` container rather than living inside the app shell,
  // because cooking is a heads-down, single-task mode. Stage 1 is mise en place —
  // tick every ingredient off before you start. Ticking is NOT a gate; it's a
  // memory aid that persists to Firestore so it survives a device switch.
  //
  // The pattern is now named and its obligations are written down (issue #641):
  // ui-spec-v05 §2 and the layer contract in CLAUDE.md. The one that used to be
  // missing here: the shell must not simply be COVERED. `routes/index.ts` lists
  // this route in FULL_VIEWPORT_ROUTES, which makes App.svelte pass
  // `chrome={false}` to AppShell, so TopBar/SideNav/BottomNav are not rendered at
  // all while cooking. Before that, they sat behind this overlay still focusable
  // and still in the accessibility tree — a keyboard user tabbing through cook mode
  // landed on invisible navigation and could leave mid-cook by activating it.
  //
  // NOT `role="dialog"` / `aria-modal`. This is a ROUTE that occupies the whole
  // screen, not a dialog layered over a page the user can return to — with the
  // chrome gone there is no background left to mark inert, and dialog semantics
  // would have a screen reader announce a modal that nothing ever opened.

  interface Props {
    params: { id: string };
  }
  let { params }: Props = $props();

  // ─── Session lifecycle ─────────────────────────────────────────────────────────
  // Subscribe, bootstrap, ended-elsewhere, orphan, restart, finish, close and the
  // keep-awake lock — all of it in `$lib/cookLifecycle`, shared verbatim with the
  // guided cook (issue #994). No ready-guard: plain cook mode has nothing to wait
  // for beyond the session itself.
  const lifecycle = createCookLifecycle({ recipeId: () => params.id });

  const recipe = $derived(lifecycle.recipe);
  const { wakeLockSupported, handleRestart, handleComplete, handleClose, toggleWakeLock } =
    lifecycle;
  const restarting = $derived(lifecycle.restarting);
  const completing = $derived(lifecycle.completing);
  const keepAwake = $derived(lifecycle.keepAwake);

  // ─── Mise-en-place ticking ─────────────────────────────────────────────────────
  const checkedIds = $derived(new Set($cookSession?.checkedIngredientIds ?? []));
  // Counted over the RECIPE rather than over the session's id list, so ticks left
  // behind by an ingredient that has since been edited out can't inflate the
  // count — see `miseProgress`.
  const mise = $derived(miseProgress(recipe?.ingredients ?? [], checkedIds));
  const totalIngredients = $derived(mise.total);
  const checkedCount = $derived(mise.checked);
  const allIngredientsChecked = $derived(mise.allChecked);

  // ─── The tick itself ───────────────────────────────────────────────────────────
  // Ticking an ingredient off celebrates the way ticking a shopping item off does —
  // a haptic tick on the way in, and the same sage "that's done" beat — because it
  // is the same gesture meaning the same thing: one item, accounted for. What it
  // deliberately does NOT borrow is the outro: a checked shopping row LEAVES its
  // aisle, so it has to be held in place while it collapses; a mise row stays
  // exactly where it is, so there is nothing to hold and nothing to collapse.
  //
  // Which is why the beat lands on the WHOLE ROW (`salt-tick-row`: a sage wash
  // draining back to the settled tint, and the row springing up through its own
  // size) and not on the tile alone. The tile keeps the shopping list's own
  // `salt-check-pop`, but 28px of spring in the left margin is not a celebration
  // on its own — nothing about the row it belongs to changed.
  //
  // `createCheckOffHold` is reused for the half that IS shared — a transient,
  // per-id "just ticked" set that expires on its own, no-ops under reduced motion
  // and disposes its timers on teardown. That set is what keeps the beat honest:
  // it must fire on the TAP, never on a render, or every already-ticked row would
  // celebrate again on the way back from the steps stage and on every session
  // update.
  //
  // The hold deliberately OUTLASTS the animation (the wash is `--duration-linger`,
  // 440ms). It has to: the classes only land once the tick is back through the
  // session store, so a hold cut to the animation's own length would have the
  // slower half of that round trip eat into the beat. Overrunning costs nothing —
  // a CSS animation plays once and the class simply lingers, spent.
  const TICK_BEAT_MS = 600;
  const justTicked = createCheckOffHold(TICK_BEAT_MS);
  onDestroy(() => justTicked.dispose());

  // Focus entry for the full-viewport mode (issue #641). The chrome that had focus
  // is unmounted the moment this route becomes active, dropping focus to <body>, so
  // a keyboard user's next Tab would restart from the top of the document. Pull it
  // into the page instead: the first Tab from here is "Close cook mode".
  //
  // There is deliberately no matching restore on the way out. Cook mode is always
  // entered from a route that unmounts as it opens (the recipe view's Cook button,
  // the "resume a cook" card in Mine), so the element to restore to no longer
  // exists by the time we leave. On exit focus falls to <body> with the chrome
  // remounted, which puts the next Tab on the TopBar — the correct start of the
  // restored page. Keeping a reference to a dead node to "restore" would be theatre.
  let pageEl = $state.raw<HTMLElement | null>(null);
  onMount(() => pageEl?.focus({ preventScroll: true }));

  // One tick and one pop per action, however many rows it moves. Only the rows the
  // action actually CHANGES pop — bulk-ticking a section that is half done shouldn't
  // re-pop the half already on the bench. Clearing is a correction, not an
  // accomplishment: no haptic, no pop (and any pop still in flight is dropped, so a
  // quick untick → retick pops afresh rather than being swallowed as a duplicate).
  function celebrateTicks(ids: readonly string[], checking: boolean): void {
    if (!checking) {
      justTicked.release(ids);
      return;
    }
    const fresh = ids.filter((id) => !checkedIds.has(id));
    if (fresh.length === 0) return;
    hapticTick();
    justTicked.begin(fresh);
  }

  function toggleIngredient(id: string): void {
    const s = getCookSessionSnapshot();
    if (!s) return;
    // The write is never gated on the celebration — same contract as the shopping
    // list: leave the page mid-pop and the tick is still recorded.
    celebrateTicks([id], !checkedIds.has(id));
    void persistCookSession(withIngredientChecked(s, id));
  }

  // Bulk tick, for when everything is already out on the bench and ticking fourteen
  // rows is busywork. Symmetric — tapping again clears the lot.
  function toggleAllIngredients(): void {
    const s = getCookSessionSnapshot();
    if (!s || !recipe) return;
    const allIds = recipe.ingredients.flatMap((g) => g.items.map((i) => i.id));
    celebrateTicks(allIds, !allIngredientsChecked);
    void persistCookSession(withAllIngredientsChecked(s, allIds, allIngredientsChecked));
  }

  // ─── Mise sections ─────────────────────────────────────────────────────────────
  // A sectioned recipe ("For the sauce" / "For the pasta") is gathered a section at
  // a time, so each one gets the two controls that suit that: fold it away once it's
  // on the bench, and tick the whole section in one tap.
  //
  // Only recipes that actually HAVE sections get the header. A single unnamed group
  // is not a section, it's the ingredient list — folding it away would leave an empty
  // screen, and the footer's Check all already ticks exactly the same set. That
  // mirrors what the heading already did: it only ever rendered for a named group.
  const hasMiseSections = $derived(
    recipe !== null &&
      (recipe.ingredients.length > 1 || recipe.ingredients.some((g) => g.name !== null)),
  );

  // Local, not persisted: which sections you've folded away is a view of the list
  // you're standing in front of, not cook progress — nothing another device wants,
  // and a fresh open should show the whole list. Survives the mise ↔ steps switch
  // (same component), which is the only place it has to.
  let collapsedGroupIds = $state(new Set<string>());

  function toggleGroupCollapsed(id: string): void {
    const next = new Set(collapsedGroupIds);
    if (!next.delete(id)) next.add(id);
    collapsedGroupIds = next;
  }

  // ─── A gathered section folds itself away ──────────────────────────────────────
  // Every ingredient in a section ticked means that section is on the bench and done
  // with: it folds, and what's left on screen is what you still have to find. The
  // heading stays (with its count), so nothing is hidden that can't be brought back
  // in a tap.
  //
  // It waits out the tick beat first. Folding a row away from under its own
  // celebration would throw away the acknowledgement the tap just earned — the sage
  // wash IS the "that's the lot", and it has to land before the section goes.
  //
  // Only ever on the TRANSITION into gathered, never for merely BEING gathered:
  // otherwise unfolding a finished section to double-check it would snap shut in
  // your face. `gatheredGroupIds` is that latch — a plain Set, not `$state`, because
  // nothing renders it and making it reactive would only feed the effect its own
  // writes. Unticking anything clears a section's latch, so genuinely completing it
  // again folds it again.
  let gatheredGroupIds = new Set<string>();
  let gatheredLatchSeeded = false;
  const foldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  onDestroy(() => {
    for (const timer of foldTimers.values()) clearTimeout(timer);
    foldTimers.clear();
  });

  $effect(() => {
    if (!recipe) return;
    const gathered = new Set<string>();
    const newly: IngredientGroupDoc[] = [];
    for (const group of recipe.ingredients) {
      const progress = miseProgress([group], checkedIds);
      if (progress.total === 0 || !progress.allChecked) continue;
      gathered.add(group.id);
      if (!gatheredGroupIds.has(group.id)) newly.push(group);
    }
    gatheredGroupIds = gathered;
    // A first look at the list shows the list. Opening a half-done cook seeds the
    // latch and folds nothing — same reason `collapsedGroupIds` isn't persisted:
    // what's folded is a view of the list you're standing in front of, and you
    // haven't stood in front of this one yet.
    if (!gatheredLatchSeeded) {
      gatheredLatchSeeded = true;
      return;
    }
    for (const group of newly) scheduleFold(group);
  });

  function scheduleFold(group: IngredientGroupDoc): void {
    const existing = foldTimers.get(group.id);
    if (existing !== undefined) clearTimeout(existing);
    // Ask the hold whether a celebration is actually in flight rather than assuming
    // one: under reduced motion `begin()` never took, so there is no beat to wait
    // out. Always through a timer even then, never straight through: the fold writes
    // `collapsedGroupIds`, which the fold itself reads, and doing that inside the
    // effect's own synchronous run is how an effect ends up chasing its own tail.
    const beat = group.items.some((i) => justTicked.isExiting(i.id)) ? TICK_BEAT_MS : 0;
    foldTimers.set(
      group.id,
      setTimeout(() => foldGathered(group), beat),
    );
  }

  function foldGathered(group: IngredientGroupDoc): void {
    foldTimers.delete(group.id);
    // An unsectioned list has no header to unfold it with — folding it would leave
    // an empty screen and no way back. Same guard the header itself is behind.
    if (!hasMiseSections) return;
    // Unticked something while the beat played: it isn't gathered any more, and
    // folding it now would be telling the chef it is.
    if (!miseProgress([group], checkedIds).allChecked) return;
    if (collapsedGroupIds.has(group.id)) return;
    collapsedGroupIds = new Set(collapsedGroupIds).add(group.id);
  }

  // Section-scoped bulk tick. `withGroupChecked` leaves the other sections' ticks
  // alone — the whole point of having one per section — and takes the target state
  // rather than toggling, off the same `allChecked` the button label reads.
  function toggleGroupIngredients(group: IngredientGroupDoc, groupAllChecked: boolean): void {
    const s = getCookSessionSnapshot();
    if (!s) return;
    celebrateTicks(
      group.items.map((i) => i.id),
      !groupAllChecked,
    );
    void persistCookSession(withGroupChecked(s, group, !groupAllChecked));
  }

  // ─── Guided steps (Phase 2) ─────────────────────────────────────────────────────
  // Two stages share this page's header/banner/footer shell; only the scroll region
  // swaps. `mise` is Stage 1 (tick ingredients); `steps` is this phase — one
  // full-viewport guided step at a time on a vertical spring-settled scroll. Default
  // is mise, and the one-shot resume that opens a half-cooked recipe straight into
  // the steps belongs to the shared lifecycle above.
  const stage = $derived(lifecycle.stage);

  const totalSteps = $derived(recipe?.steps.length ?? 0);
  const showTimeline = $derived(stage === 'steps' && totalSteps > 0);

  // First-use ingredients per step. The recipe stamps `firstUsedInStepId` on each
  // ingredient at the step it's first needed, so a step can surface exactly the
  // items it introduces (amount + prep) inline — no scrolling back to mise mid-cook.
  const firstUseByStep = $derived(groupIngredientsByFirstUse(recipe?.ingredients ?? []));

  // The kit each step is the one to REACH FOR (issue #882), under the domain
  // query's contiguous-run rule: the pan is drawn at the step it comes out of the
  // cupboard and not again until it has been put down. Mid-cook that matters more
  // than anywhere — a picture repeated under five consecutive steps stops being
  // read after the first, and then the one that IS new goes unread with it.
  const kitByStep = $derived(groupKitByStep(recipe?.kit ?? [], recipe?.steps ?? []));

  // First-use chips are capped at half the step's width (gap included, so two capped
  // chips always pair up on one line), which stops one long line ("400g tinned plum
  // tomatoes, drained and roughly chopped") swallowing the row and pushing the rest of
  // the set out of sight behind a wrap — the point of the chip wrap is that the whole
  // set is scannable at a glance. Tapping a clipped chip lifts the cap for that one
  // chip; the list is a flex wrap, so the others reflow around it on their own. Any
  // click elsewhere puts it back.
  let expandedChipId = $state<string | null>(null);

  // Every path that ISN'T "expand this one" falls through to the window-level collapse
  // below, which is what makes tapping the open chip close it and keeps a tap on an
  // inert chip from stranding a different one open.
  function expandChip(event: MouseEvent & { currentTarget: HTMLElement }, id: string): void {
    if (expandedChipId === id) return;
    // Measured, not tracked: only the browser knows where a proportional font runs out
    // of room, and `truncate` makes scrollWidth exceed clientWidth exactly when it
    // clipped the line. A chip that already reads in full has nothing to reveal, so
    // tapping it does nothing at all.
    const text = event.currentTarget.querySelector('[data-chip-text]');
    if (!text || text.scrollWidth <= text.clientWidth) return;
    // Without this the collapse would undo the expand on the very click that asked for it.
    event.stopPropagation();
    expandedChipId = id;
  }

  // ─── The step deck ─────────────────────────────────────────────────────────────
  // All of it — the element registry, the gesture-owned pager, the probe that says
  // which step the footer acts on, the bottom fade, ticking, the peek, the
  // pending-scroll handshake that advances, and where the deck lands on entry — is in
  // `$lib/stepDeck` (issue #994), shared verbatim with the guided cook.
  //
  // NOTHING here is passed differently by the two screens. Both hand it the live
  // recipe's steps, the lifecycle's stage, and a way to open or close a peek — there
  // is no parameter that says which mode is asking, because the deck is the same deck
  // on the same steps of the same session document. What the guided cook has that this
  // does not is derived in ITS page, off `currentStep` below.
  //
  // The peeked id stays in this file because the markup assigns to it directly, and an
  // assignment needs a variable rather than a getter — the same seam the timer sheet's
  // open flag has below.
  let peekedStepId = $state<string | null>(null);
  const stepDeck = createStepDeck({
    steps: () => recipe?.steps ?? [],
    stage: () => lifecycle.stage,
    setStage: (next) => {
      lifecycle.stage = next;
    },
    setPeeked: (id) => {
      peekedStepId = id;
    },
  });

  // Bound to the names the markup already uses.
  const deck = stepDeck.deck;
  const {
    stepAnchor,
    peekStep,
    untickStep,
    handleStepDone,
    handleResume,
    jumpToStep,
    goToSteps,
    goToMise,
  } = stepDeck;
  const completedStepIds = $derived(stepDeck.completedStepIds);
  // Counted over the RECIPE's step ids, never over the session's completed set —
  // `progressOver`'s contract, and here it is what makes a cook whose completed
  // steps were edited away read "Start cooking" again rather than "Continue".
  const completedStepCount = $derived(
    progressOver(
      (recipe?.steps ?? []).map((s) => s.id),
      completedStepIds,
    ).checked,
  );
  const fadeHeight = $derived(stepDeck.fadeHeight);
  const currentStep = $derived(stepDeck.currentStep);
  const currentStepDone = $derived(stepDeck.currentStepDone);
  const nextIncompleteStep = $derived(stepDeck.nextIncompleteStep);
  const nextIncompleteNumber = $derived(stepDeck.nextIncompleteNumber);

  // ─── Step timers (Phase 3) ──────────────────────────────────────────────────────
  // All of it — the live projection, the 1s tick, start / dismiss / progress, and the
  // one sheet all the ways in share — lives in `$lib/cookTimers` (issue #994), shared
  // verbatim with the guided cook because they are the same timers on the same session
  // document: a timer started in either mode is live in the other.
  //
  // NO `armCheckIns`. Plain cook mode arms no guided check-ins, and that is not a flag
  // it passes false — it is an argument it does not have. The plan's partway reminders
  // belong to the screen holding the plan, and this one cannot arm one because it never
  // supplies the thing that arms them.
  //
  // The sheet's open flag stays here because the markup binds it, and `bind:` needs a
  // variable it can assign to; everything the sheet is opened WITH is in the factory.
  let timerSheetOpen = $state(false);
  const timers = createCookTimers({
    steps: () => recipe?.steps ?? [],
    showSheet: () => {
      timerSheetOpen = true;
    },
  });

  // Bound to the names the markup already uses.
  const timerByStep = $derived(timers.timerByStep);
  const barTimers = $derived(timers.barTimers);
  const now = $derived(timers.now);
  const timerSheetPrefill = $derived(timers.sheetPrefill);
  const timerSheetTarget = $derived(timers.sheetTarget);
  const {
    startTimer,
    dismissTimer,
    timerProgressFor,
    openStepTimerSheet,
    openRunningTimerSheet,
    openAdHocTimerSheet,
    confirmTimerSheet,
  } = timers;

  // ─── Recipe-changed banner ─────────────────────────────────────────────────────
  // The live recipe drifted from the snapshot taken when the session started.
  const recipeChanged = $derived(
    hasRecipeChanged($cookSession?.recipeUpdatedAtAtStart ?? null, recipe?.updatedAt ?? null),
  );

  // Restart, Finish, Close and the keep-awake toggle all live on the shared
  // lifecycle, bound at the top of this script.
</script>

<!-- "Click anywhere else" for the expanded first-use chip. On window rather than the
   page root so a tap on the header or footer dismisses it too; the chip's own handler
   stops propagation so its expand survives the same click. -->
<svelte:window onclick={() => (expandedChipId = null)} />

<!-- `z-dialog` (50), not a raw z-50: a full-viewport route shares the dialog rung of
   the ladder in ui-spec-v02 §4.1 — above the nav (z-10) and any chrome-replacing bar
   (z-30), below toasts, which must stay legible while cooking. tabindex="-1" exists
   only to make the container a programmatic focus target (see onMount above); it is
   not a tab stop. focus:outline-none because that focus is a handoff, not a
   selection — there is nothing here for a ring to point at. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={pageEl}
  tabindex="-1"
  class="z-dialog fixed inset-0 flex h-dvh flex-col bg-background focus:outline-none"
  data-testid="cook-mode-page"
>
  {#if recipe === null}
    <!-- Loading, or the recipe was deleted (orphan handled by the effect above). -->
    <CookLoadingOrphan />
  {:else}
    <!-- Top bar -->
    <header class="flex shrink-0 items-center gap-3 px-4 py-3 {showTimeline ? '' : 'border-b'}">
      <Button
        variant="ghost"
        size="icon"
        onclick={handleClose}
        ariaLabel="Close cook mode"
        title="Close"
        data-testid="cook-mode-close"
      >
        {#snippet leading()}<Icon name="ArrowLeft" size={20} />{/snippet}
      </Button>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-base font-semibold" data-testid="cook-mode-title">
          {recipe.title}
        </span>
        {#if stage === 'mise'}
          <span class="text-xs text-muted-foreground">
            Mise en place · {checkedCount}/{totalIngredients} ready
          </span>
        {/if}
      </div>
      <!-- A timer for something the recipe never mentioned — the rice, the oven
         preheating, the ten minutes the dough rests. It sits in the header rather
         than in the step deck because it belongs to the COOK, not to any one step,
         and it opens the same sheet every other timer does. -->
      <Button
        variant="ghost"
        size="icon"
        onclick={openAdHocTimerSheet}
        ariaLabel="Start a timer"
        title="Start a timer"
        data-testid="cook-mode-timer"
      >
        {#snippet leading()}<Icon name="Timer" size={20} class="text-muted-foreground" />{/snippet}
      </Button>
      {#if wakeLockSupported}
        <!-- Keep-awake is an icon toggle, not a labelled switch: cook mode is a
           heads-down surface and the header has to stay legible next to a long recipe
           title. State is carried by colour (muted → amber, the same amber the timeline
           uses for "current") plus aria-pressed, and every tap fires a toast so the
           change is never silent. -->
        <Button
          variant="ghost"
          size="icon"
          onclick={toggleWakeLock}
          ariaLabel="Keep screen awake"
          title={keepAwake ? 'Screen stays awake' : 'Keep screen awake'}
          aria-pressed={keepAwake}
          data-testid="cook-mode-wakelock"
          data-active={keepAwake}
        >
          {#snippet leading()}
            <!-- Lucide has no phone-with-padlock glyph, so it's composed: a Lock badge on
               the corner of Smartphone, with a bg-background ring so it punches out of
               the phone outline instead of muddling into it. -->
            <span
              class="relative inline-flex transition-colors {keepAwake
                ? 'text-amber-500'
                : 'text-muted-foreground'}"
            >
              <Icon name="Smartphone" size={20} />
              <Icon
                name="Lock"
                size={14}
                class="absolute -right-1 -bottom-1 rounded-full bg-background"
              />
            </span>
          {/snippet}
        </Button>
      {/if}
    </header>

    <!-- Timeline. Its own full-width band directly under the header, which is why the
       header drops its bottom border — the two read as one block rather than as two
       stacked bars. -->
    {#if showTimeline}
      <CookTimeline
        steps={recipe.steps}
        {completedStepIds}
        currentStepId={currentStep?.id ?? null}
        onJump={jumpToStep}
      />
    {/if}

    <!-- Recipe-changed banner -->
    {#if recipeChanged}
      <CookRecipeChangedBanner {restarting} onRestart={handleRestart} />
    {/if}

    <!-- Persistent timers bar. Every live/fired timer stays here regardless of stage,
       scroll position, or which step is in focus. The per-step control below is the
       start affordance; this bar is the durable surface. -->
    {#if barTimers.length > 0}
      <CookTimersBar
        timers={barTimers}
        steps={recipe.steps}
        {now}
        progressFor={timerProgressFor}
        onEdit={openRunningTimerSheet}
        onDismiss={dismissTimer}
      />
    {/if}

    <!-- Stage 1: mise-en-place list / Stage 2: guided steps -->
    {#if stage === 'mise'}
      <main class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div class="mx-auto flex max-w-2xl flex-col gap-6">
          {#if recipe.ingredients.length === 0}
            <p class="text-sm text-muted-foreground">This recipe has no ingredients.</p>
          {/if}
          {#each recipe.ingredients as group (group.id)}
            {@const groupMise = miseProgress([group], checkedIds)}
            {@const groupCollapsed = collapsedGroupIds.has(group.id)}
            <section
              class="flex flex-col gap-2"
              data-testid="cook-mise-group"
              data-group-id={group.id}
              data-collapsed={groupCollapsed}
            >
              {#if hasMiseSections}
                <!-- Section header: fold on the left, tick-the-lot on the right. Two
                   separate controls, not one row with two jobs — the collapse is the
                   heading itself (kept as an h2 so the list is still navigable by
                   heading), and the bulk tick sits outside it because a button inside
                   a button is not a thing. The n of m rides in the heading so a folded
                   section still says how much of it is done.

                   It is a HEADING at this page's own scale, not the app's `text-xs`
                   uppercase section label. That label is right in the app shell, where
                   rows are `text-sm py-2` and it sits proportionate to them; here rows
                   are `text-base py-4` with 34px icons, and next to them a 12px muted
                   micro-label was the faintest thing on a page meant to be read from
                   across the bench — it read as a stray caption rather than as the
                   title of what follows.

                   STICKY, with the rule as its edge: on a long sectioned recipe the
                   heading you are gathering under scrolls away long before its rows do.
                   Pinned, the answer to "what am I looking for" is always on screen.
                   `bg-background` matches the page container exactly, so rows pass
                   under it and vanish rather than showing through. -->
                <div class="sticky top-0 z-10 flex items-center gap-2 border-b bg-background py-2">
                  <h2 class="min-w-0 flex-1">
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 text-left text-base font-semibold text-foreground"
                      onclick={() => toggleGroupCollapsed(group.id)}
                      aria-expanded={!groupCollapsed}
                      data-testid="cook-mise-group-toggle"
                    >
                      <Icon
                        name={groupCollapsed ? 'ChevronRight' : 'ChevronDown'}
                        size={18}
                        class="shrink-0 text-muted-foreground"
                      />
                      <span class="truncate" data-testid="cook-mise-group-name">
                        {group.name ?? 'Ingredients'}
                      </span>
                      <!-- Demoted to a quiet run-on, in words: the title is the thing
                         being read here, and the count is what it happens to say about
                         itself. Not `n/m` — that is the register of the page header's
                         status line, which this is not. -->
                      <span class="shrink-0 text-sm font-normal tabular-nums text-muted-foreground">
                        · {groupMise.checked} of {groupMise.total}
                      </span>
                    </button>
                  </h2>
                  <!-- Same words as the footer's whole-recipe control, deliberately —
                     it does the same thing at a smaller scope. What tells them apart
                     visually is placement (this one is attached to its heading); for a
                     screen reader, where placement carries nothing, `ariaLabel` names
                     the section so the two are never the same button. -->
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => toggleGroupIngredients(group, groupMise.allChecked)}
                    disabled={groupMise.total === 0}
                    ariaLabel="{groupMise.allChecked
                      ? 'Uncheck all'
                      : 'Check all'} in {group.name ?? 'ingredients'}"
                    data-testid="cook-mise-group-check-all"
                  >
                    {#snippet leading()}<Icon name="CheckCheck" size={14} />{/snippet}
                    {groupMise.allChecked ? 'Uncheck all' : 'Check all'}
                  </Button>
                </div>
              {/if}
              {#if !groupCollapsed}
                <ul class="flex flex-col gap-2">
                  {#each group.items as ingredient (ingredient.id)}
                    {@const checked = checkedIds.has(ingredient.id)}
                    {@const popping = checked && justTicked.isExiting(ingredient.id)}
                    <li>
                      <!-- `salt-tick-row` is the beat itself — a sage wash and a
                         spring, for as long as `popping` says the tap just
                         happened. It overrides the settled colours below for its
                         own duration and then hands straight back to them, which
                         is why both can sit in one class list without fighting. -->
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                          ? 'border-primary/40 bg-primary/5'
                          : 'bg-card hover:bg-muted/50'} {popping
                          ? 'salt-tick-row motion-reduce:animate-none'
                          : ''}"
                        onclick={() => toggleIngredient(ingredient.id)}
                        use:longpress={{
                          onLongPress: () => void addIngredientToShoppingList(ingredient),
                        }}
                        aria-pressed={checked}
                        data-testid="cook-mise-row"
                      >
                        <!-- The shopping list's check-off pop, on this list's own
                           square tile: the filled tile and its check spring in
                           together (the animation is on the wrapper, so the icon
                           scales with it) for one beat after the tap, then the class
                           lapses and the tile is simply the settled checked state.
                           `popping` is only ever true for a tick that just happened —
                           see `justTicked`. -->
                        <span
                          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input'} {popping
                            ? 'salt-check-pop motion-reduce:animate-none'
                            : ''}"
                          data-testid="cook-mise-check"
                        >
                          {#if checked}<Icon name="Check" size={18} />{/if}
                        </span>
                        <!-- Rendered for every row, matched or not: an unmatched
                           ingredient shows the bare tile (same as an unmatched shopping
                           row), which keeps the text column aligned down the whole list
                           instead of ragging in and out. Dims with the tick, as on the
                           shopping list. -->
                        <CanonIcon
                          thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                          name={ingredientLabel(ingredient)}
                          version={$ingredientIcons.iconVersionFor(ingredient)}
                          dimmed={checked}
                          size={40}
                        />
                        <span
                          class="min-w-0 flex-1 text-base {checked
                            ? 'text-muted-foreground line-through'
                            : ''}"
                        >
                          <IngredientText {ingredient} />
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        </div>
      </main>
    {:else}
      <!-- Guided steps: one full-viewport step per screen. NOT a scroll container —
         the deck inside is moved by transform and the gesture is handled in script
         (see `$lib/deck`), which is what lets a release carry its fling
         velocity into the settle. `touch-pinch-zoom` hands us the vertical pan while
         leaving zoom alone; `tabindex` restores the arrow-key paging a native scroller
         would have given for free. Completed steps collapse to a compact row (tap to
         re-read); the first incomplete step fills the screen and shows its first-use
         ingredients inline. -->
      <!-- The two a11y rules below assume a non-interactive element has no business
         taking focus or keys. Here it does: a native scroll container is focusable and
         arrow-key operable for free, and this element replaces one, so silencing the
         rules is how that behaviour is KEPT rather than dropped. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <main
        bind:this={deck.viewportEl}
        class="relative min-h-0 flex-1 touch-pinch-zoom overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        data-testid="cook-steps-view"
        tabindex="0"
        aria-label="Guided steps"
        onpointerdown={deck.handlePointerDown}
        onpointermove={deck.handlePointerMove}
        onpointerup={deck.handlePointerUp}
        onpointercancel={deck.handlePointerUp}
        onwheel={deck.handleWheel}
        onkeydown={deck.handleKeyDown}
      >
        {#if recipe.steps.length === 0}
          <div class="flex h-full flex-col items-center justify-center p-6">
            <EmptyState
              title="This recipe has no steps"
              description="There's nothing to guide through — tap Finish cooking when you're done."
            />
          </div>
        {/if}
        <!-- The deck's trailing padding is what lets the LAST step still align to the
           top: without it the final stop clamps short by exactly the peek. It tracks
           PEEK_MAX_PX, not PEEK_PX — the shortest a section can now be is
           `viewport - PEEK_MAX_PX`, and the padding has to cover that whole shortfall
           or the last step can't reach the top of the screen. -->
        <div
          bind:this={deck.contentEl}
          class="will-change-transform"
          style="transform: translate3d(0, {-deck.offset}px, 0); padding-bottom: {PEEK_MAX_PX}px"
          data-testid="cook-steps-deck"
        >
          {#each recipe.steps as step, i (step.id)}
            {@const done = completedStepIds.has(step.id)}
            {@const firstUse = firstUseByStep.get(step.id) ?? []}
            {@const stepKit = kitByStep.get(step.id) ?? []}
            {@const collapsed = done && peekedStepId !== step.id}
            <section
              use:stepAnchor={step.id}
              data-step-id={step.id}
              data-complete={done}
              data-testid="cook-step"
              class="flex flex-col px-4 {collapsed ? 'py-2' : 'border-t py-6'}"
              style="min-height: {collapsed ? 0 : sectionMinHeight(deck.viewportHeight)}px"
            >
              {#if collapsed}
                <!-- Collapsed / done: compact row, tap to re-read it. Tinted with the
                 teal primary — plain cook mode's own accent. The guided deck hands
                 the same component its sage; the two values live at these two call
                 sites so neither can be changed without seeing the other. -->
                <CookStepCollapsed
                  index={i}
                  text={step.text}
                  accentClass="border-primary/40 bg-primary/5"
                  labelClass="text-muted-foreground"
                  onPeek={() => peekStep(step.id)}
                />
              {:else}
                <!-- Expanded: the step being cooked, or a done step being re-read.
                 Fills the screen, arm's-length type. -->
                <!-- Top-aligned, NOT centred, and the instruction leads. Both are for
                   the peek: the next step's first ~112px is all the cook sees of it,
                   so whatever sits at the top of a step has to be the part worth
                   reading. Centring would put blank space there; leading with the
                   ingredients would peek a box of quantities out of context. -->
                <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
                  <div class="flex flex-col gap-3">
                    {#if done}
                      <div>
                        <span
                          class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                          data-testid="cook-step-done-badge"
                        >
                          <Icon name="Check" size={12} />
                          Done
                        </span>
                      </div>
                    {/if}
                    <p class="text-xl leading-relaxed sm:text-2xl">{step.text}</p>
                  </div>

                  <!-- Same amber-callout vocabulary as the step note on the recipe
                     detail page and the recipe-changed banner ten screens above: a
                     note should look like a note wherever it is met. Two deliberate
                     departures from the recipe page's copy of this box — the text
                     stays `text-lg` rather than dropping to its `text-xs`, and the
                     padding/gap/icon are the banner's cook-mode scale. Cook mode is
                     read at arm's length across a worktop, so the box grows; the
                     words do not shrink. `whitespace-pre-wrap` keeps author-typed
                     line breaks, as the recipe page already does. -->
                  {#if step.note}
                    <div
                      class="flex items-start gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                      data-testid="cook-step-note"
                    >
                      <Icon name="TriangleAlert" size={20} class="mt-1 shrink-0 text-amber-500" />
                      <span class="whitespace-pre-wrap text-lg">{step.note}</span>
                    </div>
                  {/if}

                  <!-- First-use ingredients as chips rather than a bordered list. Each
                     one is a self-contained "fetch this" object, so a wrap of pills
                     reads as a set of things to grab; a bordered block read as prose to
                     be worked through in order. The icon rides inside the pill, which
                     is what makes a chip worth the change over a list — the picture is
                     the fastest part to recognise mid-step. -->
                  {#if firstUse.length > 0}
                    <ul class="flex flex-wrap items-start gap-2" data-testid="cook-step-firstuse">
                      {#each firstUse as ing (ing.id)}
                        {@const expandedChip = expandedChipId === ing.id}
                        <!-- Half the row MINUS half the gap: a flat 50% would put two
                           full-width chips 8px over the line and wrap the second one,
                           which is the opposite of what the cap is for — two capped
                           chips must always sit side by side. Keep in step with the
                           `gap-2` above.
                           `shrink-0` so a chip is only ever ellipsised by the cap,
                           never by flex squeezing it to make a line fit. Nothing can
                           exceed the line on its own, so there is nothing to shrink. -->
                        <li
                          class="shrink-0 {expandedChip
                            ? 'max-w-full'
                            : 'max-w-[calc(50%-0.25rem)]'}"
                        >
                          <!-- No `aria-expanded`: clipped text is still in the
                             accessibility tree, so a screen reader already reads the
                             chip in full. The expand is a purely visual disclosure and
                             announcing it as collapsed content would be a lie. -->
                          <button
                            type="button"
                            class="flex w-full items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-4 text-left text-base"
                            data-testid="cook-step-firstuse-chip"
                            data-expanded={expandedChip}
                            onclick={(e) => expandChip(e, ing.id)}
                            use:longpress={{
                              onLongPress: () => void addIngredientToShoppingList(ing),
                            }}
                          >
                            <CanonIcon
                              thumbnail={$ingredientIcons.thumbnailFor(ing)}
                              name={ingredientLabel(ing)}
                              version={$ingredientIcons.iconVersionFor(ing)}
                              size={40}
                              class="rounded-full"
                            />
                            <!-- `min-w-0` is what lets the span shrink below its text
                               inside the flex row — without it the chip would simply
                               overflow the cap instead of clipping. -->
                            <span
                              class="min-w-0 {expandedChip ? 'break-words' : 'truncate'}"
                              data-chip-text
                            >
                              <IngredientText ingredient={ing} />
                            </span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  <!-- The kit this step reaches for (issue #882), in the chip
                     vocabulary the first-use row just used — mid-cook the two are
                     read the same way ("things to have in front of me"), and giving
                     the tools a second visual language would make the cook learn a
                     second one with their hands full.

                     STATIC, where the ingredient chips are buttons: an ingredient
                     chip expands its clipped line and long-presses onto the shopping
                     list, and a frying pan has neither an amount to reveal nor
                     anywhere to be bought to. A button that does nothing on press is
                     worse than a span — it takes a tab stop and promises an action.

                     Drawn at the step the tool comes OUT and not again until it has
                     been put down; the run rule is `kitByStep`'s, not this file's.
                     An unresolved label keeps its words and loses only the picture,
                     so the icon kill-switch never costs the cook a piece of kit. -->
                  {#if stepKit.length > 0}
                    <CookStepKit entries={stepKit} />
                  {/if}

                  <!-- Phase 3: per-step timer. Press-to-start when idle; live countdown
                   or a fired/dismiss state once running. State is derived purely from
                   the persisted `endsAt`, so it survives reloads/device switches. The
                   persistent bar above keeps this visible even when the step scrolls
                   off or collapses. -->
                  {#if step.timer}
                    <CookStepTimer
                      timer={step.timer}
                      entry={timerByStep.get(step.id)}
                      {now}
                      progressFor={timerProgressFor}
                      onStart={() => startTimer(step)}
                      onAdjust={() => openStepTimerSheet(step)}
                      onDismiss={dismissTimer}
                    />
                  {/if}

                  {#if done}
                    <CookStepDoneControls
                      onUntick={() => untickStep(step.id)}
                      onCollapse={() => (peekedStepId = null)}
                    />
                  {/if}
                </div>
              {/if}
            </section>
          {/each}
        </div>
        <!-- Fades the bottom edge so the peeked step reads as NEXT rather than as more
           of the current one. Sits above the deck and takes no pointer events, so it
           never intercepts a drag. Its height is the measured peek rather than a fixed
           band: the whole preview should read as faded, but stretching a fixed 224px
           over a step that fills the screen would wash out instruction text the cook is
           still reading. -->
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background to-transparent"
          style="height: {fadeHeight}px"
          aria-hidden="true"
        ></div>
      </main>
    {/if}

    <!-- Footer. Exactly one primary action, always in the same place — it's the only
       thing a cook with messy hands should have to aim at. Leaving cook mode is the
       header's back arrow (which keeps the session); ending it for good is the
       "Finish cooking" state below, reachable once every step is ticked. -->
    <footer class="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
      {#if stage === 'mise'}
        <!-- The whole-recipe bulk tick. Once a sectioned recipe puts a "Check all" on
           every heading too, this one's scope has to be said out loud for anyone who
           can't see that it sits in the footer rather than in a section. The visible
           text is kept INSIDE the label so voice control still matches it. -->
        <Button
          variant="ghost"
          onclick={toggleAllIngredients}
          disabled={totalIngredients === 0}
          ariaLabel="{allIngredientsChecked
            ? 'Uncheck all'
            : 'Check all'} ingredients in the recipe"
          data-testid="cook-mise-check-all"
        >
          {#snippet leading()}<Icon name="CheckCheck" size={16} />{/snippet}
          {allIngredientsChecked ? 'Uncheck all' : 'Check all'}
        </Button>
        <!-- "Continue" once any step is ticked: mise is reachable mid-cook via the
           footer's back button, so this is just as often a return to a cook already
           under way as it is a fresh start, and the label should say which.
           `completedStepCount` counts only steps still present in the recipe, so a
           cook whose completed steps were edited away correctly reads "Start" again. -->
        <Button size="lg" onclick={goToSteps} data-testid="cook-stage-toggle">
          {completedStepCount > 0 ? 'Continue cooking' : 'Start cooking'}
          {#snippet trailing()}<Icon name="ArrowRight" size={16} />{/snippet}
        </Button>
      {:else}
        <Button variant="ghost" onclick={goToMise} data-testid="cook-stage-back">
          {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
          Mise en place
        </Button>
        {#if currentStep && !currentStepDone}
          <Button size="lg" onclick={handleStepDone} data-testid="cook-step-done">
            {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
            {nextIncompleteStep ? 'Done · next' : 'Done'}
          </Button>
        {:else if nextIncompleteStep}
          <Button size="lg" onclick={handleResume} data-testid="cook-step-resume">
            Resume · step {nextIncompleteNumber}
            {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
          </Button>
        {:else}
          <Button
            size="lg"
            onclick={handleComplete}
            loading={completing}
            disabled={completing}
            data-testid="cook-mode-complete"
          >
            {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
            Finish cooking
          </Button>
        {/if}
      {/if}
    </footer>

    <!-- Mounted for the life of the page, never wrapped in `{#if}` — the sheet owns
       its own open/close transition, and a conditional mount would tear it out
       mid-animation. It portals to <body>, so it lands above this full-viewport
       container rather than inside it. -->
    <CookTimerSheet
      bind:open={timerSheetOpen}
      prefill={timerSheetPrefill}
      running={timerSheetTarget?.running ?? false}
      onConfirm={confirmTimerSheet}
    />
  {/if}
</div>
