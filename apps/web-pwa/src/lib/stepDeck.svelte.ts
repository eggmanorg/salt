import { untrack } from 'svelte';
import { firstIncompleteStepId } from '@salt/domain';
import type { StepDoc } from '@salt/domain/schemas';
import { createDeck } from './deck.svelte.js';
import { fadeHeightFor } from './cookDeck.js';

/**
 * The step deck a cook screen runs on — the pager wired to recipe STEPS.
 *
 * Three layers meet here, and only this one knows what a section means. `./cookDeck.ts`
 * is the pure arithmetic (stops, landing, peek, fade — no DOM at all); `./deck.svelte.ts`
 * is the gesture, the spring and the element measurement (pixels and pointers — it knows
 * nothing about recipes); this module is the third: which element is which step, which
 * step the footer acts on, what "done" moves, and where the deck starts.
 *
 * SHARED by both cook screens (issue #994). Plain cook mode and the guided cook page the
 * same steps of the same recipe against the same `cookSessions/{recipeId}_{uid}`
 * document, and they did it from two copies of this wiring — which is how a fix to the
 * probe, or to the pending-scroll handshake, could be a fix to one screen with nothing
 * saying so. There is no parameter here that distinguishes the two: every option below
 * is passed identically by both, because the deck genuinely is the same deck.
 *
 * WHAT IS HERE AND WHAT IS NOT. What the two screens differ over stays out: guided's
 * look-ahead panel is derived in the page off the `currentStep` this returns, because
 * the panel is a reading of the PLAN and the plan is only in hand there.
 *
 * WHERE COMPLETION LIVES IS THE CALLER'S (issue #1327). This module used to read
 * `completedStepIds` off the cook session and write through `persistCookSession`, which
 * quietly made "a deck" and "a cook session" the same thing. They are not: the BATCH cook
 * page runs this same deck over the same recipe steps with the ticks on the batch
 * document, which is family-shared and has no session at all. So the progress store is
 * two options — a getter and a setter — and the two recipe cook screens pass the
 * session-backed pair, unchanged in behaviour.
 *
 * Runes in a factory, following `./deck.svelte.ts`, `./cookLifecycle.svelte.ts` and
 * `./cookTimers.svelte.ts`: the state and effects declared here belong to the component
 * that calls it, so its teardown is the component's.
 */

/** Which of the two screens-within-a-screen is showing. */
type CookStage = 'mise' | 'steps';

export interface StepDeckOptions {
  /** The LIVE recipe's steps, read fresh: the sections, in order, and their identity. */
  steps: () => readonly StepDoc[];
  /**
   * Which stage the screen is on. Read only to hold the landing effect off until the
   * steps are actually on screen — nothing else here cares.
   */
  stage: () => CookStage;
  /** Move to a stage. The footer's two buttons, and nothing else, do this. */
  setStage: (next: CookStage) => void;
  /**
   * Close or open the peek. The peeked id itself stays in the PAGE, because the markup
   * assigns to it directly (`peekedStepId = null` on the collapse control) and an
   * assignment needs a variable, not a getter on this object — the same seam
   * `createCookTimers` has around the sheet's `open` flag. Nothing here ever reads it
   * back: this module only ever sets one, or clears it.
   */
  setPeeked: (id: string | null) => void;
  /**
   * Which steps are ticked, read LIVE — the caller's store, whichever document it
   * happens to be (a cook session for the two recipe screens, the batch itself for
   * the batch cook page).
   */
  completedStepIds: () => ReadonlySet<string>;
  /**
   * Set a step's completion. Whole-document LWW via whichever service owns it; the
   * caller is also where the identity short-circuit lives, because only it knows
   * what "already in that state" means for its document.
   *
   * Completion is never a gate: the footer ticks the step you're on, a done step can
   * be unticked from its expanded view, and earlier steps are never force re-ticked.
   */
  setStepDone: (id: string, done: boolean) => void;
}

export function createStepDeck(options: StepDeckOptions) {
  /** Which steps are ticked. The one derivation; every screen renders off it. */
  const completedStepIds = $derived(options.completedStepIds());
  const setStepDone = (id: string, done: boolean): void => options.setStepDone(id, done);

  // ─── The step elements ─────────────────────────────────────────────────────────
  // The only registry of which DOM node is which step. Everything measured below goes
  // through it, and an unmounted section takes itself out — guarded on identity so a
  // re-keyed remount cannot delete the node that replaced it.
  const stepEls = new Map<string, HTMLElement>();
  function stepAnchor(node: HTMLElement, id: string) {
    stepEls.set(id, node);
    return {
      destroy() {
        if (stepEls.get(id) === node) stepEls.delete(id);
      },
    };
  }

  // ─── The pager ─────────────────────────────────────────────────────────────────
  // The deck is not a native scroller: `./deck.svelte.ts` owns the drag, the fling, the
  // wheel, the arrow keys and the spring that settles them, and it is the thing that
  // holds the viewport and column elements. All this tells it is which elements are the
  // sections — everything about what a "step" IS stays here.
  //
  // No threshold overrides: a cook step IS the screen, which is the case the defaults in
  // `./cookDeck.ts` were tuned for. The peek — how much of the next step stays on screen
  // — comes from there too (`sectionMinHeight`, `PEEK_MAX_PX`, both read by the markup):
  // it replaces both the old "Next" strip and the scrollbar we gave up by owning the
  // gesture, and it is the ONLY thing telling the cook there is more below.
  const deck = createDeck({
    sections: () =>
      options
        .steps()
        .map((step) => stepEls.get(step.id))
        .filter((el): el is HTMLElement => el !== undefined),
  });

  /** Where the deck must sit for a given step to be parked at the top of the viewport. */
  function stepStop(id: string): number | null {
    const el = stepEls.get(id);
    return el ? deck.offsetOf(el) : null;
  }

  // ─── The step the footer acts on ───────────────────────────────────────────────
  // The single primary action lives in the footer, so it has to know which step the
  // cook is on. That's the step parked at the TOP of the scroller, found by probing
  // which step's box spans a point just below the top edge.
  //
  // Deliberately NOT "the step with the most visible pixels": scroll back to re-read
  // an earlier step and its collapsed row is only ~56px tall, so a full-height
  // incomplete step still showing below it wins on area — the footer would go on
  // offering "Done · next" for a step you aren't looking at, and tapping it would
  // tick the wrong one.
  let visibleStepId = $state<string | null>(null);
  // How far up the bottom fade reaches. Measured in the same probe below, because it
  // wants to cover the peek exactly and the peek is whatever the current step didn't
  // need — only layout knows that number.
  let fadeHeight = $state(0);

  function probeVisibleStep(): void {
    const root = deck.viewportEl;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const probeY = rootRect.top + 8;
    for (const step of options.steps()) {
      const rect = stepEls.get(step.id)?.getBoundingClientRect();
      if (!rect) continue;
      if (rect.top <= probeY && rect.bottom > probeY) {
        visibleStepId = step.id;
        // Everything below this step's last line IS the next step, so that gap is the
        // fade — `fadeHeightFor` owns the floor and the cap.
        fadeHeight = fadeHeightFor(rootRect.bottom - rect.bottom);
        return;
      }
    }
  }

  // The footer follows the deck. Effects run after the DOM update, so the transform is
  // already applied and the probe measures where things actually are.
  $effect(() => {
    void deck.offset;
    // Re-probe on resize too, now that the fade height comes from here: the timers bar
    // or the recipe-changed banner appearing re-lays out every section, so the peek the
    // fade is covering changes without the deck having moved a pixel.
    void deck.viewportHeight;
    probeVisibleStep();
  });

  // ─── Re-reading a step you've already ticked ───────────────────────────────────
  // Peeking must never change completion. Tapping a collapsed row expands it in
  // place — still done — and the expanded view carries the only control that ticks
  // it back ("Mark not done").
  function peekStep(id: string): void {
    options.setPeeked(id);
    visibleStepId = id; // you're plainly on it now; don't wait for a scroll event
  }

  function untickStep(id: string): void {
    options.setPeeked(null);
    setStepDone(id, false);
  }

  const currentStep = $derived.by(() => {
    const steps = options.steps();
    if (steps.length === 0) return null;
    const firstIncompleteId = firstIncompleteStepId(steps, completedStepIds);
    return (
      steps.find((s) => s.id === visibleStepId) ??
      steps.find((s) => s.id === firstIncompleteId) ??
      steps[steps.length - 1]
    );
  });
  const currentStepDone = $derived(!!currentStep && completedStepIds.has(currentStep.id));
  // "The next outstanding step AFTER this one" — the query has no notion of a
  // cursor, so the slice is what expresses "after".
  const nextIncompleteStep = $derived.by(() => {
    const steps = options.steps();
    const idx = currentStep ? steps.findIndex((s) => s.id === currentStep.id) : -1;
    const rest = steps.slice(idx + 1);
    const nextId = firstIncompleteStepId(rest, completedStepIds);
    return rest.find((s) => s.id === nextId) ?? null;
  });
  const nextIncompleteNumber = $derived.by(() => {
    const next = nextIncompleteStep;
    return next ? options.steps().findIndex((s) => s.id === next.id) + 1 : 0;
  });

  // ─── Advancing ─────────────────────────────────────────────────────────────────
  // Finishing a step moves two things at once: the finished step collapses to a row,
  // and the next one has to come to the top. Animating BOTH is what felt jerky — the
  // collapse played, and a delayed smooth scroll then played on top of it. So only
  // one of them animates: the collapse is instant (no min-height transition) and the
  // travel is left to the spring.
  //
  // It can't run on a timer, because completion round-trips through Firestore — the
  // collapse lands whenever the listener does. So the scroll is parked here and the
  // effect below fires it the moment the completion it's waiting on arrives, which is
  // also the moment the layout it has to measure becomes final.
  let pendingScroll = $state<{ afterDoneId: string | null; targetId: string } | null>(null);

  // Advancing runs the same spring a swipe does — just seeded with no velocity, since
  // a button press has none to inherit — so the two settle identically.
  function alignToTop(id: string): void {
    const stop = stepStop(id);
    if (stop !== null) deck.animateTo(stop);
  }

  $effect(() => {
    const pending = pendingScroll;
    if (!pending) return;
    if (pending.afterDoneId && !completedStepIds.has(pending.afterDoneId)) return;
    pendingScroll = null;
    alignToTop(pending.targetId);
  });

  // Footer primary while cooking: tick the step you're on and bring the next one that
  // still needs doing to the top. `visibleStepId` moves optimistically so the footer
  // label doesn't flicker through the intermediate state.
  function handleStepDone(): void {
    const step = currentStep;
    if (!step) return;
    const next = nextIncompleteStep;
    setStepDone(step.id, true);
    if (!next) return;
    visibleStepId = next.id;
    pendingScroll = { afterDoneId: step.id, targetId: next.id };
  }

  // Footer primary when you've scrolled back to an already-done step: return to the
  // earliest step still outstanding, rather than offering to finish (which would
  // quietly skip everything left) or to tick the step you're only re-reading. Closing
  // the peek is local state, so there's no completion to wait on — but the alignment
  // still goes through the effect so it measures AFTER the peek has collapsed.
  function handleResume(): void {
    const next = nextIncompleteStep;
    if (!next) return;
    options.setPeeked(null);
    visibleStepId = next.id;
    pendingScroll = { afterDoneId: null, targetId: next.id };
  }

  // Timeline jump. Goes through `pendingScroll` rather than animating straight away
  // because closing an open peek collapses a step and moves everything below it —
  // measuring before that re-render would aim at where the target used to be.
  function jumpToStep(id: string): void {
    options.setPeeked(null);
    visibleStepId = id;
    pendingScroll = { afterDoneId: null, targetId: id };
  }

  // Land-on-first-incomplete. Fires only when the stage flips to `steps`; it reads
  // completion from an UNTRACKED snapshot so completion changes never move the
  // scroll on their own — the only thing that advances the view is the cook tapping
  // the footer (`handleStepDone` / `handleResume`), or their own swipe. Completed
  // steps stay above, collapsed but scrollable back and re-openable.
  //
  // `untrack` is what replaced reading the session store directly (issue #1327): the
  // caller's getter IS reactive, and the non-reactivity is this effect's requirement
  // rather than a property of where the ticks are kept.
  $effect(() => {
    if (options.stage() !== 'steps') return;
    if (!deck.viewportEl || !deck.contentEl) return;
    const done = untrack(() => options.completedStepIds());
    const steps = options.steps();
    const targetId = firstIncompleteStepId(steps, done);
    const target = steps.find((s) => s.id === targetId) ?? steps[steps.length - 1];
    if (!target) return;
    // Placed, not animated — this is where the deck STARTS, not somewhere it travels to.
    const landOn = (): void => {
      const stop = stepStop(target.id);
      if (stop !== null) deck.place(stop);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(landOn);
    else landOn();
  });

  function goToSteps(): void {
    options.setStage('steps');
  }
  function goToMise(): void {
    options.setStage('mise');
  }

  return {
    /** The pager itself — bind its viewport and column, and drive the transform off it. */
    deck,
    /** `use:stepAnchor={step.id}` on each section. The registry every measurement reads. */
    stepAnchor,
    /** Which steps are ticked. */
    get completedStepIds(): ReadonlySet<string> {
      return completedStepIds;
    },
    /** How tall the bottom fade is, in px — the measured peek, not a fixed number. */
    get fadeHeight(): number {
      return fadeHeight;
    },
    /** The step parked at the top: what the footer acts on and the timeline marks. */
    get currentStep(): StepDoc | null {
      return currentStep ?? null;
    },
    /** Whether that step is already ticked — which of the two footer primaries shows. */
    get currentStepDone(): boolean {
      return currentStepDone;
    },
    /** The next step still outstanding after the current one, or `null` at the end. */
    get nextIncompleteStep(): StepDoc | null {
      return nextIncompleteStep;
    },
    /** Its 1-based number, for the Resume label. 0 when there is none. */
    get nextIncompleteNumber(): number {
      return nextIncompleteNumber;
    },
    peekStep,
    untickStep,
    handleStepDone,
    handleResume,
    jumpToStep,
    goToSteps,
    goToMise,
  };
}
