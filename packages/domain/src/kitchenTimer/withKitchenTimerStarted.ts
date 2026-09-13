import type { KitchenTimerDoc, KitchenTimersDoc } from '../schemas/index.js';

/**
 * How long a fired timer is allowed to sit there before a later start sweeps it
 * away.
 *
 * A fired timer RINGS UNTIL DISMISSED, on purpose: a timer that erased itself
 * would destroy the evidence that it went off while you were out of the room.
 * But "until dismissed" cannot mean forever — a timer nobody came back to would
 * still be shouting a week later, and the document would slowly fill with
 * yesterday's eggs.
 *
 * A day is the line because it is longer than any gap between leaving the
 * kitchen and coming back to it, and shorter than the gap between two
 * unconnected cooking sessions. Anything still ringing after that was not
 * missed — it was abandoned.
 *
 * Pruning happens HERE rather than in a scheduled sweep because the same write
 * that starts your next timer is the only moment anything needs to be tidy, and
 * it is free: one document, already in hand, already being written.
 */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

/**
 * Start (or re-time) a standalone kitchen timer.
 *
 * The WHOLE entry is supplied by the caller — `endsAt` is an ABSOLUTE ISO
 * end-time and `id` is minted outside, never computed from a clock or a random
 * source here (CLAUDE.md Rule 1). `nowMs` is injected for the same reason, and
 * is what makes the pruning testable without faking time.
 *
 * ONE LIVE TIMER PER ID: any existing entry sharing `id` is replaced, and the
 * new entry is appended. That single rule is also all "re-time a running timer"
 * is — the same id with a fresh `endsAt`, through this same producer — which is
 * why renaming and stretching a countdown need no second operation.
 *
 * Which is also why `origin` (issue #1327) needs nothing here: the whole entry is
 * the caller's, so an origin rides in on it and a re-time carries whatever the
 * caller hands over. The consequence worth knowing is that a re-time which omits
 * one DROPS it — the replacement is the entry, not a merge onto the old one — so
 * every path that re-times a timer armed from a batch must pass its origin again.
 * Pinned by the origin cases in `kitchenTimerProducers.test.ts`.
 *
 * Immutable: returns a new document and never mutates the input.
 */
export function withKitchenTimerStarted(
  doc: KitchenTimersDoc,
  timer: KitchenTimerDoc,
  nowMs: number,
): KitchenTimersDoc {
  const kept = doc.timers.filter((t) => t.id !== timer.id && !isLongPast(t, nowMs));
  return { ...doc, timers: [...kept, timer] };
}

// An unparseable `endsAt` is NOT treated as long past. A timer nobody can time
// is the one worth leaving on screen for a human to look at and dismiss, which
// is the same call `timerHeat` makes when it reads NaN as `ringing`.
function isLongPast(timer: KitchenTimerDoc, nowMs: number): boolean {
  const endsAtMs = Date.parse(timer.endsAt);
  if (Number.isNaN(endsAtMs)) return false;
  return nowMs - endsAtMs > PRUNE_AFTER_MS;
}
