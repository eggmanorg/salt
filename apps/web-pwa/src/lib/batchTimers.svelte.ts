import { fromStore } from 'svelte/store';
import { batchStepTimerId, timerProgress } from '@salt/domain';
import type {
  CookActiveTimerDoc,
  KitchenTimerDoc,
  StepDoc,
  StepTimerDoc,
} from '@salt/domain/schemas';
import { kitchenTimers, startKitchenTimer, dismissKitchenTimer } from './kitchenTimerService.js';
import { AD_HOC_TIMER_LABEL, AD_HOC_TIMER_MINUTES } from './timerDefaults.js';

/**
 * The timers a batch cook runs on (issue #1327, Phase 2) — the live projection,
 * the 1s tick, start, dismiss, progress, and the one sheet every way in shares.
 *
 * WHY THIS IS NOT `createCookTimers`. That module is bound to a cook session at
 * every line: the snapshot it reads, the producers it writes, the document it
 * persists and the check-ins it arms are all the session's, and a batch has no
 * session and is never going to have one (decision 2 — a batch is the family's
 * thing, not a person's cook). A seam wide enough to admit this one would have
 * parameterised all of it, leaving a factory with nothing of its own left inside.
 * So the two share what is genuinely shared and nothing else: the pure
 * `timerProgress`, the `timerDefaults` floor and default, the write path in
 * `kitchenTimerService`, and — crucially — the three cook-timer COMPONENTS, which
 * this module feeds by widening each kitchen timer into the shape they already
 * take.
 *
 * WHICH TIMERS THESE ARE. The member's OWN kitchen timers (`kitchenTimers/{uid}`),
 * narrowed to the ones armed from this batch. A timer is personal even when the
 * batch is the family's: two people on one bake each have their own oven alarm,
 * and nothing about "the flour is weighed" applies to "my ten minutes of kneading
 * are up". That is why the origin points AT a batch and is never stored ON one.
 *
 * The chime is NOT here, for the reason it is not in `cookTimers.svelte.ts`
 * either: the app-level watcher (`lib/cookTimerAlerts.ts`) owns every audible
 * alert, so it keeps ringing once the chef navigates away from this page. This
 * module owns the visual half only — the `now` that flips a chip to "Finished".
 */

/** What the sheet was opened ON: which entry the confirm writes to, and the prefill. */
interface BatchTimerSheetTarget {
  id: string;
  /** The step it belongs to, or null for a timer for something the recipe never mentioned. */
  stepId: string | null;
  label: string;
  durationMinutes: number;
  running: boolean;
}

export interface BatchTimersOptions {
  /** The run these timers were armed from — half of every step timer's id, and the whole of the filter. */
  batchId: () => string;
  /**
   * Raise the timer sheet. The open flag stays with the page because the markup
   * binds it, and a binding needs a variable it can assign to.
   */
  showSheet: () => void;
}

/**
 * A kitchen timer, read as the shape the cook-timer components take.
 *
 * `KitchenTimerSchema`'s own header says it is `CookActiveTimerSchema` minus
 * `stepId`; `origin.stepId` is precisely the field that was missing, so this is a
 * widening rather than a cast — every other field is already the same field with
 * the same meaning. It is what lets `CookTimersBar`, `CookStepTimer` and
 * `CookTimerSheet` be REUSED here rather than copied into three batch-flavoured
 * twins that would drift the first time one of them was tuned.
 */
function asTimerView(timer: KitchenTimerDoc): CookActiveTimerDoc {
  return {
    id: timer.id,
    stepId: timer.origin?.stepId ?? null,
    label: timer.label,
    durationMinutes: timer.durationMinutes,
    endsAt: timer.endsAt,
    notify: timer.notify,
  };
}

export function createBatchTimers(options: BatchTimersOptions) {
  const kitchen = fromStore(kitchenTimers);

  // Mine, armed from THIS run. A timer started on My Kitchen (origin null) or from
  // another batch belongs on Mine and stays there — it is still the owner's, it
  // just is not this page's business to draw.
  const timers = $derived(
    (kitchen.current?.timers ?? [])
      .filter((t) => t.origin?.batchId === options.batchId())
      .map(asTimerView),
  );

  // Keyed by step: "is there a live timer on the step I am cooking?". An entry with
  // no step of its own — the ad-hoc one — is skipped rather than filed under null.
  // No check-in case, unlike cook mode's: a batch has no guided plan to arm one.
  const timerByStep = $derived(
    new Map(timers.flatMap((t) => (t.stepId === null ? [] : [[t.stepId, t] as const]))),
  );

  // One in-memory 1s interval, running only while a timer of this batch's is live.
  let now = $state(Date.now());
  $effect(() => {
    if (timers.length === 0) return;
    if (typeof setInterval !== 'function') return; // SSR guard
    const handle = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(handle);
  });

  /**
   * The one write that starts a timer here. Every entry point funnels through it,
   * so the origin is attached in exactly one place and a re-time can never drop it
   * (which would unhook the timer from its step and send its push back to Mine).
   */
  function start(entry: {
    id: string;
    stepId: string | null;
    label: string;
    durationMinutes: number;
  }): void {
    void startKitchenTimer({
      id: entry.id,
      // An emptied name is no name. A kitchen timer's label is required and has no
      // step to fall back to, so it falls back to the same default the sheet
      // offered — matching My Kitchen rather than cook mode, which can fall back to
      // the step.
      label: entry.label === '' ? AD_HOC_TIMER_LABEL : entry.label,
      durationMinutes: entry.durationMinutes,
      origin: { batchId: options.batchId(), stepId: entry.stepId },
    });
  }

  /**
   * What an unnamed step timer is called.
   *
   * A kitchen timer's label is REQUIRED and has no step to fall back to at read
   * time — that is the whole difference between this schema and the cook session's
   * — so the fallback has to be chosen here, at the one moment the step is in hand.
   * "Step 3" rather than `AD_HOC_TIMER_LABEL`: that default says "a timer from
   * nowhere in particular", which is exactly what this is not, and it is what the
   * lock screen will read.
   */
  function stepTimerLabel(timer: StepTimerDoc, index: number): string {
    return timer.description ?? `Step ${index + 1}`;
  }

  /**
   * The recipe's own timer for a step, started in one tap.
   *
   * Takes the step's timer and its position rather than fishing both back out of
   * the step: the caller has already decided this step HAS a timer — which is what
   * narrows `StepDoc['timer']` — and is already iterating, so it has the index in
   * hand. `CookStepTimer` takes its props on exactly the same terms.
   */
  function startStepTimer(step: StepDoc, timer: StepTimerDoc, index: number): void {
    start({
      id: batchStepTimerId(options.batchId(), step.id),
      stepId: step.id,
      label: stepTimerLabel(timer, index),
      durationMinutes: timer.durationMinutes,
    });
  }

  function dismissTimer(timerId: string): void {
    void dismissKitchenTimer(timerId);
  }

  // The elapsed fraction the progress fill draws, over the run the timer was
  // actually STARTED for. No fall back to the recipe step's duration, unlike cook
  // mode's: that exists there for entries written before `durationMinutes` did, and
  // `KitchenTimerSchema` has required a positive one since the day it shipped.
  function timerProgressFor(timer: CookActiveTimerDoc): number | null {
    const minutes = timer.durationMinutes;
    return timerProgress(timer, minutes === null ? null : minutes * 60_000, now);
  }

  // ─── The sheet ────────────────────────────────────────────────────────────────
  let sheetTarget = $state<BatchTimerSheetTarget | null>(null);
  const sheetPrefill = $derived({
    label: sheetTarget?.label ?? AD_HOC_TIMER_LABEL,
    durationMinutes: sheetTarget?.durationMinutes ?? AD_HOC_TIMER_MINUTES,
  });

  function openTimerSheet(target: BatchTimerSheetTarget): void {
    sheetTarget = target;
    options.showSheet();
  }

  /** A step timer before it starts — re-read from the LIVE step every time. */
  function openStepTimerSheet(step: StepDoc, timer: StepTimerDoc, index: number): void {
    openTimerSheet({
      id: batchStepTimerId(options.batchId(), step.id),
      stepId: step.id,
      label: stepTimerLabel(timer, index),
      durationMinutes: timer.durationMinutes,
      running: false,
    });
  }

  /**
   * One already counting down. Prefilled with what it was SET for, and confirming
   * re-times it from now — cook mode's reading of a running step timer rather than
   * My Kitchen's, deliberately: there IS a step here, and the gesture is "run that
   * step again", not "give it a bit longer".
   */
  function openRunningTimerSheet(timer: CookActiveTimerDoc): void {
    openTimerSheet({
      id: timer.id,
      stepId: timer.stepId,
      // Both non-null on every timer this page can be handed — the schema requires
      // them — so these coalesces only satisfy the widened view type the cook
      // components take, and never choose a value at runtime.
      label: timer.label ?? AD_HOC_TIMER_LABEL,
      durationMinutes: timer.durationMinutes ?? AD_HOC_TIMER_MINUTES,
      running: true,
    });
  }

  /**
   * A timer for something the recipe never mentioned. Its id is minted because it
   * has no step to derive one from, and `stepId: null` keeps it out of every step's
   * inline slot while leaving it in the bar — and still pinned to this batch, so
   * its push lands back here.
   */
  function openAdHocTimerSheet(): void {
    openTimerSheet({
      id: crypto.randomUUID(),
      stepId: null,
      label: AD_HOC_TIMER_LABEL,
      durationMinutes: AD_HOC_TIMER_MINUTES,
      running: false,
    });
  }

  function confirmTimerSheet(next: { label: string; durationMinutes: number }): void {
    const target = sheetTarget;
    if (!target) return;
    start({
      id: target.id,
      stepId: target.stepId,
      label: next.label,
      durationMinutes: next.durationMinutes,
    });
  }

  return {
    /** The live timer for each step that has one. */
    get timerByStep(): ReadonlyMap<string, CookActiveTimerDoc> {
      return timerByStep;
    },
    /** What the persistent bar shows: every timer armed from this run. */
    get barTimers(): CookActiveTimerDoc[] {
      return timers;
    },
    /** The 1s clock every countdown on the page is drawn against. */
    get now(): number {
      return now;
    },
    /** What the sheet opens holding. */
    get sheetPrefill(): { label: string; durationMinutes: number } {
      return sheetPrefill;
    },
    /** The entry the sheet was opened on, or `null` before it has ever opened. */
    get sheetTarget(): BatchTimerSheetTarget | null {
      return sheetTarget;
    },
    startStepTimer,
    dismissTimer,
    timerProgressFor,
    openStepTimerSheet,
    openRunningTimerSheet,
    openAdHocTimerSheet,
    confirmTimerSheet,
  };
}
