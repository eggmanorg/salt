import { normaliseContainerName } from './normaliseContainerName.js';
import type { GuidedPlanDoc } from '../schemas/index.js';

// RENAMING A BOWL, on both halves of the plan at once (issue #1453, Phase 2).
//
// The container name is the plan's only join between its halves: a prep job says
// where its result goes, a step note says which one it wants, and
// `prepEntryForContainer` matches the two on the name alone. So a bowl renamed on
// one side and not the other is a bowl that stops existing — the step falls back
// to the loose list and the cook is shown a step with no bowl at all.
//
// A plan-shape operation rather than an editor one, which is why it is here beside
// the matcher it has to agree with: the set of jobs and notes that move together
// is exactly the set `normaliseContainerName` already calls one bowl. Written any
// other way — an exact-string sweep in the page, say — a rename would silently
// leave "Small  bowl " behind while moving "small bowl", and the difference between
// those two is precisely what the matcher throws away.
//
// `to` blank means the jobs set nothing aside: they lose their name and land on
// the unheaded "Just get out" card, and the notes that asked for the bowl are left
// asking for nothing. That is a real thing a reader may mean, so it is spelled
// rather than refused — and it is the only way `null` gets written here.
//
// `from` naming no bowl (blank, or whitespace only) returns the plan untouched:
// the unheaded card has no name, so there is nothing to rename.
//
// Does NOT stamp `updatedAt`, like every other producer in this module — the
// persistence seam owns that.
export function renameGuidedContainer(
  plan: GuidedPlanDoc,
  from: string,
  to: string,
): GuidedPlanDoc {
  const wanted = normaliseContainerName(from);
  if (wanted === '') return plan;
  const trimmed = to.trim();
  const next = trimmed === '' ? null : trimmed;
  const matches = (name: string | null): boolean =>
    name !== null && normaliseContainerName(name) === wanted;

  return {
    ...plan,
    prep: plan.prep.map((entry) =>
      matches(entry.container) ? { ...entry, container: next } : entry,
    ),
    stepNotes: plan.stepNotes.map((note) =>
      matches(note.container) ? { ...note, container: next } : note,
    ),
  };
}
