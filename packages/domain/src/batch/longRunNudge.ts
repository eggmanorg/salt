import type { LongRunDescriptor } from './longRuns.js';

// The wording of the weekly "what is drying" nudge (issue #1406).
//
// A DOMAIN FUNCTION RATHER THAN A STRING IN THE CLOUD FUNCTION, for the reason
// `shoppingDay/shopDayHeadline.ts` is one: `cloud-functions` and `web-pwa` cannot
// import each other (CLAUDE.md Rule 6), so a sentence either lives in the one package
// both already depend on or gets spelled out twice under a comment asking a human to
// keep the copies in step. This is the ONE owner of this wording.
//
// PURE AND CLOCKLESS: the day number arrives already counted, by
// `longRunsWantingReading`.

/** The two lines of a notification: what it says, and what it asks for. */
export interface LongRunNudgeCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * The nudge for one person's long runs.
 *
 *   • one run  — `Coppa — day 12` / `Weigh it and add a note.`
 *   • several  — `2 runs under way` / `Weigh them and add a note.`
 *
 * SEVERAL RUNS COLLAPSE INTO ONE SENTENCE rather than one notification each: three
 * things drying must not mean three buzzes, and the batches list — which the nudge
 * opens — already names them, each one tap from the reading sheet.
 *
 * THE WEIGHT AND THE NOTE ARE ASKED FOR TOGETHER, in one sentence, because copy is
 * the cheapest possible place to put the second ask. There is no second notification
 * and no action button.
 *
 * TOTAL, and its BOUNDARY is the empty list: no caller reaches it, because a group
 * exists only when a run went into it (`longRunsWantingReading` never creates an empty
 * one), and the plural wording is what it would produce. It is stated rather than
 * guarded, because a domain function refusing an input nobody can construct buys
 * nothing.
 */
export function longRunNudge(runs: readonly LongRunDescriptor[]): LongRunNudgeCopy {
  const only = runs.length === 1 ? runs[0] : undefined;
  if (only !== undefined) {
    return {
      title: `${only.recipeTitle} — day ${only.dayNumber}`,
      body: 'Weigh it and add a note.',
    };
  }
  return { title: `${runs.length} runs under way`, body: 'Weigh them and add a note.' };
}
