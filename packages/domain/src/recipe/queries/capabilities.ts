import type { RecipeKind } from '../entities/Recipe.js';

// What a kind of entry can do (issue #637). These predicates are the ONLY
// place a `RecipeKind` is ever inspected: no call site outside packages/domain
// branches on the kind itself, so adding a fourth kind is a one-file change here
// and every screen inherits the right behaviour.
//
// The table is a `Record<RecipeKind, …>` rather than a chain of comparisons on
// purpose: a new member of the enum fails to compile until it has answered every
// question, instead of silently inheriting whatever `!== 'special'` said.
//
// They take a `RecipeKind`, not a `Recipe`, because the kind is all they need
// and callers do not always hold a whole recipe — the planner picker filters
// candidates from a `Map<string, RecipeKind>` projection. Call sites with a
// recipe in hand pass `recipe.kind`, which reads as well as the alternative.
interface Capabilities {
  // Whether the CONCEPT of ingredients applies: gates the Ingredients section,
  // canonicalisation, and add-to-list. Deliberately distinct from
  // `flattenIngredients(recipe).length > 0` — a half-written recipe has no
  // ingredients yet and must still show the section it is meant to fill in.
  readonly takesIngredients: boolean;
  // Whether there is a method to follow: gates the Cook button, the Method card,
  // and the timings grid. A special has no method written down — whether nobody
  // cooked it or the cook simply knows it by heart, there is nothing to follow.
  readonly isCookable: boolean;
  // Whether the entry is OFFERED in the meal planner's "Add a recipe…" picker.
  // Note what this does and does not say: it gates the picker's candidate list,
  // not what may sit in a day. A cocktail is not dinner and is never offered; a
  // placeholder (issue #652) is not offered either, but does occupy a slot —
  // it is attached on its own when a day is planned in a sentence, never chosen.
  readonly isPlannable: boolean;
  // Whether the LIBRARIAN can produce this kind: gates every path where the AI
  // authors a whole entry — chat → "Save as recipe", ⋮ → "Make a variation"
  // (issue #763), ⋮ → "Refresh" (issue #784), and both imports (issue #765).
  //
  // `cocktail` became `true` in #765, when the librarian learned to say which
  // kind it had written and `assembleRecipeDraft` stopped hardcoding `'recipe'`.
  // That was the whole of the constraint: before it, a cocktail authored from a
  // chat landed in the dinner list permanently, because `kind` is immutable.
  //
  // The two remaining `false`s are "by design", not "not yet": a special is a
  // hand-written meal that needs no recipe card — no ingredients and no method
  // for anyone to author — and a placeholder is a stock photograph and a title.
  // There is nothing for the librarian to write in either case.
  //
  // The `true` rows are also a WIRE CONTRACT, not just a UI gate:
  // `AUTHORABLE_RECIPE_KINDS` below is derived from them and is what bounds the
  // `kind` field the AI flows may emit, so this row is the only place that
  // answers "may the model mint one of these?".
  readonly isAuthorable: boolean;
  // Whether other dishes can be hung off this entry as its components (issue
  // #752): gates the editor's component picker and, with it, whether this entry
  // can ever become a meal. A meal is not a kind — a Sunday roast is an ordinary
  // recipe that happens to point at three others — so this asks the same question
  // `isCookable` asks and answers it separately on purpose: what it gates is a
  // COMPOSITION affordance, not a method to follow. A cocktail is `true` because
  // it can point at its own syrup recipe; a special has no written dish to hang
  // anything off, and a placeholder is a photograph and a title.
  readonly takesComponents: boolean;
}

const CAPABILITIES = {
  recipe: {
    takesIngredients: true,
    isCookable: true,
    isPlannable: true,
    isAuthorable: true,
    takesComponents: true,
  },
  special: {
    takesIngredients: false,
    isCookable: false,
    isPlannable: true,
    isAuthorable: false,
    takesComponents: false,
  },
  cocktail: {
    takesIngredients: true,
    isCookable: true,
    isPlannable: false,
    isAuthorable: true,
    takesComponents: true,
  },
  // A placeholder is a photograph and a title, nothing else: nothing to buy,
  // nothing to cook, never offered in the picker, nothing for the librarian
  // to write, and nothing to build out of other dishes. Every downstream question
  // answers itself from this row.
  placeholder: {
    takesIngredients: false,
    isCookable: false,
    isPlannable: false,
    isAuthorable: false,
    takesComponents: false,
  },
  // `satisfies` rather than an annotation, so the literal `true`/`false` of each
  // cell survives for `AuthorableRecipeKind` below to read. It keeps the whole
  // point of the `Record<RecipeKind, …>`: a new member of the enum still fails to
  // compile here until it has answered all five questions.
} as const satisfies Record<RecipeKind, Capabilities>;

export function takesIngredients(kind: RecipeKind): boolean {
  return CAPABILITIES[kind].takesIngredients;
}

export function isCookable(kind: RecipeKind): boolean {
  return CAPABILITIES[kind].isCookable;
}

export function isPlannable(kind: RecipeKind): boolean {
  return CAPABILITIES[kind].isPlannable;
}

// The set of kinds the librarian may write, READ OFF the table rather than
// restated beside it (issue #765). This is what bounds the `kind` field on
// `LibrarianOutputSchema` / `ExtractRecipeAIOutputSchema`, so the model is never
// offered a kind whose `takesIngredients` is `false` — a special carrying an
// ingredient list is an entry every screen then hides half of.
//
// Derived, so it cannot drift from the rows above.
export type AuthorableRecipeKind = {
  [K in RecipeKind]: (typeof CAPABILITIES)[K]['isAuthorable'] extends true ? K : never;
}[RecipeKind];

// The same set as a VALUE. Zod needs a literal tuple (`z.enum`) and a mapped type
// cannot produce one, so the members are written out — and `satisfies` then pins
// every one of them against the table at compile time. The other direction (a
// fifth kind marked authorable and forgotten here) is not expressible in the type
// system and is pinned by `capabilities.test.ts` instead, which walks
// `RecipeKindSchema.options` and asserts the two agree exactly.
export const AUTHORABLE_RECIPE_KINDS = [
  'recipe',
  'cocktail',
] as const satisfies readonly AuthorableRecipeKind[];

// A type predicate, not a plain boolean, so `AUTHORABLE_RECIPE_KINDS` is
// load-bearing rather than decorative: narrowing a `RecipeKind` to the set the
// AI flows may emit is how the variation path passes its base's kind through
// without the compiler letting a special slip in.
export function isAuthorable(kind: RecipeKind): kind is AuthorableRecipeKind {
  return CAPABILITIES[kind].isAuthorable;
}

export function takesComponents(kind: RecipeKind): boolean {
  return CAPABILITIES[kind].takesComponents;
}
