import { describe, it, expect } from 'vitest';
import { renameGuidedContainer } from '../../src/cookSession/renameGuidedContainer.js';
import { prepEntryForContainer } from '../../src/cookSession/prepEntryForContainer.js';
import type { GuidedPlanDoc } from '../../src/schemas/index.js';

// RENAMING A BOWL (issue #1453, Phase 2). The property under every case here is
// one sentence: a rename must not be able to BREAK the join. Renaming the jobs and
// leaving the notes behind is the one way an editor turns a working plan into a
// step that asks for a bowl nobody fills, which is exactly the fault the editor
// exists to prevent.

const WHEN = '2026-08-01T09:00:00.000Z';

function makePlan(overrides: Partial<GuidedPlanDoc> = {}): GuidedPlanDoc {
  return {
    id: 'recipe-1',
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeUpdatedAtAtSave: WHEN,
    prep: [
      { id: 'prep-1', text: 'Dice the onion', container: 'onion bowl', ingredientIds: ['ing-1'] },
      { id: 'prep-2', text: 'Slice the garlic', container: 'garlic bowl', ingredientIds: [] },
    ],
    stepNotes: [
      {
        stepId: 'step-1',
        container: 'onion bowl',
        setup: null,
        cue: null,
        checkIns: [],
        lookahead: null,
        getAhead: null,
      },
      {
        stepId: 'step-2',
        container: 'garlic bowl',
        setup: null,
        cue: null,
        checkIns: [],
        lookahead: null,
        getAhead: null,
      },
    ],
    createdAt: WHEN,
    updatedAt: WHEN,
    ...overrides,
  };
}

describe('renameGuidedContainer', () => {
  it('moves the jobs and the step notes together, and leaves every other bowl alone', () => {
    const next = renameGuidedContainer(makePlan(), 'onion bowl', 'alliums');

    expect(next.prep.map((p) => p.container)).toEqual(['alliums', 'garlic bowl']);
    expect(next.stepNotes.map((n) => n.container)).toEqual(['alliums', 'garlic bowl']);
  });

  it('keeps the join intact — the renamed step still finds the renamed job', () => {
    // The whole point, asked through the matcher the cook screen uses rather than
    // by comparing strings: a rename that half-lands is a step with no bowl.
    const next = renameGuidedContainer(makePlan(), 'onion bowl', 'alliums');
    const note = next.stepNotes.find((n) => n.stepId === 'step-1')!;

    expect(prepEntryForContainer(next.prep, note.container)?.id).toBe('prep-1');
  });

  it('moves every spelling the matcher already calls one bowl', () => {
    // Case and stray whitespace are the difference `normaliseContainerName`
    // throws away, so they are the difference a rename has to carry with it. A
    // rename written as an exact-string sweep would leave this note behind.
    const plan = makePlan({
      stepNotes: [
        {
          stepId: 'step-1',
          container: 'Onion  Bowl ',
          setup: null,
          cue: null,
          checkIns: [],
          lookahead: null,
          getAhead: null,
        },
      ],
    });

    expect(renameGuidedContainer(plan, 'onion bowl', 'alliums').stepNotes[0]!.container).toBe(
      'alliums',
    );
  });

  it('finds the bowl however the rename itself is spelled', () => {
    expect(renameGuidedContainer(makePlan(), '  ONION bowl  ', 'alliums').prep[0]!.container).toBe(
      'alliums',
    );
  });

  it('renaming a bowl to nothing sets its jobs aside instead', () => {
    // A real thing a reader may mean — "this job keeps nothing back" — so it is
    // spelled rather than refused, and it is the only way null is written here.
    const next = renameGuidedContainer(makePlan(), 'onion bowl', '   ');

    expect(next.prep[0]!.container).toBeNull();
    expect(next.stepNotes[0]!.container).toBeNull();
  });

  it('renames nothing when asked to rename no bowl', () => {
    // The unheaded "Just get out" card has no name, so there is nothing to move.
    expect(renameGuidedContainer(makePlan(), '  ', 'alliums')).toEqual(makePlan());
  });

  it('merges two bowls when one is renamed onto the other, rather than refusing', () => {
    // The bench draws one card per NORMALISED name, so this reads as the two jobs
    // becoming one bowl — which is often what the reader meant. It is reported as
    // a duplicate by `guidedContainerProblems` either way; nothing here gates.
    const next = renameGuidedContainer(makePlan(), 'garlic bowl', 'onion bowl');

    expect(next.prep.map((p) => p.container)).toEqual(['onion bowl', 'onion bowl']);
    expect(next.stepNotes.map((n) => n.container)).toEqual(['onion bowl', 'onion bowl']);
  });

  it('never stamps updatedAt — the persistence seam owns that', () => {
    expect(renameGuidedContainer(makePlan(), 'onion bowl', 'alliums').updatedAt).toBe(WHEN);
  });
});
