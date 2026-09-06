import { stageTemperatureText } from '@salt/domain';
import type { ProcessDiff } from '@salt/domain';
import type {
  ProcessStage,
  ProcessStageKind,
  ProposedStage,
  StageDuration,
  StageEnvironment,
} from '@salt/domain/schemas';
import { formatStatedDuration } from '../../lib/durationDisplay.js';

// How a proposed restructure READS (issue #812, phase 2 of epic #778) — the words
// the review sheet puts around `diffProcess`'s answer.
//
// PURE, AND IT COMPUTES NOTHING. `diffProcess` decided what changed, `solveFormula`
// decided every gram and `resolveSchedule` will decide every clock time; this file
// only chooses how to say it. The same line `batchDisplay.ts` draws for the two
// batch screens, drawn again here for the screen that comes just before them.
//
// ─── WHY THE DIFF IS JOINED BACK TO THE TWO PROCESSES ──────────────────────────
//
// `ProcessStageDiffEntry` carries an id, a position and a label and nothing else,
// deliberately: it is a diff, not a stage. But "Added: Cold retard" is a poor
// review row when the thing worth arguing with is "8 h at 4 °C" — so the entry is
// joined back to the stage it names, using the position the diff already states
// (1-based in the PROPOSED process for an addition, in the REFERENCE process for a
// removal — see `process/processDiff.ts`). The diff says WHICH; the process says
// WHAT. Nothing is re-derived and nothing is guessed: a position that does not
// resolve simply renders as a bare label.
//
// ─── THE VOCABULARY IS THE ONE ALREADY IN USE ──────────────────────────────────
//
// "Wait" / "Active" is FormulaPage's wording and `{n} °C` is BatchDetailPage's, and
// they are repeated rather than reinvented: a stage that reads one way while it is
// being reviewed and another way once the run is going is a stage the reader has to
// translate. `formatStatedDuration` comes from `lib/durationDisplay.ts` for the same
// reason: it lived on the batch screens above a note reserving a shared home for
// whichever third surface wanted it, and this is that surface — so it moved there
// rather than being copied a third time or reached for across route folders.
//
// ─── NO-CHANGE IS NOT AN EMPTY STATE ───────────────────────────────────────────
//
// `hasChanges: false` means the model read the method, looked at the time asked
// for, and said the process already lands there. That is an ANSWER, and the sheet
// renders it as one. Nothing in this file treats it as absence.

/** One row of the review — a stage that changed, arrived or left. */
export interface ProposalStageRow {
  key: string;
  /** 1-based, in whichever process the diff stated it against. */
  position: number;
  /** The stage's name, or `before → after` when the proposal renamed it. */
  label: string;
  /** Each facet that moved, already worded. Empty when there is nothing to add. */
  details: string[];
}

export interface ProposalReview {
  changed: ProposalStageRow[];
  added: ProposalStageRow[];
  removed: ProposalStageRow[];
}

function durationWords(duration: StageDuration | null): string {
  return formatStatedDuration(duration) ?? 'no set time';
}

function environmentWords(environment: StageEnvironment | null): string {
  if (environment === null) return 'no stated temperature';
  const humidity =
    environment.relativeHumidityPercent === undefined
      ? ''
      : ` · ${environment.relativeHumidityPercent}% RH`;
  // The PLACE is deliberately not spelled here: this file has no manifest to look
  // an id up in, and a raw equipment id in a review row is worse than nothing.
  // `diffProcess` still reports a place change, as a stage change.
  return `${stageTemperatureText(environment.temperature)}${humidity}`;
}

function kindWords(kind: ProcessStageKind): string {
  return kind === 'wait' ? 'Wait' : 'Active';
}

function untilWords(until: string | null): string {
  return until === null ? 'no criterion' : until;
}

function movedTo(from: string, to: string): string {
  return `${from} → ${to}`;
}

// What a whole stage says about itself, for an addition or a removal. Only the
// facets that carry something: a stage with no temperature and no length says
// nothing here rather than saying so three times.
function stageDetails(stage: Pick<ProcessStage, 'duration' | 'environment' | 'until'> | undefined) {
  if (stage === undefined) return [];
  const details: string[] = [];
  if (stage.duration !== null) details.push(durationWords(stage.duration));
  if (stage.environment !== null) details.push(environmentWords(stage.environment));
  if (stage.until !== null) details.push(stage.until);
  return details;
}

/**
 * Turn a `ProcessDiff` into review rows.
 *
 * `reference` and `proposed` are the two sides the diff was taken between, passed
 * back in so the rows can say what an added or removed stage actually was. Both are
 * read-only and neither is modified.
 */
export function reviewRows(
  diff: ProcessDiff,
  reference: readonly ProcessStage[],
  proposed: readonly ProposedStage[],
): ProposalReview {
  const changed: ProposalStageRow[] = diff.changed.map((change) => {
    const details: string[] = [];
    // Duration first: it is the facet a restructure almost always moves, and it is
    // the one that decides whether you are up at 03:00.
    if (change.duration !== undefined) {
      details.push(movedTo(durationWords(change.duration.from), durationWords(change.duration.to)));
    }
    if (change.environment !== undefined) {
      details.push(
        movedTo(environmentWords(change.environment.from), environmentWords(change.environment.to)),
      );
    }
    if (change.kind !== undefined) {
      details.push(movedTo(kindWords(change.kind.from), kindWords(change.kind.to)));
    }
    if (change.until !== undefined) {
      details.push(movedTo(untilWords(change.until.from), untilWords(change.until.to)));
    }
    return {
      key: change.id,
      position: change.position,
      // A change carries a label only when the label MOVED, so an unrenamed stage
      // has to be named from the proposal itself.
      label:
        change.label === undefined
          ? (proposed[change.position - 1]?.label ?? '')
          : movedTo(change.label.from, change.label.to),
      details,
    };
  });

  const added: ProposalStageRow[] = diff.added.map((entry) => ({
    key: `added-${entry.position}`,
    position: entry.position,
    label: entry.label,
    details: stageDetails(proposed[entry.position - 1]),
  }));

  const removed: ProposalStageRow[] = diff.removed.map((entry) => ({
    key: entry.id ?? `removed-${entry.position}`,
    position: entry.position,
    label: entry.label,
    details: stageDetails(reference[entry.position - 1]),
  }));

  return { changed, added, removed };
}
