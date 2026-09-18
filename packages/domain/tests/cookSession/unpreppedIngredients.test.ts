import { describe, it, expect } from 'vitest';
import type { Recipe } from '@salt/domain';
import type { GuidedPrepEntryDoc, IngredientDoc } from '@salt/domain/schemas';
import { unpreppedIngredients } from '../../src/cookSession/index.js';

// What a guided plan accounts for NOWHERE (issue #751, Phase 2) — the "Also get
// out" remainder. How much of the prep screen is ticked is asked of the board
// instead, and is tested beside it in guidedPrepBoard.test.ts.

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

function prep(id: string, ingredientIds: string[]): GuidedPrepEntryDoc {
  return { id, text: `do ${id}`, container: 'small bowl', ingredientIds };
}

describe('unpreppedIngredients', () => {
  it('is empty when every ingredient is named in some prep job', () => {
    const r = recipe([{ id: 'g1', name: null, items: [ingredient('i1'), ingredient('i2')] }]);
    expect(unpreppedIngredients(r, [prep('p1', ['i1']), prep('p2', ['i2'])])).toEqual([]);
  });

  it('lists an ingredient the plan predates, in the recipe-s own order', () => {
    const r = recipe([
      { id: 'g1', name: 'For the sauce', items: [ingredient('i1'), ingredient('i2')] },
      { id: 'g2', name: 'To serve', items: [ingredient('i3')] },
    ]);
    const result = unpreppedIngredients(r, [prep('p1', ['i2'])]);
    expect(result.map((i) => i.id)).toEqual(['i1', 'i3']);
  });

  it('counts an ingredient once however many jobs claim it (duplicate ids)', () => {
    const r = recipe([{ id: 'g1', name: null, items: [ingredient('i1'), ingredient('i2')] }]);
    const result = unpreppedIngredients(r, [prep('p1', ['i1']), prep('p2', ['i1'])]);
    expect(result.map((i) => i.id)).toEqual(['i2']);
  });

  it('ignores an id for an ingredient the recipe no longer has', () => {
    const r = recipe([{ id: 'g1', name: null, items: [ingredient('i1')] }]);
    const result = unpreppedIngredients(r, [prep('p1', ['i-gone'])]);
    expect(result.map((i) => i.id)).toEqual(['i1']);
  });

  it('INCLUDES optional ingredients — the section is the floor normal mise gives', () => {
    const r = recipe([
      { id: 'g1', name: null, items: [ingredient('i1'), ingredient('i2', { isOptional: true })] },
    ]);
    const result = unpreppedIngredients(r, []);
    expect(result.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('returns every ingredient when the plan has no prep at all', () => {
    const r = recipe([{ id: 'g1', name: null, items: [ingredient('i1'), ingredient('i2')] }]);
    expect(unpreppedIngredients(r, []).map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('skips empty groups without tripping over them', () => {
    const r = recipe([
      { id: 'g0', name: 'Empty', items: [] },
      { id: 'g1', name: null, items: [ingredient('i1')] },
    ]);
    expect(unpreppedIngredients(r, []).map((i) => i.id)).toEqual(['i1']);
  });
});
