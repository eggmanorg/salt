<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';
  import { formatClock, isCheckInTimerId } from '@salt/domain';
  import type { CookActiveTimerDoc, StepDoc } from '@salt/domain/schemas';

  // Persistent timers bar, shared by both cook modes (issue #994). Every live/fired
  // timer stays here regardless of stage, scroll position, or which step is in focus
  // — so a timer that fires while the chef is on another step (or on a now-collapsed
  // done step) is always visible and dismissable, and can never be hidden into an
  // un-dismissable state. The per-step control below is the start affordance; this
  // bar is the durable surface.
  //
  // The same timers on the same session document either way, so nothing here is
  // per-mode: a check-in can only exist if a guided plan armed it, and this bar just
  // draws whatever the session holds. `isCheckInTimerId` is the domain's own reading
  // of the id, not a flag a caller sets.

  interface Props {
    /** The live/fired timers, in the order the bar should draw them. */
    timers: readonly CookActiveTimerDoc[];
    /** The recipe's steps — for "Step N" and a legacy timer's fallback label. */
    steps: readonly StepDoc[];
    /** The shared 1s tick, so every chip counts down off one clock. */
    now: number;
    /** Elapsed fraction, or null when the timer carries no duration to measure. */
    progressFor: (timer: CookActiveTimerDoc) => number | null;
    onEdit: (timer: CookActiveTimerDoc) => void;
    onDismiss: (timerId: string) => void;
  }
  let { timers, steps, now, progressFor, onEdit, onDismiss }: Props = $props();
</script>

<div
  class="flex shrink-0 flex-col gap-2 border-b bg-muted/40 px-4 py-3"
  data-testid="cook-timers-bar"
>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-2">
    {#each timers as t (t.id)}
      {@const remaining = new Date(t.endsAt).getTime() - now}
      {@const fired = remaining <= 0}
      {@const checkIn = isCheckInTimerId(t.id)}
      {@const stepIndex = t.stepId === null ? -1 : steps.findIndex((s) => s.id === t.stepId)}
      {@const stepLabel =
        t.label ?? (stepIndex >= 0 ? (steps[stepIndex]?.timer?.description ?? null) : null)}
      {@const stepName = stepIndex >= 0 ? `Step ${stepIndex + 1}` : 'Timer'}
      {@const progress = progressFor(t)}
      <div
        class="overflow-hidden rounded-lg border {fired
          ? 'border-primary bg-primary/10'
          : 'bg-card'}"
        data-testid="cook-timer-chip"
        data-timer-id={t.id}
        data-fired={fired}
        data-check-in={checkIn}
      >
        <div class="flex items-center gap-3 px-3 py-2">
          <!-- The chip's body is the way back into the sheet: tap the timer to
             re-time it. A BUTTON around the icon, name and clock only — the
             Cancel/Dismiss beside it stays its own control, because a button
             inside a button is not a thing the DOM has.
             A guided check-in is the exception: its `endsAt` is anchored to
             the moment its timer started, so re-timing it from now would
             detach it from the wait it belongs to. -->
          {#snippet chipBody()}
            <Icon
              name={checkIn ? 'Bell' : fired ? 'BellRing' : 'Timer'}
              size={18}
              class={fired ? 'shrink-0 text-primary' : 'shrink-0 text-muted-foreground'}
            />
            <!-- Lead with the human timer label ("Simmer the sauce") — the
               timer's own, falling back to its step's for a legacy entry; then
               "Step N" so an unlabelled timer is still locatable. When a label
               leads, the step number stays available as a tooltip so you can
               still find the step (#554). -->
            <span
              class="min-w-0 flex-1 truncate text-sm font-medium {fired
                ? 'text-primary'
                : 'text-foreground'}"
              title={stepLabel ? stepName : undefined}
              data-testid="cook-timer-chip-label"
            >
              {stepLabel ?? stepName}
            </span>
            <span
              class="shrink-0 font-mono text-base tabular-nums {fired
                ? 'font-semibold text-primary'
                : ''}"
              data-testid="cook-timer-chip-time"
            >
              {fired ? 'Finished' : formatClock(remaining)}
            </span>
          {/snippet}
          {#if checkIn}
            <div class="flex min-w-0 flex-1 items-center gap-3 py-1">
              {@render chipBody()}
            </div>
          {:else}
            <button
              type="button"
              class="-mx-1 flex min-w-0 flex-1 items-center gap-3 rounded px-1 py-1 text-left hover:bg-muted"
              onclick={() => onEdit(t)}
              data-testid="cook-timer-chip-edit"
            >
              {@render chipBody()}
            </button>
          {/if}
          <Button
            size="sm"
            variant={fired ? 'solid' : 'ghost'}
            onclick={() => onDismiss(t.id)}
            data-testid="cook-timer-chip-dismiss"
          >
            {fired ? 'Dismiss' : 'Cancel'}
          </Button>
        </div>
        <!-- Progress fill, flush to the chip's bottom edge (the wrapper clips it
           to the rounded corners). Decorative: the mm:ss beside it already
           carries the value, so a progressbar role would only double-announce.
           The 1s linear transition matches the tick interval, so it glides
           rather than stepping once a second. -->
        {#if progress !== null}
          <div class="h-1 w-full bg-muted-foreground/15" aria-hidden="true">
            <div
              class="h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none {fired
                ? 'bg-primary'
                : 'bg-warning'}"
              style="width: {progress * 100}%"
              data-testid="cook-timer-chip-progress"
            ></div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
