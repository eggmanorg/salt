import { describe, it, expect } from 'vitest';
import { categoryOf, categoryValues, emptyRecipe, withCategory } from '@salt/domain';
import type { RecipeKind } from '@salt/domain';
import { CureCategorySchema, FermentCategorySchema, RecipeKindSchema } from '@salt/domain/schemas';

// Which stored field holds an entry's category (issue #1656) — the one place the
// cure type and the ferment type are read and written by kind.

const NOW = '2026-10-10T00:00:00.000Z';

function entry(kind: RecipeKind) {
  return emptyRecipe('r1', NOW, kind);
}

// A document carrying BOTH fields. The schema cannot forbid one (data-model.md
// rules out a discriminated union), so every read below is asked of the worst
// case: the accessor must answer from the kind's own field and ignore the other.
const BOTH = { cureCategory: 'semi_dry', fermentCategory: 'kimchi' } as const;

describe('categoryOf', () => {
  it('reads a cure its cure type and a ferment its ferment type', () => {
    expect(categoryOf('cure', BOTH)).toBe('semi_dry');
    expect(categoryOf('ferment', BOTH)).toBe('kimchi');
  });

  it('reads nothing for every kind that owns no category, whatever is stored', () => {
    for (const kind of RecipeKindSchema.options) {
      if (kind === 'cure' || kind === 'ferment') continue;
      expect(categoryOf(kind, BOTH)).toBeNull();
    }
  });

  it('reads uncategorised as null', () => {
    expect(categoryOf('ferment', { cureCategory: null, fermentCategory: null })).toBeNull();
  });
});

describe('categoryValues', () => {
  it("lists each kind's own vocabulary in the stored enum's order", () => {
    expect(categoryValues('cure')).toEqual(CureCategorySchema.options);
    expect(categoryValues('ferment')).toEqual(FermentCategorySchema.options);
  });

  it('lists nothing for a kind with no category', () => {
    expect(categoryValues('recipe')).toEqual([]);
    expect(categoryValues('bread')).toEqual([]);
  });

  it('keeps the two vocabularies disjoint, so a value says which one it is', () => {
    // The premise `RecipeCategory` and the shared label table rest on: if a value
    // ever sat in both enums, a label or a filter keyed by value alone would
    // conflate a cure with a ferment.
    const cure: readonly string[] = CureCategorySchema.options;
    expect(FermentCategorySchema.options.filter((value) => cure.includes(value))).toEqual([]);
  });

  it('names exactly the five ferment types, in the order the household reads them', () => {
    expect(FermentCategorySchema.options).toEqual([
      'kraut',
      'kimchi',
      'brined_pickle',
      'hot_sauce',
      'fruit_condiment',
    ]);
  });
});

describe('withCategory', () => {
  it("writes the value to the kind's own field", () => {
    expect(withCategory(entry('ferment'), 'hot_sauce').fermentCategory).toBe('hot_sauce');
    expect(withCategory(entry('cure'), 'cooked_emulsified').cureCategory).toBe('cooked_emulsified');
  });

  it('leaves the other field alone', () => {
    const ferment = { ...entry('ferment'), cureCategory: 'semi_dry' as const };
    expect(withCategory(ferment, 'kraut').cureCategory).toBe('semi_dry');
  });

  it("writes uncategorised for null and for the other vocabulary's word", () => {
    const ferment = { ...entry('ferment'), fermentCategory: 'kimchi' as const };
    expect(withCategory(ferment, null).fermentCategory).toBeNull();
    expect(withCategory(ferment, 'semi_dry').fermentCategory).toBeNull();
    const cure = { ...entry('cure'), cureCategory: 'semi_dry' as const };
    expect(withCategory(cure, 'kimchi').cureCategory).toBeNull();
  });

  it('changes nothing on a kind with no category', () => {
    const recipe = entry('recipe');
    expect(withCategory(recipe, 'kimchi')).toBe(recipe);
  });
});
