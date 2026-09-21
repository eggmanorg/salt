import { describe, it, expect } from 'vitest';
import { emptyRecipe, newIngredient, newStep } from '@salt/domain';
import type { Ingredient, IngredientGroup, Recipe, Step } from '@salt/domain';
import type { RecipeKitEntryDoc } from '@salt/domain/schemas';

import { dropBlankRows } from '../src/routes/recipes/blankRows.js';

// The blank-row rule (issue #1319), as a pure function over a `Recipe`.
//
// The FLOW — that this runs at all three exits from edit mode and at no keystroke
// — is `RecipeViewPage.reviewFlag.test.ts`'s, driven through the UI. What is
// pinned HERE is the rule itself, one clause at a time, which is the half a pure
// function can actually be held to:
//
//   WHAT COUNTS AS BLANK, for each of the two kinds of row, including the cases
//   that deliberately SURVIVE — a wordless step carrying a note or a timer, a row
//   whose only content is whitespace, and a NAMED group with no rows at all.
//
//   THE IDENTITY RETURN, which is what makes Done on an untouched recipe issue no
//   write at all — and its boundary: a document that already carried a blank row
//   before anyone pressed Edit IS rewritten.
//
//   THE THREE RULES ARE INDEPENDENT. A recipe can need the ingredient prune and
//   not the step prune, or the kit prune and neither of the others; each was
//   separately capable of being missed by a change comparison that only counted
//   some of them.

const NOW = '2026-01-01T00:00:00.000Z';

function recipeWith(over: {
  steps?: Step[];
  ingredients?: IngredientGroup[];
  kit?: RecipeKitEntryDoc[];
}): Recipe {
  return { ...emptyRecipe('r1', NOW), title: 'Sourdough', ...over };
}

function kitEntry(label: string, over: Partial<RecipeKitEntryDoc> = {}): RecipeKitEntryDoc {
  return { label, stepIds: [], equipment: null, ...over };
}

function group(id: string, name: string | null, items: Ingredient[]): IngredientGroup {
  return { id, name, items };
}

describe('dropBlankRows — steps', () => {
  it('drops a step with no words, no note and no timer', () => {
    const recipe = recipeWith({ steps: [newStep('s1', 'Mix'), newStep('s2', '   ')] });

    expect(dropBlankRows(recipe).steps.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps a wordless step that carries a note', () => {
    const recipe = recipeWith({
      steps: [{ ...newStep('s1', ''), note: 'Ask Nan about the hydration' }],
    });

    expect(dropBlankRows(recipe).steps).toHaveLength(1);
  });

  it('keeps a wordless step that carries a timer', () => {
    const recipe = recipeWith({
      steps: [{ ...newStep('s1', ''), timer: { durationMinutes: 720, description: null } }],
    });

    expect(dropBlankRows(recipe).steps).toHaveLength(1);
  });
});

describe('dropBlankRows — ingredient rows and the groups they empty', () => {
  it('drops a row with no words, keeping the group and its siblings', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', 'Dough', [
          newIngredient('i1', '500g flour'),
          newIngredient('i2', '   '),
          newIngredient('i3', '350g water'),
        ]),
      ],
    });

    const pruned = dropBlankRows(recipe);

    expect(pruned.ingredients).toHaveLength(1);
    expect(pruned.ingredients[0]!.items.map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(pruned.ingredients[0]!.name).toBe('Dough');
  });

  // An UNNAMED group with no rows left is still disposable: nothing about it was
  // ever chosen by a human, which is the left side of
  // `.filter((g) => g.items.length > 0 || (g.name ?? '') !== '')` on its own.
  it('drops an unnamed group once its last row goes', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', 'Dough', [newIngredient('i1', '500g flour')]),
        group('g2', null, [newIngredient('i2', '')]),
      ],
    });

    expect(dropBlankRows(recipe).ingredients.map((g) => g.id)).toEqual(['g1']);
  });

  // A NAMED group survives losing its last row, and survives never having had one
  // at all (#1339 review, should-fix 6, correcting this suite's own former pin):
  // a heading is the one thing on an empty group a human DID choose, which
  // `isOptional` and `firstUsedInStepId` are not — so the argument that clears a
  // blank ingredient row does not clear a group's name. `+ Add a group` → type
  // "For the glaze" → leave with nothing typed into it now keeps the heading
  // rather than losing it at the very next exit from edit mode.
  it('keeps a named group once its last row goes', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', 'Dough', [newIngredient('i1', '500g flour')]),
        group('g2', 'For the glaze', [newIngredient('i2', '')]),
      ],
    });

    const pruned = dropBlankRows(recipe);

    expect(pruned.ingredients.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(pruned.ingredients[1]!.name).toBe('For the glaze');
    expect(pruned.ingredients[1]!.items).toEqual([]);
  });

  it('keeps a named group that never had any rows at all', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', 'Dough', [newIngredient('i1', '500g flour')]),
        group('g2', 'For the glaze', []),
      ],
    });

    expect(dropBlankRows(recipe).ingredients.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  // `isOptional` is a flag ABOUT a line and says nothing on its own — the header
  // states exactly that, so it is pinned rather than left to be inferred.
  it('drops a wordless row even when it has been marked optional', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', null, [newIngredient('i1', '500g flour'), newIngredient('i2', '', true)]),
      ],
    });

    expect(dropBlankRows(recipe).ingredients[0]!.items.map((i) => i.id)).toEqual(['i1']);
  });
});

describe('dropBlankRows — when it writes and when it does not', () => {
  it('hands back the very same object when there is nothing to drop', () => {
    const recipe = recipeWith({
      steps: [newStep('s1', 'Mix')],
      ingredients: [group('g1', 'Dough', [newIngredient('i1', '500g flour')])],
    });

    expect(dropBlankRows(recipe)).toBe(recipe);
  });

  // The boundary of that claim, stated in the header rather than rounded up to
  // "Done never writes unless you typed": a document that ALREADY carried a blank
  // row is rewritten by the first Done pressed on it.
  it('rewrites a document that already carried a blank row before anyone edited it', () => {
    const recipe = recipeWith({
      ingredients: [
        group('g1', null, [newIngredient('i1', '500g flour'), newIngredient('i2', '')]),
      ],
    });

    expect(dropBlankRows(recipe)).not.toBe(recipe);
  });

  // The two halves are independent, and a change comparison that counted only one
  // of them would return the original object in one of these two cases.
  it('returns a new recipe when only the ingredients need pruning', () => {
    const recipe = recipeWith({
      steps: [newStep('s1', 'Mix')],
      ingredients: [
        group('g1', null, [newIngredient('i1', '500g flour'), newIngredient('i2', '')]),
      ],
    });

    const pruned = dropBlankRows(recipe);

    expect(pruned).not.toBe(recipe);
    expect(pruned.steps).toEqual(recipe.steps);
    expect(pruned.ingredients[0]!.items).toHaveLength(1);
  });

  it('returns a new recipe when only the steps need pruning', () => {
    const recipe = recipeWith({
      steps: [newStep('s1', 'Mix'), newStep('s2', '')],
      ingredients: [group('g1', null, [newIngredient('i1', '500g flour')])],
    });

    const pruned = dropBlankRows(recipe);

    expect(pruned).not.toBe(recipe);
    expect(pruned.steps).toHaveLength(1);
    expect(pruned.ingredients).toEqual(recipe.ingredients);
  });

  it('leaves a group untouched, object for object, when none of its rows went', () => {
    const keeper = group('g1', 'Dough', [newIngredient('i1', '500g flour')]);
    const recipe = recipeWith({
      ingredients: [keeper, group('g2', null, [newIngredient('i2', '')])],
    });

    expect(dropBlankRows(recipe).ingredients[0]).toBe(keeper);
  });
});

describe('dropBlankRows — kit entries (issue #1496)', () => {
  it('drops an entry whose label is empty once trimmed', () => {
    const recipe = recipeWith({ kit: [kitEntry('frying pan'), kitEntry('   ')] });

    expect(dropBlankRows(recipe).kit.map((e) => e.label)).toEqual(['frying pan']);
  });

  it('keeps every named entry, link or no link, steps or no steps', () => {
    const kit = [
      kitEntry('frying pan'),
      kitEntry('Steam Basket', { equipment: { itemId: 'eq-1', accessoryId: 'acc-1' } }),
      kitEntry('oven glove', { stepIds: ['s1'] }),
    ];

    expect(dropBlankRows(recipeWith({ kit })).kit).toEqual(kit);
  });

  it('drops a labelless entry even when it carries a link and steps', () => {
    // There is no way to get here through the panel — its `+ Add equipment` writes
    // `{ label: '', stepIds: [], equipment: null }` and the only way to set either
    // of the other two is to choose words. So this pins the RULE, not a reachable
    // state: the label is the whole test, exactly as `rawText` is for a row.
    const recipe = recipeWith({
      kit: [kitEntry('', { stepIds: ['s1'], equipment: { itemId: 'eq-1', accessoryId: null } })],
    });

    expect(dropBlankRows(recipe).kit).toEqual([]);
  });

  it('returns the very same recipe when only the kit is clean', () => {
    const recipe = recipeWith({
      steps: [newStep('s1', 'Mix')],
      ingredients: [group('g1', null, [newIngredient('i1', '500g flour')])],
      kit: [kitEntry('frying pan')],
    });

    expect(dropBlankRows(recipe)).toBe(recipe);
  });

  it('returns a new recipe when ONLY the kit needs pruning', () => {
    // The independence clause: a change comparison that counted steps and
    // ingredients alone would hand this recipe straight back, and the nameless row
    // would live on the document forever.
    const recipe = recipeWith({
      steps: [newStep('s1', 'Mix')],
      ingredients: [group('g1', null, [newIngredient('i1', '500g flour')])],
      kit: [kitEntry('frying pan'), kitEntry('')],
    });

    const pruned = dropBlankRows(recipe);

    expect(pruned).not.toBe(recipe);
    expect(pruned.kit).toHaveLength(1);
    expect(pruned.steps).toEqual(recipe.steps);
    expect(pruned.ingredients).toEqual(recipe.ingredients);
  });
});
