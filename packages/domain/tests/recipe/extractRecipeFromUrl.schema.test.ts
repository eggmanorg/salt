import { describe, it, expect } from 'vitest';
import { ExtractRecipeAIOutputSchema } from '../../src/schemas/index.js';

// The gate the URL and book-photo imports both feed their model output through.
// What it still constrains is `servings` and the phase strip: issue #1211 removed
// the three time fields it once gated, and issue #739's asymmetry — a strict 0 on
// servings against a permissive 0 on the times — went with them.

const BASE = {
  isRecipe: true,
  title: 'Greek salad',
  description: 'Chunky, quick, no cooking at all.',
  servings: 4,
  tags: ['greek'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: '2 tomatoes', isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: 'Chop the tomatoes.', timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

describe('ExtractRecipeAIOutputSchema — the base shape', () => {
  it('accepts a well-formed extraction', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse(BASE).success).toBe(true);
  });

  it('rejects servings: null on a recipe — every recipe says how many it serves', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse({ ...BASE, servings: null }).success).toBe(false);
  });

  it('accepts servings: null on a not-a-recipe answer', () => {
    expect(
      ExtractRecipeAIOutputSchema.safeParse({ ...BASE, isRecipe: false, servings: null }).success,
    ).toBe(true);
  });
});

describe('ExtractRecipeAIOutputSchema — the glitch guard that stays strict', () => {
  it('rejects servings: 0 — a recipe nobody can eat is a model glitch', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse({ ...BASE, servings: 0 }).success).toBe(false);
  });

  it('rejects a negative servings count', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse({ ...BASE, servings: -1 }).success).toBe(false);
  });
});
