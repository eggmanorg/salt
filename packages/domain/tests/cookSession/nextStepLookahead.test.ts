import { describe, it, expect } from 'vitest';
import { nextStepLookahead } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { GuidedStepNoteDoc, StepDoc } from '@salt/domain/schemas';

// What the plan says about the step BELOW the one on screen (issue #769), in place
// of plain cook mode's faded first clause of the next step.
//
// The shape that matters: a look-ahead is written on the step it is READ FROM and
// describes the one after it. The first shipping had that backwards — it took the
// NEXT step's note and numbered it correctly, so the cook saw "Next · 5" over a
// description of step 6, consistently, the whole way down a recipe. Most of what
// follows pins that direction, plus the ways there is nothing to say, each of which
// has to come back as one null because the caller's fallback is a single branch.

function step(id: string, text = `do ${id}`): StepDoc {
  return { id, text, timer: null, note: null };
}

function recipe(steps: StepDoc[]): Recipe {
  return {
    cureCategory: null,
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Weeknight ragù',
    description: null,
    ingredients: [],
    steps,
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    image: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  };
}

function note(stepId: string, over: Partial<GuidedStepNoteDoc> = {}): GuidedStepNoteDoc {
  return {
    stepId,
    container: null,
    setup: null,
    cue: null,
    checkIns: [],
    lookahead: null,
    getAhead: null,
    ...over,
  };
}

const THREE = recipe([step('s1'), step('s2'), step('s3')]);

describe('nextStepLookahead', () => {
  it('reads the CURRENT step’s note — that is where a look-ahead is written', () => {
    // The bug, stated as a test. Standing on s1 with both steps annotated, the
    // panel must show what s1's note says (which is about s2), never s2's note
    // (which would be about s3) under a heading numbered 2.
    const result = nextStepLookahead(
      THREE,
      [
        note('s1', { lookahead: 'the sauce reduces by half' }),
        note('s2', { lookahead: 'it comes out of the oven' }),
      ],
      's1',
    );
    expect(result?.lookahead).toBe('the sauce reduces by half');
    expect(result?.stepId).toBe('s2');
    expect(result?.number).toBe(2);
  });

  it('numbers the step it is DESCRIBING, so the number and the words agree', () => {
    // The two halves used to come from different steps: a correct number over the
    // wrong sentence is worse than no panel, because it reads as authoritative.
    const result = nextStepLookahead(
      THREE,
      [note('s2', { lookahead: 'it rests' }), note('s3', { lookahead: 'never shown' })],
      's2',
    );
    expect(result?.number).toBe(3);
    expect(result?.lookahead).toBe('it rests');
  });

  it('is 1-based — step 2 on screen previews step 3, not step 2', () => {
    const result = nextStepLookahead(THREE, [note('s2', { lookahead: 'it rests' })], 's2');
    expect(result?.number).toBe(3);
  });

  it('carries the get-ahead line, which is the reason the panel earns its space', () => {
    // And it comes off the CURRENT step, because it is about the spare time in the
    // step the cook is standing in — which is what lets it reach further than one
    // step forward. An oven wanted at s3 can be started during s1.
    const result = nextStepLookahead(
      THREE,
      [note('s1', { lookahead: 'it goes in the oven', getAhead: 'preheat the oven to 200°C' })],
      's1',
    );
    expect(result?.getAhead).toBe('preheat the oven to 200°C');
    expect(result?.lookahead).toBe('it goes in the oven');
  });

  it('answers on a get-ahead ALONE — a bare "start the oven now" is the whole point', () => {
    const result = nextStepLookahead(
      THREE,
      [note('s1', { getAhead: 'take the steak out of the fridge' })],
      's1',
    );
    expect(result).not.toBeNull();
    expect(result?.lookahead).toBeNull();
    expect(result?.getAhead).toBe('take the steak out of the fridge');
  });

  it('follows the METHOD, not the ticking — a completed next step still previews', () => {
    // Completion is not an input here on purpose: this describes what is physically
    // below the step on screen, and ticking things off in an odd order moves the
    // cook, never the method.
    const result = nextStepLookahead(THREE, [note('s1', { lookahead: 'it simmers' })], 's1');
    expect(result?.stepId).toBe('s2');
  });

  describe('returns null wherever there is nothing to preview', () => {
    it('no current step', () => {
      expect(nextStepLookahead(THREE, [note('s1', { lookahead: 'x' })], null)).toBeNull();
    });

    it('a current step the recipe no longer has', () => {
      expect(nextStepLookahead(THREE, [note('s2', { lookahead: 'x' })], 'deleted')).toBeNull();
    });

    it('the LAST step, even when the plan wrote it a look-ahead anyway', () => {
      // Not hypothetical: the prompt asks for one on every step, and a model given
      // that instruction writes "everything is ready" on the final step. There is
      // no step for it to be about, so the panel does not appear.
      expect(
        nextStepLookahead(THREE, [note('s3', { lookahead: 'everything is ready' })], 's3'),
      ).toBeNull();
    });

    it('a current step with no note at all', () => {
      expect(nextStepLookahead(THREE, [], 's1')).toBeNull();
    });

    it('a note that says everything EXCEPT a look-ahead', () => {
      // The common case for a while: a plan written before #769 has containers,
      // setups and cues and neither of these two fields. It must read as the plain
      // fade rather than as an empty panel.
      const result = nextStepLookahead(
        THREE,
        [note('s1', { container: 'onion bowl', setup: 'medium-low', cue: 'a gentle sizzle' })],
        's1',
      );
      expect(result).toBeNull();
    });

    it('a recipe with no steps at all', () => {
      expect(nextStepLookahead(recipe([]), [note('s2', { lookahead: 'x' })], 's1')).toBeNull();
    });

    it('a look-ahead that is blank rather than absent', () => {
      // An empty panel covering the next step is strictly worse than the fade it
      // replaced, so blank has to mean the same as null here rather than one line
      // down in the markup.
      expect(nextStepLookahead(THREE, [note('s1', { lookahead: '   ' })], 's1')).toBeNull();
      expect(nextStepLookahead(THREE, [note('s1', { lookahead: '' })], 's1')).toBeNull();
    });

    it('a note that predates the fields entirely, carrying neither key', () => {
      // A parsed document always reads back `string | null`. A note arriving from
      // anywhere else — a hand-edited doc, a draft, a fixture — can be missing the
      // keys outright, and `undefined === null` is false.
      const legacy: Omit<GuidedStepNoteDoc, 'lookahead' | 'getAhead'> = {
        stepId: 's1',
        container: null,
        setup: null,
        cue: null,
        checkIns: [],
      };
      expect(nextStepLookahead(THREE, [legacy as GuidedStepNoteDoc], 's1')).toBeNull();
    });
  });

  it('drops a blank half of an otherwise real answer', () => {
    const result = nextStepLookahead(
      THREE,
      [note('s1', { lookahead: '  ', getAhead: 'boil the kettle' })],
      's1',
    );
    expect(result?.lookahead).toBeNull();
    expect(result?.getAhead).toBe('boil the kettle');
  });

  it('is pure — it reads the notes and mutates nothing', () => {
    const notes = [note('s1', { lookahead: 'it simmers', getAhead: 'boil the kettle' })];
    const before = JSON.parse(JSON.stringify(notes)) as unknown;
    nextStepLookahead(THREE, notes, 's1');
    expect(notes).toEqual(before);
  });
});
