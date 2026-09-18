import { describe, it, expect } from 'vitest';
import {
  takesIngredients,
  isCookable,
  isPlannable,
  isAuthorable,
  takesComponents,
  AUTHORABLE_RECIPE_KINDS,
} from '@salt/domain';
import type { RecipeKind } from '@salt/domain';
import { RecipeKindSchema } from '@salt/domain/schemas';

// The capability table (issue #637), pinned cell by cell. This is the contract
// every screen inherits: nothing outside packages/domain branches on the kind,
// so if a cell here is wrong the whole app is wrong in the same way.
describe('recipe kind capabilities', () => {
  const table: ReadonlyArray<{
    kind: RecipeKind;
    takesIngredients: boolean;
    isCookable: boolean;
    isPlannable: boolean;
    isAuthorable: boolean;
    takesComponents: boolean;
  }> = [
    {
      kind: 'recipe',
      takesIngredients: true,
      isCookable: true,
      isPlannable: true,
      isAuthorable: true,
      takesComponents: true,
    },
    {
      kind: 'special',
      takesIngredients: false,
      isCookable: false,
      isPlannable: true,
      isAuthorable: false,
      takesComponents: false,
    },
    {
      kind: 'cocktail',
      takesIngredients: true,
      isCookable: true,
      isPlannable: false,
      isAuthorable: true,
      takesComponents: true,
    },
    {
      kind: 'placeholder',
      takesIngredients: false,
      isCookable: false,
      isPlannable: false,
      isAuthorable: false,
      takesComponents: false,
    },
    {
      kind: 'cure',
      takesIngredients: true,
      isCookable: true,
      isPlannable: false,
      isAuthorable: true,
      takesComponents: false,
    },
  ];

  for (const row of table) {
    it(`${row.kind}: ingredients ${row.takesIngredients}, cookable ${row.isCookable}, plannable ${row.isPlannable}, authorable ${row.isAuthorable}, components ${row.takesComponents}`, () => {
      expect(takesIngredients(row.kind)).toBe(row.takesIngredients);
      expect(isCookable(row.kind)).toBe(row.isCookable);
      expect(isPlannable(row.kind)).toBe(row.isPlannable);
      expect(isAuthorable(row.kind)).toBe(row.isAuthorable);
      expect(takesComponents(row.kind)).toBe(row.takesComponents);
    });
  }

  it('a special is the only kind that is eaten rather than made', () => {
    // Named separately from the table because it is the distinction the whole
    // feature exists for: a special fills a planner slot with nothing to buy or do.
    expect(isPlannable('special')).toBe(true);
    expect(takesIngredients('special')).toBe(false);
    expect(isCookable('special')).toBe(false);
  });

  it('the librarian can author a recipe, a cocktail and a cure, and nothing else (#765, #1404)', () => {
    // Named separately because these two `false`s are the ones that MEAN
    // something. The cocktail row was `false` only while `assembleRecipeDraft`
    // hardcoded `kind: 'recipe'` — "not yet", not "by design" — and #765 removed
    // that constraint, so it is `true` now and every consumer inherited it with
    // no edit of its own (⋮ → Make a variation, ⋮ → Refresh, both imports, chat).
    expect(isAuthorable('recipe')).toBe(true);
    expect(isAuthorable('cocktail')).toBe(true);
    // #1404's is the load-bearing one: the recipe editor is gone, so the New
    // sheet, the two imports and the chef are the only ways an entry comes into
    // existence — and the last three are bounded by this column. A `false` here
    // would have shipped a library section nothing could ever put anything on.
    expect(isAuthorable('cure')).toBe(true);
    // These two are false on their own merits and stay false: a special is a
    // hand-written night off with nothing to author, a placeholder is a
    // photograph and a title.
    expect(isAuthorable('special')).toBe(false);
    expect(isAuthorable('placeholder')).toBe(false);
  });

  it('cookable and authorable still COINCIDE on every kind — recorded, not relied on', () => {
    // Stated honestly, because #765 changed it. While the cocktail row was
    // `false` these two columns differed on exactly one kind, and that difference
    // was the evidence they were separate questions. They no longer differ at
    // all, and #1404's `cure` row (cookable and authorable, like `recipe` and
    // `cocktail`) did not reintroduce a difference either.
    //
    // That is a coincidence of today's five kinds, not an identity, and this test
    // exists to make it VISIBLE rather than to lock it: a sixth kind that is
    // cookable but not authorable (or the reverse) turns this red, and the right
    // response is to delete this test, not to merge the two predicates. The gate
    // on ⋮ → Make a variation and ⋮ → Refresh stays `isAuthorable` because the
    // question it asks is "can the librarian WRITE this?", which is what those
    // two menu items depend on however the columns happen to line up.
    for (const kind of RecipeKindSchema.options) {
      expect(isAuthorable(kind)).toBe(isCookable(kind));
    }
    // The pair that has NOT collapsed, and the reason the table has five columns:
    // a special is planned and never cooked, a cocktail is cooked and never
    // planned. No single predicate expresses that.
    expect(isPlannable('special')).toBe(true);
    expect(isCookable('special')).toBe(false);
    expect(isPlannable('cocktail')).toBe(false);
    expect(isCookable('cocktail')).toBe(true);
  });

  // ─── AUTHORABLE_RECIPE_KINDS (issue #765) ──────────────────────────────────
  //
  // The tuple is what bounds the `kind` the AI flows may emit, and it is written
  // out by hand because Zod needs a literal tuple. `satisfies` in capabilities.ts
  // pins ONE direction at compile time — every member listed really is authorable.
  // This is the other direction, which the type system cannot express: an
  // authorable kind that nobody remembered to add to the tuple would silently
  // never be offered to the model, and the flip that was the whole of #765 would
  // have shipped as a no-op.
  describe('AUTHORABLE_RECIPE_KINDS', () => {
    it('is exactly the set of kinds whose isAuthorable is true', () => {
      const fromTable = RecipeKindSchema.options.filter((kind) => isAuthorable(kind));
      expect([...AUTHORABLE_RECIPE_KINDS].sort()).toEqual([...fromTable].sort());
    });

    it('offers the model neither a special nor a placeholder, and does offer a cure', () => {
      // The concrete harm the bound exists to prevent: an entry whose
      // `takesIngredients` is false, carrying an ingredient list and a method the
      // editor and the view page then hide.
      const members: readonly string[] = AUTHORABLE_RECIPE_KINDS;
      expect(members).not.toContain('special');
      expect(members).not.toContain('placeholder');
      // And the one it MUST contain (#1404), for the reason the row states: a
      // cure the model cannot be asked to write is a shelf with no way onto it.
      expect(members).toContain('cure');
      expect(takesIngredients('special')).toBe(false);
      expect(takesIngredients('placeholder')).toBe(false);
    });
  });

  it('a cocktail is made like a recipe but is never dinner', () => {
    expect(takesIngredients('cocktail')).toBe(true);
    expect(isCookable('cocktail')).toBe(true);
    expect(isPlannable('cocktail')).toBe(false);
  });

  it('a cure is made like a recipe, is never dinner, and is never built from others (#1404)', () => {
    // The row read back as the sentence it is: a coppa buys, canonicalises and has
    // a method to follow; it is never offered in the planner picker, which is the
    // whole of "a coppa is not a Tuesday"; and it takes no components, because
    // `sectionOf` shelves anything carrying them under Meals — a cure that gained
    // one would silently leave its own shelf.
    expect(takesIngredients('cure')).toBe(true);
    expect(isCookable('cure')).toBe(true);
    expect(isPlannable('cure')).toBe(false);
    expect(takesComponents('cure')).toBe(false);
  });

  it('a placeholder can do nothing at all — it is a photograph and a title', () => {
    // Named separately because every one of these `false`s is load-bearing
    // somewhere (issue #652): nothing to buy, nothing to cook, and — the one that
    // reads oddly until you know why — never offered in the planner picker, even
    // though it is the only kind that reaches a planner day WITHOUT being picked.
    expect(takesIngredients('placeholder')).toBe(false);
    expect(isCookable('placeholder')).toBe(false);
    expect(isPlannable('placeholder')).toBe(false);
    expect(takesComponents('placeholder')).toBe(false);
  });

  it('the two kinds you can build a meal out of are exactly the two you can make (issue #752)', () => {
    // Named separately because the list page leans on it: every entry in the Meals
    // section is a `recipe` or a `cocktail`, and both of those take ingredients —
    // which is what makes `sectionTakesIngredients(MEAL_SECTION)` unconditionally
    // true rather than a guess. A meal's ingredients are its OWN; nothing is
    // aggregated from its components.
    expect(takesComponents('recipe')).toBe(true);
    expect(takesComponents('cocktail')).toBe(true);
    expect(takesComponents('special')).toBe(false);
    expect(takesComponents('placeholder')).toBe(false);
    for (const kind of ['recipe', 'cocktail'] as const) {
      expect(takesIngredients(kind)).toBe(true);
    }
  });

  it('a cocktail takes components — it can point at its own syrup recipe', () => {
    // The row that reads oddly until you know why: a cocktail is never dinner, but
    // it is a dish you MAKE, and a Negroni built on a house syrup is the same
    // relationship a roast has with its gravy.
    expect(isPlannable('cocktail')).toBe(false);
    expect(takesComponents('cocktail')).toBe(true);
  });
});
