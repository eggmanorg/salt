import { describe, it, expect } from 'vitest';
import {
  LibrarianOutputSchema,
  ExtractRecipeAIOutputSchema,
  ExtractRecipeFromPhotoAIOutputSchema,
} from '@salt/domain/schemas';
import { AUTHORABLE_RECIPE_KINDS, isAuthorable } from '@salt/domain';

// The `kind` the AI authoring paths may emit (issue #765).
//
// Two properties are being pinned here, and only one of them is about the happy
// path:
//
//  1. The BOUND — `special` and `placeholder` are not on the wire at all, so no
//     model answer can mint an entry whose `takesIngredients` is false and then
//     write an ingredient list onto it.
//  2. The FLOOR — a missing, null, mis-cased or invented kind degrades to
//     `'recipe'` and NEVER fails the parse. That is load-bearing: a failed parse
//     here is a failed import, and on the librarian path (which has no retry)
//     it throws away the user's whole conversation. It is also the asymmetry the
//     issue argues — a cocktail filed under Recipes still works, a dinner filed
//     under Cocktails can never be planned and `kind` is immutable.
//
// Both are asserted on ALL THREE shapes, because the third inherits the field via
// `.extend()` and an inheritance that quietly stopped working would look exactly
// like a passing test on the other two.

/** The smallest payload each schema accepts, minus the field under test. */
const LIBRARIAN_BASE = {
  title: 'Negroni',
  description: null,
  servings: 1,
  tags: [],
  ingredientGroups: [],
  steps: [],
  notes: null,
};

const EXTRACT_BASE = { ...LIBRARIAN_BASE, isRecipe: true };
const PHOTO_BASE = { ...EXTRACT_BASE, book: null };

const SHAPES = [
  ['LibrarianOutputSchema', LibrarianOutputSchema, LIBRARIAN_BASE],
  ['ExtractRecipeAIOutputSchema', ExtractRecipeAIOutputSchema, EXTRACT_BASE],
  ['ExtractRecipeFromPhotoAIOutputSchema', ExtractRecipeFromPhotoAIOutputSchema, PHOTO_BASE],
] as const;

describe.each(SHAPES)('%s — the authored kind', (_name, schema, base) => {
  it('accepts an explicit cocktail', () => {
    const parsed = schema.safeParse({ ...base, kind: 'cocktail' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('cocktail');
  });

  it('accepts an explicit recipe', () => {
    const parsed = schema.safeParse({ ...base, kind: 'recipe' });
    expect(parsed.success && parsed.data.kind).toBe('recipe');
  });

  // The floor, one row per way a model gets it wrong. Every one of these PARSES —
  // the assertion is as much about `success` as about the value.
  it.each([
    ['the field is missing entirely', {}],
    ['the field is null', { kind: null }],
    ['the field is undefined', { kind: undefined }],
    ['the model answered a kind it was never offered', { kind: 'special' }],
    ['the model answered the other one it was never offered', { kind: 'placeholder' }],
    ['the model got the case wrong', { kind: 'Cocktail' }],
    ['the model answered something invented', { kind: 'drink' }],
    ['the model answered the wrong type', { kind: 7 }],
  ])('degrades to recipe, without failing, when %s', (_why, patch) => {
    const parsed = schema.safeParse({ ...base, ...patch });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('recipe');
  });

  it('is bounded to the authorable kinds, and nothing else parses through', () => {
    // Walks the set rather than naming two literals, so a fifth authorable kind
    // is covered here the day it is added to the table.
    for (const kind of AUTHORABLE_RECIPE_KINDS) {
      const parsed = schema.safeParse({ ...base, kind });
      expect(parsed.success && parsed.data.kind).toBe(kind);
      expect(isAuthorable(kind)).toBe(true);
    }
  });
});
