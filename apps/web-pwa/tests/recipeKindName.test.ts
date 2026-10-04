import { describe, it, expect } from 'vitest';
import { RecipeKindSchema } from '@salt/domain/schemas';
import { KIND_COPY, kindName, toRecipeKind } from '../src/routes/recipes/recipeKind.js';

// The label picker's words and its trust-boundary parse (issue #1646).
describe('kindName', () => {
  it('names the four labels a recipe can switch between', () => {
    expect(kindName('recipe')).toBe('Recipe');
    expect(kindName('bread')).toBe('Bread');
    expect(kindName('cure')).toBe('Cured meat');
    expect(kindName('cocktail')).toBe('Cocktail');
  });

  it('is the count noun with a capital, for every kind', () => {
    for (const kind of RecipeKindSchema.options) {
      expect(kindName(kind).toLowerCase()).toBe(KIND_COPY[kind].one.toLowerCase());
    }
  });
});

describe('toRecipeKind', () => {
  it('reads a stored kind back', () => {
    expect(toRecipeKind('bread', 'recipe')).toBe('bread');
  });

  it('keeps the current label rather than writing anything it does not recognise', () => {
    expect(toRecipeKind('loaf', 'cure')).toBe('cure');
    expect(toRecipeKind('', 'recipe')).toBe('recipe');
  });
});
