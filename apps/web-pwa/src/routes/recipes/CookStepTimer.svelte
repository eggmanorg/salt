<script lang="ts">
  import { Button, Icon } from '@salt/ui-components';
  import { formatClock } from '@salt/domain';
  import type { CookActiveTimerDoc, StepTimerDoc } from '@salt/domain/schemas';

  // The per-step timer, identical in both cook modes (issue #994). Press-to-start
  // when idle; live countdown or a fired/dismiss state once running. State is derived
  // purely from the persisted `endsAt`, so it survives reloads/device switches. The
  // persistent bar above keeps this visible even when the step scrolls off or
  // collapses.
  //
  // Takes the step's timer rather than the step: the caller has already decided this
  // step HAS one (which is what narrows `StepDoc['timer']` to non-null), and the two
  // things this component does to a step — start it, open its sheet — arrive as
  // closures the caller already holds.

  interface Props {
    /** The recipe's timer for this step: how long, and what it is called. */
    timer: StepTimerDoc;
    /** The live entry on the session, or undefined while the timer is unstarted. */
    entry: CookActiveTimerDoc | undefined;
    /** The shared 1s tick, so the countdown runs off the same clock as the bar. */
    now: number;
    /** Elapsed fraction, or null when the timer carries no duration to measure. */
    progressFor: (timer: CookActiveTimerDoc) => number | null;
    onStart: () => void;
    onAdjust: () => void;
    onDismiss: (timerId: string) => void;
  }
  let { timer, entry, now, progressFor, onStart, onAdjust, onDismiss }: Props = $props();
</script>

<div class="flex flex-col gap-2" data-testid="cook-step-timer">
  {#if entry}
    {@const remaining = new Date(entry.endsAt).getTime() - now}
    {@const progress = progressFor(entry)}
    {#if remaining > 0}
      <div class="overflow-hidden rounded-lg border bg-card">
        <!-- Label INSIDE the bar, leading, exactly as the persistent chip above does
           it — "Cook tomato purée · 0:24" is one object, and hanging the label
           underneath read as a caption belonging to the step rather than to the
           timer. No "Step N" fallback here (unlike the chip, which can be miles from
           its step): an unlabelled timer sitting in its own step needs no telling
           which step it is, so the countdown just keeps the room to itself. -->
        <div class="flex items-center gap-3 px-4 py-3">
          <Icon name="Timer" size={22} class="shrink-0 text-muted-foreground" />
          {#if timer.description}
            <span class="min-w-0 flex-1 truncate text-base" data-testid="cook-step-timer-label">
              {timer.description}
            </span>
          {/if}
          <span
            class="{timer.description ? 'shrink-0' : 'flex-1'} font-mono text-2xl tabular-nums"
            data-testid="cook-step-timer-countdown"
          >
            {formatClock(remaining)}
          </span>
          <Button
            variant="ghost"
            onclick={() => onDismiss(entry.id)}
            data-testid="cook-step-timer-dismiss"
          >
            Cancel
          </Button>
        </div>
        <!-- See the timers-bar chip above: same fill, thicker here because this card
         is the step's primary timer surface. -->
        {#if progress !== null}
          <div class="h-1.5 w-full bg-muted-foreground/15" aria-hidden="true">
            <div
              class="h-full bg-warning transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
              style="width: {progress * 100}%"
              data-testid="cook-step-timer-progress"
            ></div>
          </div>
        {/if}
      </div>
    {:else}
      <!-- Fired: same row, same order. With a label leading, the status shortens to
         "Finished" (as on the chip) so the two strings aren't fighting over one
         line; alone, it carries the whole message and stays "Timer finished". -->
      <div class="flex items-center gap-3 rounded-lg border border-primary bg-primary/10 px-4 py-3">
        <Icon name="BellRing" size={22} class="shrink-0 text-primary" />
        {#if timer.description}
          <span
            class="min-w-0 flex-1 truncate text-base font-medium text-primary"
            data-testid="cook-step-timer-label"
          >
            {timer.description}
          </span>
        {/if}
        <span
          class="{timer.description ? 'shrink-0' : 'flex-1'} text-lg font-semibold text-primary"
          data-testid="cook-step-timer-countdown"
        >
          {timer.description ? 'Finished' : 'Timer finished'}
        </span>
        <Button onclick={() => onDismiss(entry.id)} data-testid="cook-step-timer-dismiss">
          Dismiss
        </Button>
      </div>
    {/if}
  {:else}
    <!-- Unstarted: the label goes IN the button, never under it — one ordinary
       centred button line, in the button's own type. The whole string truncates as
       one, and since the label is last it is the part that gives way; "Start 20
       minute timer" always survives, which is the part you have to be able to read. -->
    <!-- The button starts the recipe's timer in ONE tap — that is the common case and
       it stays a single tap. The pencil beside it is the other case: change the name
       or the time first. Two controls, because a button that sometimes starts and
       sometimes opens a dialog is a button you have to think about. -->
    <div class="flex items-center gap-2">
      <Button
        variant="outline"
        size="lg"
        class="min-w-0 flex-1"
        onclick={onStart}
        data-testid="cook-step-timer-start"
      >
        {#snippet leading()}<Icon name="Timer" size={18} />{/snippet}
        <span class="min-w-0 truncate">
          Start {timer.durationMinutes} minute timer{timer.description
            ? ` (${timer.description})`
            : ''}
        </span>
      </Button>
      <Button
        variant="outline"
        size="lg"
        class="shrink-0"
        onclick={onAdjust}
        ariaLabel="Adjust this timer"
        title="Adjust this timer"
        data-testid="cook-step-timer-adjust"
      >
        {#snippet leading()}<Icon name="Pencil" size={18} />{/snippet}
      </Button>
    </div>
  {/if}
</div>
