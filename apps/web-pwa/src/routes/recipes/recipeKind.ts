// Presentation for the kinds of `recipes/{id}` entry (issues #637, #652).
//
// This module holds COPY and ICONS only — the words and pictures each kind (and,
// since #752, each list SECTION) wears on screen. It never decides whether a
// section, button or action exists: every capability question goes through
// `takesIngredients` / `isCookable` / `isPlannable` / `takesComponents` in
// `@salt/domain`, so adding a fourth kind still only changes behaviour in one
// place. What lands here is the part a predicate cannot answer: what to CALL the
// thing, and which shelf it stands on.
//
// It lives beside the recipe routes rather than in `src/lib` on purpose. The
// recipe pages' unit tests hand-roll a full `vi.mock` factory for
// `../src/lib/recipeService.js` listing every export the page imports, so a new
// lib-level import would silently break suites this phase must leave unedited.
//
// The UI label for `outing` is "When you CBA"; the enum value stays neutral so
// the copy can be reworded later without touching a single stored document.
import {
  hasComponents,
  takesIngredients,
  PLACEHOLDER_CONDITION_TAGS,
  PLACEHOLDER_MOODS,
} from '@salt/domain';
import type { Recipe, RecipeKind } from '@salt/domain';
import type { IconProps } from '@salt/ui-components';

// Read a kind off a recipe-shaped object, defaulting exactly as the schema does.
//
// `RecipeSchema` supplies `.default('recipe')`, so every document that came back
// through `firebase-sync` already carries a kind and this is a pass-through. The
// default is repeated here for the objects that did NOT come through a parse —
// a draft stashed by the URL importer, a partially-built editor draft, a test
// fixture written before #637 — which would otherwise miss the capability table
// entirely and take a screen down over a field that has a well-defined default.
// The parameter is deliberately typed with an optional `kind` so the fallback is
// visibly load-bearing rather than dead code the compiler has already ruled out.
export function kindOf(recipe: { readonly kind?: RecipeKind } | Recipe): RecipeKind {
  return recipe.kind ?? 'recipe';
}

// What a SECTION OF THE LIST needs to say for itself. Split out from `KindCopy`
// below for issue #752: Meals is a section that is not a kind — a meal is an
// ordinary recipe that has gained components — so the list's vocabulary and the
// creatable kinds' vocabulary stopped being the same set of words. Everything a
// grid of cards needs lives here; everything an EDITOR needs lives on `KindCopy`.
interface SectionCopy {
  // Section name: the filter chip on the list, and the suffix on editor titles.
  readonly label: string;
  // Count noun for the result line ("3 recipes", "3 ideas").
  readonly one: string;
  readonly many: string;
  // "This section is empty" — not a failed filter, just nothing added yet.
  readonly emptyText: string;
  // "Your filters excluded everything in this section."
  readonly noMatchText: string;
  // Card thumbnail placeholder when there is no hero image.
  readonly thumbIcon: IconProps['name'];
}

// What a CREATABLE KIND additionally needs: the words the editor wears and the
// way in from the New menu. A section you cannot create — Meals — has none of
// these, which is exactly why they are not on `SectionCopy`.
interface KindCopy extends SectionCopy {
  // Editor page titles. `recipe` keeps today's exact wording — /recipes/new is
  // pinned by an e2e spec and three unit suites that must pass unedited.
  readonly newTitle: string;
  readonly editTitle: string;
  // Toasts on save — first save, then every save after it.
  readonly createdToast: string;
  readonly savedToast: string;
  // New-menu entry icon.
  readonly menuIcon: IconProps['name'];
  // Help text under the tags field. OPTIONAL, and present on exactly one kind:
  // for a recipe, an outing or a cocktail, tags are free-form search keywords and
  // need no explanation. For a placeholder they are load-bearing — `pickPlaceholder`
  // FILTERS on the mood and WEIGHTS on the conditions, so which evenings a picture
  // turns up on is decided entirely by what is typed here, and a typo silently
  // drops the document out of its mood (issue #652, accepted downside). The exact
  // strings are interpolated from the domain constants rather than retyped, so this
  // hint cannot tell you to type a word the picker does not recognise.
  //
  // This is COPY, which is what this module is for — no control, no validation and
  // no write-path change hangs off it. The `kind`-gated mood <Select> that #652
  // rejected was a branch on BEHAVIOUR inside RecipeEditPage; a sentence that is
  // simply undefined for three kinds is not.
  readonly tagsHint?: string;
}

export const KIND_COPY: Record<RecipeKind, KindCopy> = {
  recipe: {
    label: 'Recipes',
    one: 'recipe',
    many: 'recipes',
    newTitle: 'New recipe',
    editTitle: 'Edit recipe',
    createdToast: 'Recipe created',
    savedToast: 'Recipe saved',
    emptyText: 'No recipes yet.',
    noMatchText: 'No recipes match your filters.',
    thumbIcon: 'CookingPot',
    menuIcon: 'Pencil',
  },
  outing: {
    label: 'When you CBA',
    one: 'idea',
    many: 'ideas',
    newTitle: 'New — When you CBA',
    editTitle: 'Edit — When you CBA',
    createdToast: 'Saved',
    savedToast: 'Saved',
    emptyText: 'Nothing here yet — a takeaway, a picnic, or a night off.',
    noMatchText: 'Nothing here matches your filters.',
    thumbIcon: 'HandPlatter',
    menuIcon: 'HandPlatter',
  },
  cocktail: {
    label: 'Cocktails',
    one: 'cocktail',
    many: 'cocktails',
    newTitle: 'New cocktail',
    editTitle: 'Edit cocktail',
    createdToast: 'Cocktail created',
    savedToast: 'Cocktail saved',
    emptyText: 'No cocktails yet.',
    noMatchText: 'No cocktails match your filters.',
    thumbIcon: 'Martini',
    menuIcon: 'Martini',
  },
  // Issue #652. The plural label is what the chip and the New menu say, matching
  // the other three; the singular is only ever a count noun. These entries are
  // read far more often by the person BUILDING the library than by anyone
  // browsing it — a placeholder reaches the planner on its own, never by being
  // picked — so the words are plain rather than coy.
  placeholder: {
    label: 'Placeholders',
    one: 'placeholder',
    many: 'placeholders',
    newTitle: 'New placeholder',
    editTitle: 'Edit placeholder',
    createdToast: 'Placeholder created',
    savedToast: 'Placeholder saved',
    emptyText: 'No placeholders yet — build a few and a note-only night gets a picture.',
    noMatchText: 'No placeholders match your filters.',
    thumbIcon: 'Images',
    menuIcon: 'Images',
    tagsHint: `Tags decide which evenings this picture turns up on. Mood — exactly one, required: ${PLACEHOLDER_MOODS.join(', ')}. Weather — optional, any number, each one improves the match: ${PLACEHOLDER_CONDITION_TAGS.join(', ')}.`,
  },
};

// ─── Meals: a section that is not a kind (issue #752) ────────────────────────
// A meal — a Sunday roast built from roast chicken, roast potatoes and onion
// gravy — is an ordinary `recipes/{id}` document that has gained
// `componentRecipeIds`. There is no `meal` kind and no meals collection, so this
// sentinel exists ONLY to name a shelf on the list page. It can never appear in
// `RecipeKindSchema`, in a URL segment, or on a stored document.
export const MEAL_SECTION = 'meal';

// A shelf on the recipes list: one of the four kinds, or Meals.
export type ListSection = RecipeKind | typeof MEAL_SECTION;

// The words each shelf wears. `KIND_COPY` supplies four of the five entries
// unchanged — a section that IS a kind talks about itself exactly as it always
// did — and Meals adds the fifth. Note what the extra entry cannot do: it has no
// `newTitle`, `savedToast` or `menuIcon`, because you cannot create a meal. You
// create a recipe and then give it components.
export const SECTION_COPY: Record<ListSection, SectionCopy> = {
  ...KIND_COPY,
  [MEAL_SECTION]: {
    label: 'Meals',
    one: 'meal',
    many: 'meals',
    emptyText: 'No meals yet — attach a few recipes to one and it becomes a meal.',
    noMatchText: 'No meals match your filters.',
    thumbIcon: 'Merge',
  },
};

// Which shelf an entry stands on. THE single source of that answer, and the whole
// of "a meal appears under Meals and no longer under Recipes": one entry, one
// membership, so nothing can show up twice or vanish from both.
//
// The direct `hasComponents` question is the sanctioned kind of comparison for
// this module — which section something belongs to is identity and copy, never
// capability. What a meal can DO still comes from the domain predicates, exactly
// as it does for its kind.
export function sectionOf(recipe: Recipe): ListSection {
  return hasComponents(recipe) ? MEAL_SECTION : kindOf(recipe);
}

// The KINDS YOU CAN CREATE, in New-menu order — and, minus the first, the
// New-menu entries themselves. `recipe` leads because it is where you land and
// what most entries are; it is also the only one whose New entry is NOT derived
// from this list, because /recipes/new (no kind segment) is pinned by an e2e spec.
//
// Since #752 this is deliberately NOT the list page's sections (see LIST_SECTIONS
// below): there is no "New meal" entry, because a meal is not created — a recipe
// BECOMES one by gaining components, and offering a way to mint an empty meal
// would be offering a recipe under another name.
export const KIND_SECTIONS: readonly RecipeKind[] = ['recipe', 'outing', 'cocktail', 'placeholder'];

// The creatable kinds whose chips are shown before you ask for the rest. Kept as
// the kind-level list it always was; the list page reads PRIMARY_LIST_SECTIONS.
export const PRIMARY_KIND_SECTIONS: readonly RecipeKind[] = ['recipe', 'cocktail'];

// ─── The New menu's hand-written entries (issue #1319 Phase 6) ────────────────
// What you can still START BY HAND, now that a recipe arrives by URL, by photo or
// by chat and the editor is gone. Three entries, and this list is the whole of
// their existence: the New menu used to derive them from `KIND_SECTIONS.slice(1)`,
// which made "which kinds exist" and "which kinds you type out by hand" the same
// question. They are not. `KIND_SECTIONS` stays exactly what it was — the
// creatable-kinds vocabulary, read by nothing on the New menu any more.
//
// `meal` is on this list and is NOT a kind (see MEAL_SECTION above): its `kind` is
// an ordinary `recipe`, and what makes it a meal is the dish the sheet refuses to
// write it without. So `sectionOf` still derives Meals from `hasComponents` and no
// empty meal can be minted — which is how this honours #752's objection rather
// than overruling it.
export type NewEntryMode = 'outing' | 'meal' | 'placeholder';

interface NewEntryCopy {
  // The kind STORED on the document the sheet writes.
  //
  // THE FIELD-SET BOUNDARY LIVES HERE, NOT ONLY IN RecipeNewSheet.svelte
  // (CLAUDE.md Rule 12 — PR #1340 review, should-fix 6): the sheet asks
  // `takesComponents(entry.kind)` to decide between a dish picker and a
  // description box, and today that partitions these three entries exactly,
  // because only `meal`'s `kind` (`'recipe'`) takes components. This record's
  // type does not enforce that — `kind` is typed as plain `RecipeKind`, so a
  // fourth entry here whose kind ALSO takes components (e.g. `kind: 'cocktail'`)
  // compiles clean and silently produces a sheet that demands a dish and offers
  // no description box, with no test to catch it. Adding such an entry needs its
  // own answer for the description question rather than inheriting this one —
  // read `RecipeNewSheet.svelte`'s header before adding a fourth entry here.
  readonly kind: RecipeKind;
  // The New-menu item, and the sheet's own heading.
  readonly menuLabel: string;
  readonly sheetTitle: string;
  readonly namePlaceholder: string;
  readonly menuIcon: IconProps['name'];
}

// A RECORD, not an array, so the sheet's lookup cannot miss — a `find` over a list
// returns `undefined` for a mode the union already rules out, which is a branch no
// test can reach. The menu's order is the separate list below.
export const NEW_ENTRY_COPY: Record<NewEntryMode, NewEntryCopy> = {
  outing: {
    kind: 'outing',
    // Both labels come from `KIND_COPY` rather than being retyped: the menu and
    // the section must not be able to disagree about what this shelf is called.
    menuLabel: KIND_COPY.outing.label,
    sheetTitle: KIND_COPY.outing.label,
    namePlaceholder: 'e.g. Curry from the place on the corner',
    menuIcon: KIND_COPY.outing.menuIcon,
  },
  meal: {
    // The one entry whose words are its own. `SECTION_COPY[MEAL_SECTION].label`
    // is the plural shelf name ("Meals") and reads wrong in a New menu, where
    // every item names the single thing you are about to make.
    kind: 'recipe',
    menuLabel: 'A meal',
    sheetTitle: 'A meal',
    namePlaceholder: 'e.g. Sunday roast',
    menuIcon: SECTION_COPY[MEAL_SECTION].thumbIcon,
  },
  placeholder: {
    kind: 'placeholder',
    menuLabel: KIND_COPY.placeholder.label,
    sheetTitle: KIND_COPY.placeholder.label,
    namePlaceholder: 'e.g. Something warm and slow',
    menuIcon: KIND_COPY.placeholder.menuIcon,
  },
};

// New-menu order, after the three import entries. "When you CBA" leads because it
// is the one with real production use (eight entries, the newest made on
// 4 September); a placeholder is normally written by the planner rather than here.
export const NEW_ENTRY_ORDER: readonly NewEntryMode[] = ['outing', 'meal', 'placeholder'];

// The shelves the list page offers, in chip order. Meals sits second, straight
// after Recipes, because it is a way of browsing dinner rather than an aside.
//
// This array is the whole of a section's existence on the list page: adding an
// entry here gives it a chip and a filtered grid, because every screen below reads
// its words from SECTION_COPY and its behaviour from the domain predicates.
export const LIST_SECTIONS: readonly ListSection[] = [
  'recipe',
  MEAL_SECTION,
  'outing',
  'cocktail',
  'placeholder',
];

// The sections whose chips are shown before you ask for the rest. Everything in
// LIST_SECTIONS still exists and is still one tap away — the chip row just leads
// with the sections you actually browse (you cook dinner, you build a roast, you
// make a drink) and folds the rest behind a "+N more" chip, exactly as the tag row
// does. The two it hides are both places you WRITE to more than you read from:
// "When you CBA" is a handful of standing answers, and a placeholder is picked for
// you by the planner rather than browsed. Membership here is a presentation
// choice, so it lives beside the copy; it never decides whether a section exists.
export const PRIMARY_LIST_SECTIONS: readonly ListSection[] = ['recipe', MEAL_SECTION, 'cocktail'];

// Does this section's grid show an ingredient count on its cards? For the four
// kinds it is the domain's answer, unchanged. For Meals it is unconditionally
// true, and provably so rather than by assertion: every entry in the Meals section
// carries components, only `recipe` and `cocktail` have `takesComponents: true`,
// and both of those have `takesIngredients: true`. A meal's ingredients are its
// OWN — nothing aggregates from its components (issue #752) — so the count on the
// card means what it means everywhere else.
export function sectionTakesIngredients(section: ListSection): boolean {
  return section === MEAL_SECTION ? true : takesIngredients(section);
}
