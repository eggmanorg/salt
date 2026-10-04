import { describe, it, expect } from 'vitest';
import {
  emptyRecipe,
  isCookable,
  relabelChoices,
  takesComponents,
  takesIngredients,
  withKind,
} from '@salt/domain';
import type { RecipeKind } from '@salt/domain';
import { RecipeKindSchema } from '@salt/domain/schemas';

// Relabelling (issue #1646): which labels an entry may switch between, and what
// the switch writes. The hazard the old "`kind` is immutable" rule guarded
// against was flipping a 20-ingredient recipe to `special` and hiding its
// ingredients and method; these pin that no choice offered can do that.

const NOW = '2026-10-04T00:00:00.000Z';

function entry(kind: RecipeKind, componentRecipeIds: string[] = []) {
  return { ...emptyRecipe('r1', NOW, kind), componentRecipeIds };
}

describe('relabelChoices', () => {
  it('offers recipe, cocktail, cure and bread to a plain recipe', () => {
    expect([...relabelChoices(entry('recipe'))].sort()).toEqual(
      ['bread', 'cocktail', 'cure', 'recipe'].sort(),
    );
  });

  it('offers a special and a placeholder nothing but themselves', () => {
    expect(relabelChoices(entry('special'))).toEqual(['special']);
    expect(relabelChoices(entry('placeholder'))).toEqual(['placeholder']);
  });

  it('never offers Cured meat to a meal, so its dishes never drop from view', () => {
    const choices = relabelChoices(entry('recipe', ['gravy']));
    expect(choices).not.toContain('cure');
    expect([...choices].sort()).toEqual(['bread', 'cocktail', 'recipe']);
  });

  it('never offers a choice that hides ingredients, a method or dishes — for every kind', () => {
    // Walks the enum on both ends, so a new kind is held to the same rule the day
    // it is added.
    for (const from of RecipeKindSchema.options) {
      for (const meal of [false, true]) {
        const recipe = entry(from, meal ? ['dish'] : []);
        for (const to of relabelChoices(recipe)) {
          if (to === from) continue;
          expect(takesIngredients(from) && isCookable(from)).toBe(true);
          expect(takesIngredients(to) && isCookable(to)).toBe(true);
          if (meal) expect(takesComponents(to)).toBe(true);
        }
      }
    }
  });

  it('always includes the label the entry wears now', () => {
    for (const kind of RecipeKindSchema.options) {
      expect(relabelChoices(entry(kind))).toContain(kind);
    }
  });
});

describe('withKind', () => {
  it('clears the cure type when leaving Cured meat', () => {
    const cure = { ...entry('cure'), cureCategory: 'dry_cured_whole_muscle' as const };
    const bread = withKind(cure, 'bread');
    expect(bread.kind).toBe('bread');
    expect(bread.cureCategory).toBeNull();
  });

  it('starts uncategorised on the way back, so the type is picked again', () => {
    const cure = { ...entry('cure'), cureCategory: 'semi_dry' as const };
    expect(withKind(withKind(cure, 'recipe'), 'cure').cureCategory).toBeNull();
  });

  it('keeps the cure type when the label stays Cured meat', () => {
    const cure = { ...entry('cure'), cureCategory: 'semi_dry' as const };
    expect(withKind(cure, 'cure').cureCategory).toBe('semi_dry');
  });

  it('changes nothing but the label (and a stale cure type)', () => {
    const recipe = { ...entry('recipe'), title: 'Sandwich Loaf', notes: 'Overnight.' };
    expect(withKind(recipe, 'bread')).toEqual({ ...recipe, kind: 'bread' });
  });
});
