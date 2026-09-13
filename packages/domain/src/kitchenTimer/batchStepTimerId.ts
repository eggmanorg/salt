/**
 * The kitchen-timer id for a step timer armed from a batch's cook page (issue
 * #1327, Phase 2).
 *
 * DETERMINISTIC, and that is the whole point: "one live timer per id" is the only
 * rule `withKitchenTimerStarted` has, so deriving the id from the batch and the
 * step is what makes "one live timer per step" true here without a second rule to
 * enforce it. Starting the knead timer again re-times the one that is running,
 * exactly as tapping a step timer twice does in cook mode — where a step timer's
 * id simply IS its step id.
 *
 * It cannot be the bare step id, unlike cook mode's, because these entries share
 * ONE array with every other timer the member owns: two batches of the same
 * recipe, running at once, would otherwise be one timer fighting over two steps.
 * The batch id in front is what keeps them apart.
 *
 * COLLISION SAFETY, in both directions that matter:
 *   - against a check-in id (`::chk:`, `cookSession/checkInTimerId.ts`) — that
 *     separator cannot appear here, since both halves are `crypto.randomUUID()`
 *     output, which is hex and dashes. A batch step timer must never read as a
 *     check-in: the timers bar hides fired check-ins and refuses to re-time them.
 *   - against an ad-hoc timer's id, which is a bare uuid and so contains no `::`
 *     at all.
 */
export function batchStepTimerId(batchId: string, stepId: string): string {
  return `${batchId}::${stepId}`;
}
