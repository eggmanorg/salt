import { describe, it, expect } from 'vitest';
import { duplicateRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// A fully-populated source recipe: every field the policy has an opinion about is
// set to something distinguishable, so a test asserting "carried" is asserting on
// a real value rather than on a default that happens to match.
function fullRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'original-id',
    schemaVersion: 1,
    kind: 'recipe',
    cureCategory: null,
    title: 'Lasagne',
    description: 'The good one.',
    ingredients: [
      {
        id: 'group-1',
        name: 'For the ragù',
        items: [
          {
            id: 'ing-1',
            rawText: '500 g beef mince',
            parsed: {
              quantity: { type: 'single', value: 500 },
              unit: 'g',
              item: 'beef mince',
              preparation: ['browned'],
              notes: null,
              displayText: null,
            },
            canonId: 'canon-beef',
            matchState: 'matched',
            isOptional: false,
            firstUsedInStepId: 'step-1',
          },
        ],
      },
    ],
    steps: [
      {
        id: 'step-1',
        text: 'Brown the mince.',
        timer: { durationMinutes: 10, description: 'until browned' },
        note: 'Do not crowd the pan.',
      },
    ],
    metadata: {
      servings: 6,
      tags: ['comfort'],
    },
    source: { type: 'book', book: { title: 'River Cafe', author: 'Gray', page: 112 } },
    notes: 'Rest before slicing.',
    producesCanonId: 'canon-lasagne',
    componentRecipeIds: ['comp-chicken', 'comp-potatoes'],
    kit: [],
    image: { url: 'https://example.test/recipe-images/original-id.webp', source: 'ai' },
    imageBrief: 'A deep dish of lasagne, late afternoon light.',
    imageHint: 'more browning',
    imageRequestedAt: 1_754_000_000_000,
    imageHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Kate',
    ...overrides,
  };
}

const NOW = '2026-08-07T09:00:00.000Z';

describe('duplicateRecipe', () => {
  describe('replaces', () => {
    it('takes the id it is handed rather than minting one', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).id).toBe('new-id');
    });

    it('suffixes the title with " (copy)"', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).title).toBe('Lasagne (copy)');
    });

    it('stamps createdAt from the clock it is handed', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).createdAt).toBe(NOW);
    });

    it('leaves updatedAt blank for persistRecipe to stamp on save', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).updatedAt).toBe('');
    });
  });

  describe('drops every image field', () => {
    // The single most important property in issue #735: a carried `image` points
    // the copy at the ORIGINAL's Storage object, which the doc-id-keyed orphan
    // sweep deletes when the original is deleted.
    it('resets image to null', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).image).toBeNull();
    });

    it.each(['imageBrief', 'imageHint', 'imageRequestedAt', 'imageHidden'] as const)(
      'omits %s entirely, rather than setting it to undefined',
      (field) => {
        expect(duplicateRecipe(fullRecipe(), 'new-id', NOW)).not.toHaveProperty(field);
      },
    );
  });

  describe('resets', () => {
    it('clears producesCanonId so the copy does not double the producer list', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW).producesCanonId).toBeNull();
    });

    // Issue #845, and a policy rather than an oversight: a copy belongs to
    // whoever copied it, so the original's creator is not carried. Both fields go
    // out blank and the service stamps the copier on save.
    it('drops the attribution — a copy is not credited to the original author', () => {
      const copy = duplicateRecipe(fullRecipe(), 'new-id', NOW);
      expect(copy.createdBy).toBe('');
      expect(copy.lastEditedBy).toBe('');
    });
  });

  describe('carries', () => {
    it.each(['recipe', 'special', 'cocktail', 'placeholder'] as const)(
      'inherits kind %s — copying never changes what an entry is',
      (kind) => {
        expect(duplicateRecipe(fullRecipe({ kind }), 'new-id', NOW).kind).toBe(kind);
      },
    );

    it('carries description, notes, source, metadata and schemaVersion verbatim', () => {
      const source = fullRecipe();
      const copy = duplicateRecipe(source, 'new-id', NOW);
      expect(copy.schemaVersion).toBe(source.schemaVersion);
      expect(copy.description).toBe(source.description);
      expect(copy.notes).toBe(source.notes);
      expect(copy.source).toEqual(source.source);
      expect(copy.metadata).toEqual(source.metadata);
    });

    it('carries needs_approval — copying an AI-written recipe is not reading it', () => {
      expect(
        duplicateRecipe(fullRecipe({ needs_approval: true }), 'new-id', NOW).needs_approval,
      ).toBe(true);
    });

    it('omits needs_approval when the original had none', () => {
      expect(duplicateRecipe(fullRecipe(), 'new-id', NOW)).not.toHaveProperty('needs_approval');
    });

    it('carries the whole ingredient tree, ids included', () => {
      const source = fullRecipe();
      expect(duplicateRecipe(source, 'new-id', NOW).ingredients).toEqual(source.ingredients);
    });

    it('carries the steps, ids included', () => {
      const source = fullRecipe();
      expect(duplicateRecipe(source, 'new-id', NOW).steps).toEqual(source.steps);
    });

    it('preserves firstUsedInStepId against the step id it points at', () => {
      const copy = duplicateRecipe(fullRecipe(), 'new-id', NOW);
      const link = copy.ingredients[0]!.items[0]!.firstUsedInStepId;
      expect(link).toBe('step-1');
      expect(copy.steps.map((s) => s.id)).toContain(link);
    });

    it('carries the components — a copy of a Sunday roast is still a Sunday roast', () => {
      // Issue #752. The opposite of `producesCanonId` above, and deliberately so:
      // two copies of a roast pointing at the same gravy is simply true, whereas
      // two recipes both claiming to produce Chicken Stock is a contradiction.
      const source = fullRecipe();
      expect(duplicateRecipe(source, 'new-id', NOW).componentRecipeIds).toEqual([
        'comp-chicken',
        'comp-potatoes',
      ]);
    });

    it('value-clones the components rather than aliasing the original array', () => {
      // The component RECIPES are separate documents and are not duplicated — the
      // copy points at the same dishes — but the array of ids must be its own, so
      // editing the copy's running order cannot reach into the original.
      const source = fullRecipe();
      const copy = duplicateRecipe(source, 'new-id', NOW);
      expect(copy.componentRecipeIds).not.toBe(source.componentRecipeIds);
    });

    it('keeps existing canon resolutions, so the copy costs no re-canonicalisation', () => {
      const item = duplicateRecipe(fullRecipe(), 'new-id', NOW).ingredients[0]!.items[0]!;
      expect(item.canonId).toBe('canon-beef');
      expect(item.matchState).toBe('matched');
      expect(item.parsed).not.toBeNull();
    });
  });

  describe('purity', () => {
    it('does not touch the original', () => {
      const source = fullRecipe();
      const before = structuredClone(source);
      duplicateRecipe(source, 'new-id', NOW);
      expect(source).toEqual(before);
    });

    it('value-clones the nested tree so editing the copy cannot reach the original', () => {
      const source = fullRecipe();
      const copy = duplicateRecipe(source, 'new-id', NOW);
      expect(copy.ingredients[0]).not.toBe(source.ingredients[0]);
      expect(copy.ingredients[0]!.items[0]).not.toBe(source.ingredients[0]!.items[0]);
      expect(copy.ingredients[0]!.items[0]!.parsed).not.toBe(
        source.ingredients[0]!.items[0]!.parsed,
      );
      expect(copy.steps[0]).not.toBe(source.steps[0]);
      expect(copy.steps[0]!.timer).not.toBe(source.steps[0]!.timer);
      expect(copy.metadata).not.toBe(source.metadata);
      expect(copy.metadata.tags).not.toBe(source.metadata.tags);
      expect(copy.source).not.toBe(source.source);
    });

    it('is deterministic — same inputs, same output', () => {
      const source = fullRecipe();
      expect(duplicateRecipe(source, 'new-id', NOW)).toEqual(
        duplicateRecipe(source, 'new-id', NOW),
      );
    });
  });

  it('carries the kit and its stamp — the copy needs the same pans, and the step ids still fit', () => {
    const source = fullRecipe({
      kit: [{ label: 'large frying pan', stepIds: ['step-1'] }],
      kitInferredAt: 1_700_000_000_000,
    });
    const copy = duplicateRecipe(source, 'new-id', NOW);
    expect(copy.kit).toEqual([{ label: 'large frying pan', stepIds: ['step-1'] }]);
    // Carried WITH the stamp, so the copy does not pay for an inference that could
    // only reproduce the answer above it. Step ids are not re-minted, so every
    // reference is still a step in the copy.
    expect(copy.kitInferredAt).toBe(1_700_000_000_000);
    expect(copy.kit).not.toBe(source.kit);
    expect(copy.kit[0]!.stepIds).not.toBe(source.kit[0]!.stepIds);
  });

  it('leaves an un-inferred source un-stamped so the trigger picks the copy up', () => {
    const copy = duplicateRecipe(fullRecipe(), 'new-id', NOW);
    expect(copy.kitInferredAt).toBeUndefined();
    expect('kitInferredAt' in copy).toBe(false);
  });

  it('drops the redo nonce — it is a one-shot request, not a property of the dish', () => {
    const copy = duplicateRecipe(fullRecipe({ kitRequestedAt: 123 }), 'new-id', NOW);
    expect(copy.kitRequestedAt).toBeUndefined();
  });

  it('copies an entry with no ingredients, steps, source or image (a special)', () => {
    const special = fullRecipe({
      kind: 'special',
      ingredients: [],
      steps: [],
      source: null,
      image: null,
      description: null,
      notes: null,
    });
    const copy = duplicateRecipe(special, 'new-id', NOW);
    expect(copy.kind).toBe('special');
    expect(copy.ingredients).toEqual([]);
    expect(copy.steps).toEqual([]);
    expect(copy.source).toBeNull();
    expect(copy.image).toBeNull();
  });
});
