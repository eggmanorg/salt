import { describe, expect, it } from 'vitest';

import type { CanonItem, Ingredient, ProductForm } from '@salt/domain';
import { RecipeSchema } from '@salt/domain/schemas';
import { countedLineReason } from '../scripts/lib/countedLineNet.js';

// The #1643 net of scripts/scan-rematch-candidates.ts (Phase 4). The script reads
// Firestore at import time, so this exercises the pure half it calls — see the
// module header for what the net catches and why (docs/one-shot-scripts.md §2).
//
// Every line is built through the ingredient schema INSIDE the real
// `RecipeSchema` — the schema the scan reads recipes with — because the net rests on that schema keeping an absent
// `statedCount` absent rather than defaulting it to null. A `.default(null)` on
// the field would empty this net silently; here it reds the first case.

const CANON_BASE: CanonItem = {
  id: 'canon-chicken',
  schemaVersion: 5,
  name: 'Chicken',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  embedding: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const CHICKEN = CANON_BASE;
const RED_ONION: CanonItem = { ...CANON_BASE, id: 'canon-onion', name: 'Red Onion' };
const FLOUR: CanonItem = { ...CANON_BASE, id: 'canon-flour', name: 'Plain Flour', unit: 'g' };

// The prod docs from the issue's reproduction: productForms/811ab961… and 4256c30b….
const CARCASS: ProductForm = {
  id: 'form-carcass',
  schemaVersion: 1,
  matchers: ['roast chicken carcass', 'chicken carcass'],
  thumbnail: null,
  parentCanonId: 'canon-chicken',
  label: 'Chicken carcass',
  yield: { formUnit: 'count', amountPerParent: 1 },
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const IngredientSchema = RecipeSchema.shape.ingredients.element.shape.items.element;

const CANON_BY_ID = new Map([CHICKEN, RED_ONION, FLOUR].map((c) => [c.id, c]));
const FORMS = [CARCASS];

function line(canonId: string | null, parsed: Record<string, unknown> | null): Ingredient {
  return IngredientSchema.parse({
    id: 'ing-1',
    rawText: 'raw',
    parsed:
      parsed === null
        ? null
        : { quantity: null, unit: null, preparation: [], notes: null, ...parsed },
    canonId,
    matchState: canonId === null ? 'failed' : 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  });
}

const reason = (ing: Ingredient) => countedLineReason(ing, CANON_BY_ID, FORMS);
const g = (value: number) => ({ type: 'single', value });

describe('countedLineReason', () => {
  it('nets the prod carcass line — a counted form, 1500 g, never parsed for its count', () => {
    const carcass = line('canon-chicken', {
      quantity: g(1500),
      unit: 'g',
      item: 'roast chicken carcass',
      displayText: '1 roast chicken carcass',
    });
    expect(carcass.parsed?.statedCount).toBeUndefined();
    expect(reason(carcass)).toBe('unread');
  });

  it('nets a counted canon line stored by weight before #1643 ("1 red onion" → 150 g)', () => {
    expect(reason(line('canon-onion', { quantity: g(150), unit: 'g', item: 'red onion' }))).toBe(
      'unread',
    );
  });

  it('releases a re-read line that stated no count — so the post-run scan can reach zero', () => {
    expect(
      reason(
        line('canon-onion', { quantity: g(300), unit: 'g', item: 'red onion', statedCount: null }),
      ),
    ).toBeNull();
  });

  it('releases a re-read line that gained its count', () => {
    expect(
      reason(
        line('canon-chicken', {
          quantity: g(500),
          unit: 'g',
          item: 'roast chicken carcass',
          statedCount: g(1),
        }),
      ),
    ).toBeNull();
  });

  it('keeps a re-read counted-form line with grams only, as missing_count — a re-read cannot help it', () => {
    expect(
      reason(
        line('canon-chicken', {
          quantity: g(400),
          unit: 'g',
          item: 'chicken carcass',
          statedCount: null,
        }),
      ),
    ).toBe('missing_count');
  });

  it('leaves the legacy count shape alone — it already reads as a count', () => {
    expect(
      reason(line('canon-onion', { quantity: g(1), unit: null, item: 'red onion' })),
    ).toBeNull();
  });

  it('leaves a line whose data prefers metric alone', () => {
    expect(
      reason(line('canon-flour', { quantity: g(200), unit: 'g', item: 'plain flour' })),
    ).toBeNull();
  });

  it('leaves unmatched, unparsed and dangling lines to the other nets', () => {
    expect(reason(line(null, { quantity: g(150), unit: 'g', item: 'red onion' }))).toBeNull();
    expect(reason(line('canon-onion', null))).toBeNull();
    expect(
      reason(line('canon-gone', { quantity: g(150), unit: 'g', item: 'red onion' })),
    ).toBeNull();
  });
});
