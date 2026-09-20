// Halfway through a timer, minutes rounded and never below one. The one guess
// this pair of screens makes for a reminder's default: `GuidedStepNotes`'
// "+ reminder" row uses it to seed a new one, and `GuidedPlanPage` uses it to
// offer moving a reminder that could never fire. One definition so the two
// screens cannot drift apart on what "halfway" means (PR #1504 review).
export function halfwayThroughTimer(minutes: number): number {
  return Math.max(1, Math.round(minutes / 2));
}
