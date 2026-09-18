import { describe, it, expect } from 'vitest';
import { prepEntryForContainer, prepEntryIngredients, looseIngredientsForStep } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { GuidedPrepEntryDoc, GuidedStepNoteDoc, IngredientDoc } from '@salt/domain/schemas';
import { normaliseContainerName } from '../../src/cookSession/index.js';

// The three questions guided mode has to answer before it can show an amount
// (issue #761, Phase 1): which job filled the bowl this step names, what that job
// prepares, and what the step introduces that came out of no bowl at all.

function ingredient(id: string, over: Partial<IngredientDoc> = {}): IngredientDoc {
  return {
    id,
    rawText: `${id} of something`,
    parsed: null,
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
    ...over,
  };
}

function recipe(
  groups: Array<{ id: string; name: string | null; items: IngredientDoc[] }>,
): Recipe {
  return {
    cureCategory: null,
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Weeknight ragù',
    description: null,
    ingredients: groups,
    steps: [],
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

function prep(
  id: string,
  container: string | null,
  ingredientIds: string[] = [],
): GuidedPrepEntryDoc {
  return { id, text: `do ${id}`, container, ingredientIds };
}

function note(over: Partial<GuidedStepNoteDoc> = {}): GuidedStepNoteDoc {
  return {
    stepId: 's1',
    container: null,
    setup: null,
    cue: null,
    checkIns: [],
    lookahead: null,
    getAhead: null,
    ...over,
  };
}

describe('normaliseContainerName', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(normaliseContainerName('  Small Bowl ')).toBe('small bowl');
  });

  it('collapses runs of internal whitespace to one space', () => {
    expect(normaliseContainerName('small\t\n  bowl')).toBe('small bowl');
  });

  it('normalises a name that is only whitespace to the empty string', () => {
    expect(normaliseContainerName('   ')).toBe('');
    expect(normaliseContainerName('')).toBe('');
  });

  it('does NOT fold anything a cook would read as a different bowl', () => {
    expect(normaliseContainerName('onion bowl')).not.toBe(normaliseContainerName('onions bowl'));
  });
});

describe('prepEntryForContainer', () => {
  const PREP = [prep('p1', 'small bowl', ['i1']), prep('p2', 'big pan', ['i2'])];

  it('finds the job that filled the bowl the step names', () => {
    expect(prepEntryForContainer(PREP, 'small bowl')?.id).toBe('p1');
  });

  it('matches through case and stray whitespace', () => {
    expect(prepEntryForContainer(PREP, '  Small   Bowl ')?.id).toBe('p1');
  });

  it('returns null when the step names no container', () => {
    expect(prepEntryForContainer(PREP, null)).toBeNull();
  });

  it('returns null for a blank container name — the same as naming none', () => {
    expect(prepEntryForContainer(PREP, '   ')).toBeNull();
  });

  it('returns null when no job fills the named container — never an error', () => {
    expect(prepEntryForContainer(PREP, 'the tureen')).toBeNull();
  });

  it('never matches a job that puts its result nowhere', () => {
    expect(prepEntryForContainer([prep('p1', null, ['i1'])], 'small bowl')).toBeNull();
  });

  it('takes the FIRST job in plan order when two fill the same-named bowl', () => {
    const dupes = [prep('p1', 'small bowl', ['i1']), prep('p2', 'Small bowl', ['i2'])];
    expect(prepEntryForContainer(dupes, 'small bowl')?.id).toBe('p1');
  });

  it('has nothing to find in an empty plan', () => {
    expect(prepEntryForContainer([], 'small bowl')).toBeNull();
  });
});

describe('prepEntryIngredients', () => {
  const R = recipe([
    { id: 'g1', name: 'For the sauce', items: [ingredient('i1'), ingredient('i2')] },
    { id: 'g2', name: 'To serve', items: [ingredient('i3')] },
  ]);

  it('resolves the job-s ids to the recipe-s own ingredients', () => {
    const result = prepEntryIngredients(R, prep('p1', 'small bowl', ['i1', 'i3']));
    expect(result.map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(result[0]?.rawText).toBe('i1 of something');
  });

  it('returns them in RECIPE order, not the order the plan listed them', () => {
    const result = prepEntryIngredients(R, prep('p1', 'small bowl', ['i3', 'i1', 'i2']));
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('lists an ingredient once however many times the job names it', () => {
    const result = prepEntryIngredients(R, prep('p1', 'small bowl', ['i1', 'i1']));
    expect(result.map((i) => i.id)).toEqual(['i1']);
  });

  it('drops an id for an ingredient the recipe no longer has', () => {
    const result = prepEntryIngredients(R, prep('p1', 'small bowl', ['i-gone', 'i2']));
    expect(result.map((i) => i.id)).toEqual(['i2']);
  });

  it('is empty for a job that names no ingredients', () => {
    expect(prepEntryIngredients(R, prep('p1', 'small bowl', []))).toEqual([]);
  });

  it('is empty for a null entry, so it chains off prepEntryForContainer', () => {
    expect(prepEntryIngredients(R, prepEntryForContainer([], 'the tureen'))).toEqual([]);
  });

  it('skips empty groups without tripping over them', () => {
    const r = recipe([
      { id: 'g0', name: 'Empty', items: [] },
      { id: 'g1', name: null, items: [ingredient('i1')] },
    ]);
    expect(prepEntryIngredients(r, prep('p1', null, ['i1'])).map((i) => i.id)).toEqual(['i1']);
  });
});

describe('looseIngredientsForStep', () => {
  const FIRST_USE = [ingredient('i1'), ingredient('i2'), ingredient('i3')];
  const PREP = [prep('p1', 'small bowl', ['i1']), prep('p2', 'big pan', ['i2'])];

  it('subtracts what is already shown in the bowl this step names', () => {
    const result = looseIngredientsForStep(FIRST_USE, PREP, note({ container: 'small bowl' }));
    expect(result.map((i) => i.id)).toEqual(['i2', 'i3']);
  });

  it('subtracts ONLY that bowl — a different bowl-s contents are still printed', () => {
    // i2 went into "big pan", which this step does not reach for. Plain cook mode
    // reprints it here, so guided mode must too.
    const result = looseIngredientsForStep(FIRST_USE, PREP, note({ container: 'small bowl' }));
    expect(result.map((i) => i.id)).toContain('i2');
  });

  it('subtracts nothing for a `container: null` prep job ("open the tin")', () => {
    const openTheTin = [prep('p1', null, ['i1'])];
    const result = looseIngredientsForStep(FIRST_USE, openTheTin, note({ container: null }));
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('subtracts nothing when the step has no plan note at all', () => {
    const result = looseIngredientsForStep(FIRST_USE, PREP, null);
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('subtracts nothing when the note names a container no job fills', () => {
    const result = looseIngredientsForStep(FIRST_USE, PREP, note({ container: 'the tureen' }));
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('matches the container through case and whitespace', () => {
    const result = looseIngredientsForStep(FIRST_USE, PREP, note({ container: ' SMALL  bowl ' }));
    expect(result.map((i) => i.id)).toEqual(['i2', 'i3']);
  });

  it('uses the FIRST duplicate-named job, matching what the bowl row displays', () => {
    const dupes = [prep('p1', 'small bowl', ['i1']), prep('p2', 'small bowl', ['i2'])];
    const result = looseIngredientsForStep(FIRST_USE, dupes, note({ container: 'small bowl' }));
    expect(result.map((i) => i.id)).toEqual(['i2', 'i3']);
  });

  it('keeps the step-s own first-use order', () => {
    const result = looseIngredientsForStep(FIRST_USE, [], note());
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('is empty when the step introduces nothing', () => {
    expect(looseIngredientsForStep([], PREP, note({ container: 'small bowl' }))).toEqual([]);
  });

  it('is pure — reads its inputs and writes nothing', () => {
    const firstUse = [...FIRST_USE];
    looseIngredientsForStep(firstUse, PREP, note({ container: 'small bowl' }));
    expect(firstUse.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
    expect(PREP.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
