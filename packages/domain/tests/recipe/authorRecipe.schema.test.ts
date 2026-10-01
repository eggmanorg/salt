import { describe, it, expect } from 'vitest';
import {
  LibrarianOutputSchema,
  ExtractRecipeAIOutputSchema,
  ExtractRecipeFromPhotoAIOutputSchema,
  MAX_RECIPE_PHASES,
} from '../../src/schemas/index.js';

// The gate the librarian (chat authoring — create, edit and variation) feeds its
// model output through. It had no test file at all until issue #1123, which is
// how `servings` stayed unconstrained here for as long as it did: #952 aligned
// the three time fields with the extractor's and left the fourth field behind,
// and nothing went red.

const BASE = {
  title: 'Carbonara',
  description: 'Guanciale, egg, pecorino.',
  servings: 4,
  tags: ['italian'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: '2 eggs', isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: 'Beat the eggs.', timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

describe('LibrarianOutputSchema — servings', () => {
  it('accepts a positive whole count', () => {
    expect(LibrarianOutputSchema.safeParse(BASE).success).toBe(true);
  });

  it('rejects null — every recipe says how many it serves', () => {
    expect(LibrarianOutputSchema.safeParse({ ...BASE, servings: null }).success).toBe(false);
  });

  it('rejects servings: 0 — a recipe nobody can eat is a model glitch', () => {
    expect(LibrarianOutputSchema.safeParse({ ...BASE, servings: 0 }).success).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(LibrarianOutputSchema.safeParse({ ...BASE, servings: -3 }).success).toBe(false);
  });

  it('rejects a fractional count — these are whole servings', () => {
    expect(LibrarianOutputSchema.safeParse({ ...BASE, servings: 2.5 }).success).toBe(false);
  });
});

// The importers can answer "this is not a recipe", and only that answer may
// leave servings null — every recipe says how many it serves. The photo schema
// extends the URL one, and a refinement does not survive `.extend`, so it is
// pinned separately: dropping its `.superRefine` would otherwise go unnoticed.
describe('the import schemas — servings may be null only on a not-a-recipe answer', () => {
  const recipe = { ...BASE, isRecipe: true };
  const notARecipe = { ...BASE, isRecipe: false, servings: null };
  const book = { title: null, author: null, page: null };

  it('URL: rejects a recipe with null servings', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse({ ...recipe, servings: null }).success).toBe(
      false,
    );
  });

  it('URL: accepts null servings on a not-a-recipe answer', () => {
    expect(ExtractRecipeAIOutputSchema.safeParse(notARecipe).success).toBe(true);
  });

  it('photo: rejects a recipe with null servings', () => {
    expect(
      ExtractRecipeFromPhotoAIOutputSchema.safeParse({ ...recipe, servings: null, book }).success,
    ).toBe(false);
  });

  it('photo: accepts a recipe with servings, and null servings on a not-a-recipe answer', () => {
    expect(ExtractRecipeFromPhotoAIOutputSchema.safeParse({ ...recipe, book }).success).toBe(true);
    expect(ExtractRecipeFromPhotoAIOutputSchema.safeParse({ ...notARecipe, book }).success).toBe(
      true,
    );
  });
});

// The header comment on `LibrarianOutputSchema` claims its numeric field carries
// the same constraints as `ExtractRecipeAIOutputSchema`'s. That sentence is
// exactly the kind nothing falsifies when one of the two files is edited alone —
// which is what happened between #952 and #1123 — so it is pinned rather than
// asserted: one value matrix, both schemas, identical verdicts required.
describe('LibrarianOutputSchema agrees with ExtractRecipeAIOutputSchema, number for number', () => {
  const NUMERIC_FIELDS = ['servings'] as const;
  const VALUES = [0, 1, -1, 2.5, 1440, null];

  // The extractor carries one field the librarian does not: `isRecipe` marks a
  // page that turned out not to be a recipe at all, which a conversation cannot
  // be. Everything else the two share.
  const EXTRACTOR_BASE = { ...BASE, isRecipe: true };

  for (const field of NUMERIC_FIELDS) {
    for (const value of VALUES) {
      it(`${field}: ${String(value)}`, () => {
        const librarian = LibrarianOutputSchema.safeParse({ ...BASE, [field]: value }).success;
        const extractor = ExtractRecipeAIOutputSchema.safeParse({
          ...EXTRACTOR_BASE,
          [field]: value,
        }).success;

        expect(librarian).toBe(extractor);
      });
    }
  }
});

// The `phases` gate has no retry on this path (issue #1122 review, blocking 3):
// `authorRecipe.ts` throws straight from a failed `LibrarianOutputSchema` parse,
// so a strip that fails `AuthoredRecipePhasesSchema` must degrade to no strip
// rather than take the whole chat-authored recipe down with it.
describe('LibrarianOutputSchema — a malformed strip degrades, never fails the parse', () => {
  const validPhase = { label: 'Prep', handsOnMinutes: 10, handsOffMinutes: 0 };

  it('accepts a strip at the cap', () => {
    const phases = Array.from({ length: MAX_RECIPE_PHASES }, () => validPhase);
    const result = LibrarianOutputSchema.safeParse({ ...BASE, phases });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phases).toHaveLength(MAX_RECIPE_PHASES);
  });

  it('drops a strip one block over the cap, and keeps the rest of the recipe', () => {
    const phases = Array.from({ length: MAX_RECIPE_PHASES + 1 }, () => validPhase);
    const result = LibrarianOutputSchema.safeParse({ ...BASE, phases });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phases).toEqual([]);
      expect(result.data.title).toBe('Carbonara');
    }
  });

  it('drops a strip with a fractional minute, and keeps the rest of the recipe', () => {
    const phases = [{ label: 'Prep', handsOnMinutes: 7.5, handsOffMinutes: 0 }];
    const result = LibrarianOutputSchema.safeParse({ ...BASE, phases });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phases).toEqual([]);
      expect(result.data.title).toBe('Carbonara');
    }
  });

  it('drops a strip with a negative minute', () => {
    const phases = [{ label: 'Prep', handsOnMinutes: -1, handsOffMinutes: 0 }];
    const result = LibrarianOutputSchema.safeParse({ ...BASE, phases });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phases).toEqual([]);
  });
});

// ─── sourceStepId (issue #1178) ────────────────────────────────────────────────

// The librarian's one amend-only field. Everything here is about it NOT being a
// hard requirement: the model can omit it, null it, or answer with a shape from
// before the field existed, and the recipe still parses. That is what makes the
// whole feature safe to ship without a flag — the worst case is the behaviour we
// had yesterday, not a failed amend.
describe('LibrarianOutputSchema — sourceStepId', () => {
  it('parses a step that cites the id it came from', () => {
    const steps = [{ ...BASE.steps[0]!, sourceStepId: 'step-abc' }];
    const result = LibrarianOutputSchema.safeParse({ ...BASE, steps });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]!.sourceStepId).toBe('step-abc');
  });

  it('parses a step that explicitly cites nothing', () => {
    const steps = [{ ...BASE.steps[0]!, sourceStepId: null }];
    const result = LibrarianOutputSchema.safeParse({ ...BASE, steps });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]!.sourceStepId).toBeNull();
  });

  it('parses a response that has never heard of the field, and leaves it undefined', () => {
    // Back-compat, and the shape every FUNCTIONS_AI_FAKE fixture and every model
    // that ignores the instruction returns. `BASE.steps` carries no sourceStepId.
    const result = LibrarianOutputSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.steps[0]!.sourceStepId).toBeUndefined();
  });

  it('rejects a non-string citation rather than coercing it', () => {
    const steps = [{ ...BASE.steps[0]!, sourceStepId: 7 }];
    expect(LibrarianOutputSchema.safeParse({ ...BASE, steps }).success).toBe(false);
  });

  it('keeps the field off the extractor contract, where it could only ever be null', () => {
    // Decision 2 on #1178, made mechanical: adding `sourceStepId` to
    // `ExtractedStepSchema` itself would put an amend-only field in the URL and
    // photo importers' wire shape. Zod strips unknown keys, so a citation offered
    // there is dropped rather than carried.
    const result = ExtractRecipeAIOutputSchema.safeParse({
      isRecipe: true,
      ...BASE,
      steps: [{ ...BASE.steps[0]!, sourceStepId: 'step-abc' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0]!).not.toHaveProperty('sourceStepId');
    }
  });
});
