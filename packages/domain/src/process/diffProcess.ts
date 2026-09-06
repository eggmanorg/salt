import type {
  ProcessStage,
  StageDuration,
  StageEnvironment,
  StageTemperature,
} from '../schemas/index.js';
import type { ProposedStage } from '../schemas/proposeSchedule.js';
import type { ProcessDiff, ProcessStageChange, ProcessStageDiffEntry } from './processDiff.js';

// Rendering a proposed restructure for review (issue #812, phase 2 of epic #778).
//
// PURE, and both sides are arguments (CLAUDE.md Rule 1): no clock, no I/O, no
// fetch of "the current process". `diffRecipe` is the precedent in shape as well as
// in spirit — a pure domain function producing a human-signal render contract that
// is never persisted.
//
// ─── IDENTITY: THE PROPOSAL'S OWN CITATION, MATCHED ONE-TO-ONE ─────────────────
//
// A proposed stage carries `sourceStageId`: the reference stage it claims to have
// come from. That claim is the identity, and it is honoured EXACTLY ONCE:
//
//   • cited, real, and cited by nobody else  → the two stages are the same stage,
//     and their fields are compared;
//   • cited by two or more proposed stages   → NOBODY is matched. The reference
//     stage is a REMOVAL and every claimant is an ADDITION;
//   • cited nothing, or cited a stage that is not in the reference → an ADDITION.
//
// The middle rule is the split case, and it is a RULE rather than a special case,
// which is the point. Ninety minutes of bulk becoming twenty on the counter and
// eight in the fridge is not "a stage that changed plus a new one" — the ninety
// minute bulk is genuinely gone — and there is no honest way to pick which half
// inherits it. So it renders as a removal and two additions, which is what both
// the contract doc and the issue require, and there is no `split` operation
// anywhere in this file.
//
// Labels are deliberately NOT a fallback identity the way `diffRecipe` uses step
// text. A restructure renames as it goes ("Bulk ferment" → "Bulk ferment, counter")
// and matching on a label would report a rewritten stage as an unrelated add and
// remove, which is worse than the citation being absent. An uncited stage is an
// addition, and the review says so plainly.

function sameTemperature(a: StageTemperature, b: StageTemperature): boolean {
  if (a.kind === 'fixed') return b.kind === 'fixed' && a.celsius === b.celsius;
  return b.kind === 'range' && a.minCelsius === b.minCelsius && a.maxCelsius === b.maxCelsius;
}

function sameEnvironment(a: StageEnvironment | null, b: StageEnvironment | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    sameTemperature(a.temperature, b.temperature) &&
    a.relativeHumidityPercent === b.relativeHumidityPercent &&
    // A restructure that moves a prove from the counter to the proofer has changed
    // the stage even when the figures happen to match, and the review must say so.
    a.equipmentId === b.equipmentId
  );
}

function sameDuration(a: StageDuration | null, b: StageDuration | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'fixed') return b.kind === 'fixed' && a.minutes === b.minutes;
  return b.kind === 'range' && a.minMinutes === b.minMinutes && a.maxMinutes === b.maxMinutes;
}

/**
 * Diff a reference process against a proposed one.
 *
 * Total: no throw and no failure case. Two empty lists diff to no changes; a
 * proposal that reproduces the reference exactly diffs to `hasChanges: false`,
 * which is how "the model declined to restructure" reaches the screen.
 */
export function diffProcess(
  reference: readonly ProcessStage[],
  proposed: readonly ProposedStage[],
): ProcessDiff {
  const referenceById = new Map(reference.map((stage) => [stage.id, stage]));

  // How many proposed stages claim each reference stage. A claim honoured twice is
  // no claim at all — see the header.
  const claims = new Map<string, number>();
  for (const stage of proposed) {
    if (stage.sourceStageId === null) continue;
    if (!referenceById.has(stage.sourceStageId)) continue;
    claims.set(stage.sourceStageId, (claims.get(stage.sourceStageId) ?? 0) + 1);
  }

  const matchedId = (stage: ProposedStage): string | null => {
    const id = stage.sourceStageId;
    if (id === null) return null;
    return claims.get(id) === 1 ? id : null;
  };

  const added: ProcessStageDiffEntry[] = [];
  const changed: ProcessStageChange[] = [];

  proposed.forEach((stage, index) => {
    const position = index + 1;
    const id = matchedId(stage);
    if (id === null) {
      added.push({ id: null, position, label: stage.label });
      return;
    }
    // Matched, so `referenceById` holds it: `claims` only ever counts ids it found.
    const before = referenceById.get(id)!;
    const facets: Omit<ProcessStageChange, 'id' | 'position'> = {};
    if (before.label !== stage.label) facets.label = { from: before.label, to: stage.label };
    if (before.kind !== stage.kind) facets.kind = { from: before.kind, to: stage.kind };
    if (!sameEnvironment(before.environment, stage.environment)) {
      facets.environment = { from: before.environment, to: stage.environment };
    }
    if (!sameDuration(before.duration, stage.duration)) {
      facets.duration = { from: before.duration, to: stage.duration };
    }
    if (before.until !== stage.until) facets.until = { from: before.until, to: stage.until };

    // A stage that changed in no facet is not a change. Kept stages are the silent
    // majority of any proposal and listing them would bury the two rows that matter.
    if (Object.keys(facets).length > 0) changed.push({ id, position, ...facets });
  });

  const removed: ProcessStageDiffEntry[] = [];
  reference.forEach((stage, index) => {
    if (claims.get(stage.id) === 1) return;
    removed.push({ id: stage.id, position: index + 1, label: stage.label });
  });

  return {
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    added,
    removed,
    changed,
  };
}
