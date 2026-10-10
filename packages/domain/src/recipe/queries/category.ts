import { CureCategorySchema, FermentCategorySchema } from '../../schemas/recipe.js';
import type { CureCategory, FermentCategory, Recipe, RecipeKind } from '../entities/Recipe.js';

// Which stored field holds an entry's category, and which values it may take
// (issue #1656).
//
// Two kinds carry a category today — a cure its `cureCategory`, a ferment its
// `fermentCategory` — and they are sibling fields rather than one generic field
// because `cureCategory` is stored and carries behaviour (`cureSaltFitness`), so
// generalising it would be a migration for nothing anyone sees. Picking the field
// is a comparison on the kind, and CLAUDE.md keeps every such comparison inside
// `packages/domain`, so this module is the ONE place that answers it. The recipe
// page reads and writes through it and never names a field.
//
// The category is IDENTITY AND GROUPING (`CureCategorySchema`'s header): these
// functions say what an entry IS, never what it may do.

/** The stored category fields — on a recipe, and frozen onto a batch. */
export interface CategoryFields {
  readonly cureCategory: CureCategory | null;
  readonly fermentCategory: FermentCategory | null;
}

/**
 * Every category value either vocabulary holds. The two enums share no value, so
 * a value alone says which vocabulary it came from.
 */
export type RecipeCategory = CureCategory | FermentCategory;

// A field paired with ITS OWN enum's values, so the table below cannot hand the
// ferment values to the cure field.
type Vocabulary = {
  [F in keyof CategoryFields]: {
    readonly field: F;
    readonly values: readonly NonNullable<CategoryFields[F]>[];
  };
}[keyof CategoryFields];

// A `Record<RecipeKind, …>`, so a new kind fails to compile until it has said
// whether it carries a category — the capability table's own discipline.
const VOCABULARY = {
  recipe: null,
  special: null,
  cocktail: null,
  placeholder: null,
  cure: { field: 'cureCategory', values: CureCategorySchema.options },
  bread: null,
  ferment: { field: 'fermentCategory', values: FermentCategorySchema.options },
} as const satisfies Record<RecipeKind, Vocabulary | null>;

/**
 * The category an entry of this kind carries, read from the field the kind owns —
 * or `null` when it has none, or the kind has no vocabulary. A value left on a
 * field the kind does not own is never read.
 */
export function categoryOf(kind: RecipeKind, fields: CategoryFields): RecipeCategory | null {
  const vocabulary = VOCABULARY[kind];
  return vocabulary === null ? null : fields[vocabulary.field];
}

/** The values this kind's category may take, in the stored enum's order; empty for none. */
export function categoryValues(kind: RecipeKind): readonly RecipeCategory[] {
  return VOCABULARY[kind]?.values ?? [];
}

/**
 * The entry with its category set — the write shape of the recipe page's category
 * editor. The value lands on the field the entry's kind owns, and only if it is
 * one of that kind's own values: anything else (`null`, or the other vocabulary's
 * word) writes uncategorised. An entry whose kind has no vocabulary comes back
 * unchanged.
 */
export function withCategory(recipe: Recipe, category: RecipeCategory | null): Recipe {
  const vocabulary = VOCABULARY[recipe.kind];
  if (vocabulary === null) return recipe;
  switch (vocabulary.field) {
    case 'cureCategory':
      return {
        ...recipe,
        cureCategory: CureCategorySchema.options.find((value) => value === category) ?? null,
      };
    case 'fermentCategory':
      return {
        ...recipe,
        fermentCategory: FermentCategorySchema.options.find((value) => value === category) ?? null,
      };
  }
}
