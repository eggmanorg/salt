// Presentation for the kinds of `recipes/{id}` entry (issues #637, #652).
//
// This module holds COPY and ICONS only — the words and pictures each kind (and,
// since #752, each list SECTION) wears on screen. It never decides whether a
// section, button or action exists: every capability question goes through
// `takesIngredients` / `isCookable` / `isPlannable` / `takesComponents` in
// `@salt/domain`, so adding a kind still only changes behaviour in one place. What lands here is the part a predicate cannot answer: what to CALL the
// thing, and which shelf it stands on.
//
// It lives beside the recipe routes rather than in `src/lib` on purpose. The
// recipe pages' unit tests hand-roll a full `vi.mock` factory for
// `../src/lib/recipeService.js` listing every export the page imports, so a new
// lib-level import would silently break suites this phase must leave unedited.
//
// The UI label for `special` is "Chef's Specials". Issue #1322 retired the label
// it wore before, and that reword landed here exactly as this comment promised —
// but only half of it was free: the stored value moved from `outing` to `special` in
// the same issue, because the word was also the name of a domain concept and the
// selector for an AI prompt. Copy still moves freely; the enum does not.
import {
  hasComponents,
  takesIngredients,
  PLACEHOLDER_CONDITION_TAGS,
  PLACEHOLDER_MOODS,
} from '@salt/domain';
import { CureCategorySchema } from '@salt/domain/schemas';
import type { CureCategory, Recipe, RecipeKind } from '@salt/domain';
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
// grid of cards needs lives here; everything only a CREATABLE kind needs lives
// on `KindCopy`.
interface SectionCopy {
  // Section name: the filter chip on the list, and the New sheet's own title.
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

// What a CREATABLE KIND additionally needs: the words it wears when it is made
// and the way in from the New menu. A section you cannot create — Meals — has
// none of these, which is exactly why they are not on `SectionCopy`.
//
// It used to carry `newTitle`, `editTitle` and `savedToast` as well; those were
// the retired editor page's heading and its save toast, and they went with it in
// #1319 Phase 8. `createdToast` stayed because a recipe is still CREATED — by
// the New sheet, by an import and by the chef — it is just never "saved" as a
// separate act any more.
interface KindCopy extends SectionCopy {
  // The toast when an entry of this kind first comes into existence.
  readonly createdToast: string;
  // New-menu entry icon.
  readonly menuIcon: IconProps['name'];
  // Help text under the tags field. OPTIONAL, and present on exactly one kind:
  // for a recipe, a special or a cocktail, tags are free-form search keywords and
  // need no explanation. For a placeholder they are load-bearing — `pickPlaceholder`
  // FILTERS on the mood and WEIGHTS on the conditions, so which evenings a picture
  // turns up on is decided entirely by what is typed here, and a typo silently
  // drops the document out of its mood (issue #652, accepted downside). The exact
  // strings are interpolated from the domain constants rather than retyped, so this
  // hint cannot tell you to type a word the picker does not recognise.
  //
  // This is COPY, which is what this module is for — no control, no validation and
  // no write-path change hangs off it. The `kind`-gated mood <Select> that #652
  // rejected was a branch on BEHAVIOUR; a sentence that is simply undefined for
  // three kinds is not. Rendered by `RecipeIdentityCard`'s tag zone, which is
  // where tags are typed since #1319 Phase 8.
  readonly tagsHint?: string;
  // What "start a run of this" is CALLED. A run of a loaf is baked; a run of a
  // coppa is not, and "Bake a batch" on a bresaola is simply wrong words. Not
  // optional, because the two call sites (the recipe page's overflow item and the
  // sheet's own title) must always have something to say and a `??` fallback at
  // each of them is a second place the default can drift from. Every kind but
  // `cure` states the string the app has always shown, byte for byte.
  readonly startBatchLabel: string;
  // The per-kind CATEGORY vocabulary (issue #1404): the words the recipe page's
  // category editor wears, and the display label for each stored value.
  //
  // OPTIONAL, and present on exactly one kind — byte for byte the `tagsHint`
  // pattern above, and for the same reason its header gives. This is COPY: a
  // vocabulary that is simply undefined for four kinds is not a branch on
  // behaviour, and no control, validation or write-path change hangs off it.
  // `RecipeIdentityCard` renders the editor when the kind's copy declares one,
  // which is what keeps `kind === 'cure'` out of every Svelte file in the app.
  //
  // `options` is a Record over the closed enum, so a sixth category fails to
  // compile until it has been given words.
  readonly categoryCopy?: CategoryCopy;
}

// A kind's category vocabulary. Named rather than inlined so `categoryOptions`
// below can take it, and so the identity card can hold one in a `$derived`.
interface CategoryCopy {
  // The zone's label, its dashed empty slot, and the Select's accessible name.
  readonly label: string;
  // The chip's text when nothing has been chosen yet — a normal state, not an
  // error: a cure nobody has categorised is uncategorised, and Salt records
  // rather than polices.
  readonly unsetLabel: string;
  // A RECORD over the closed enum, so a sixth category fails to compile until it
  // has been given words. The ORDER it renders in is the enum's, not this
  // object's — see `categoryOptions`.
  readonly options: Readonly<Record<CureCategory, string>>;
}

// The category options, ready to render, in the stored enum's own order.
//
// Ordered from `CureCategorySchema.options` rather than `Object.entries`, which
// widens the key back to `string` and would push a cast into the markup. This way
// the value is typed by the domain and the Svelte file never names one.
export function categoryOptions(
  copy: CategoryCopy,
): readonly { value: CureCategory; label: string }[] {
  return CureCategorySchema.options.map((value) => ({ value, label: copy.options[value] }));
}

// Narrow a picker's string back to a stored category (`Select` hands back a bare
// `string`). A trust-boundary parse rather than a cast: the options are built from
// the schema, so the only way this sees anything else is a bug — and for a field
// whose whole job is to be corrected, `null` (uncategorised) is a truthful answer
// to one, where a throw would take the page down over a word.
export function toCureCategory(value: string): CureCategory | null {
  const parsed = CureCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const KIND_COPY: Record<RecipeKind, KindCopy> = {
  recipe: {
    label: 'Recipes',
    one: 'recipe',
    many: 'recipes',
    createdToast: 'Recipe created',
    emptyText: 'No recipes yet.',
    noMatchText: 'No recipes match your filters.',
    thumbIcon: 'CookingPot',
    menuIcon: 'Pencil',
    startBatchLabel: 'Bake a batch',
  },
  // Issue #1322. The shelf collects two things at once: the nights nobody cooked
  // (a takeaway, a pub meal, a picnic) and the dishes the chef knows well enough
  // not to write down (the Sunday roast, the all-day breakfast, the cheese
  // sandwich). "Chef's Specials" is true of both and is a joke about the second.
  special: {
    label: "Chef's Specials",
    one: "chef's special",
    many: "chef's specials",
    createdToast: 'Saved',
    emptyText: 'Nothing here yet — a takeaway, a picnic, or the one you know by heart.',
    noMatchText: 'Nothing here matches your filters.',
    thumbIcon: 'HandPlatter',
    menuIcon: 'HandPlatter',
    startBatchLabel: 'Bake a batch',
  },
  cocktail: {
    label: 'Cocktails',
    one: 'cocktail',
    many: 'cocktails',
    createdToast: 'Cocktail created',
    emptyText: 'No cocktails yet.',
    noMatchText: 'No cocktails match your filters.',
    thumbIcon: 'Martini',
    menuIcon: 'Martini',
    startBatchLabel: 'Bake a batch',
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
    createdToast: 'Placeholder created',
    emptyText: 'No placeholders yet — build a few and a note-only night gets a picture.',
    noMatchText: 'No placeholders match your filters.',
    thumbIcon: 'Images',
    menuIcon: 'Images',
    startBatchLabel: 'Bake a batch',
    tagsHint: `Tags decide which evenings this picture turns up on. Mood — exactly one, required: ${PLACEHOLDER_MOODS.join(', ')}. Weather — optional, any number, each one improves the match: ${PLACEHOLDER_CONDITION_TAGS.join(', ')}.`,
  },
  // Issue #1404. "Cured meats" is the shelf a coppa, a bacon and a mortadella
  // share — cured meat is not dinner, and Recipes was the only shelf that could
  // hold one. The label is the proposal and moves freely, as this module's header
  // promises; the stored value is `'cure'` either way.
  cure: {
    label: 'Cured meats',
    one: 'cured meat',
    many: 'cured meats',
    createdToast: 'Cure created',
    emptyText: 'Nothing here yet — import or ask for a coppa, a bacon or a saucisson.',
    noMatchText: 'No cured meats match your filters.',
    thumbIcon: 'Ham',
    menuIcon: 'Ham',
    // Nothing is baked here: a coppa is hung, a bacon is cured then cooked. The
    // one kind whose run is not a bake.
    startBatchLabel: 'Start a batch',
    categoryCopy: {
      label: 'Cure type',
      unsetLabel: 'Cure type not set',
      // The five words the app uses for cured meat, everywhere. Short enough for
      // a chip and a filter row; what each one MEANS — the safety mechanism it is
      // named for — is stated once, at `CureCategorySchema`.
      options: {
        dry_cured_whole_muscle: 'Dry-cured whole muscle',
        cooked_whole_muscle: 'Cured whole muscle (cooked)',
        fermented_dry_cured: 'Fermented & dry-cured (salami)',
        semi_dry: 'Semi-dry / snack meats',
        cooked_emulsified: 'Cooked & emulsified',
      },
    },
  },
};

// ─── Meals: a section that is not a kind (issue #752) ────────────────────────
// A meal — a Sunday roast built from roast chicken, roast potatoes and onion
// gravy — is an ordinary `recipes/{id}` document that has gained
// `componentRecipeIds`. There is no `meal` kind and no meals collection, so this
// sentinel exists ONLY to name a shelf on the list page. It can never appear in
// `RecipeKindSchema`, in a URL segment, or on a stored document.
export const MEAL_SECTION = 'meal';

// A shelf on the recipes list: one of the stored kinds, or Meals.
export type ListSection = RecipeKind | typeof MEAL_SECTION;

// The words each shelf wears. `KIND_COPY` supplies every entry but one
// unchanged — a section that IS a kind talks about itself exactly as it always
// did — and Meals adds the fifth. Note what the extra entry cannot do: it has no
// `createdToast` or `menuIcon`, because a meal is not a kind you stamp on a
// document — a recipe becomes one by gaining components, however it was made.
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

// The KINDS a stored recipe can be, in the order the list page shelves
// them. `recipe` leads because it is where you land and what most entries are.
//
// It is no longer the New menu's list. It stopped being that in #1319 Phase 6,
// which gave the menu its own `NEW_ENTRY_ORDER` below, and the last tie was cut
// in Phase 8 with the editor: you cannot type out a recipe or a cocktail at all
// now, and a meal — which is not a kind — has a New entry that this list, being
// kinds only, could never have carried.
//
// This is deliberately NOT the list page's sections either (see LIST_SECTIONS
// below), which add Meals as a fifth shelf.
export const KIND_SECTIONS: readonly RecipeKind[] = [
  'recipe',
  'special',
  'cocktail',
  'placeholder',
  'cure',
];

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
export type NewEntryMode = 'special' | 'meal' | 'placeholder';

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
  special: {
    kind: 'special',
    // Both labels come from `KIND_COPY` rather than being retyped: the menu and
    // the section must not be able to disagree about what this shelf is called.
    menuLabel: KIND_COPY.special.label,
    sheetTitle: KIND_COPY.special.label,
    namePlaceholder: 'e.g. Curry from the place on the corner',
    menuIcon: KIND_COPY.special.menuIcon,
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

// New-menu order, after the three import entries. Chef's Specials leads because it
// is the one with real production use (eight entries, the newest made on
// 4 September); a placeholder is normally written by the planner rather than here.
export const NEW_ENTRY_ORDER: readonly NewEntryMode[] = ['special', 'meal', 'placeholder'];

// The shelves the list page offers, in chip order. Meals sits second, straight
// after Recipes, because it is a way of browsing dinner rather than an aside.
//
// This array is the whole of a section's existence on the list page: adding an
// entry here gives it a chip and a filtered grid, because every screen below reads
// its words from SECTION_COPY and its behaviour from the domain predicates.
export const LIST_SECTIONS: readonly ListSection[] = [
  'recipe',
  MEAL_SECTION,
  'special',
  'cocktail',
  'placeholder',
  'cure',
];

// The sections whose chips are shown before you ask for the rest. Everything in
// LIST_SECTIONS still exists and is still one tap away — the chip row just leads
// with the sections you actually browse (you cook dinner, you build a roast, you
// make a drink) and folds the rest behind a "+N more" chip, exactly as the tag row
// does. The three it hides are all places you WRITE to more than you read from:
// Chef's Specials is a handful of standing answers, a placeholder is picked for
// you by the planner rather than browsed, and Cured meats (issue #1404) is empty
// until somebody writes a cure — a chip nobody in the household needs yet, on a
// row everybody sees. Membership here is a presentation choice, so it lives beside
// the copy; it never decides whether a section exists, and Cured meats is still
// one tap away behind "+N more" from the day the first coppa is imported.
export const PRIMARY_LIST_SECTIONS: readonly ListSection[] = ['recipe', MEAL_SECTION, 'cocktail'];

// Does this section's grid show an ingredient count on its cards? For a section
// that IS a kind it is the domain's answer, unchanged. For Meals it is unconditionally
// true, and provably so rather than by assertion: every entry in the Meals section
// carries components, only `recipe` and `cocktail` have `takesComponents: true`,
// and both of those have `takesIngredients: true`. A meal's ingredients are its
// OWN — nothing aggregates from its components (issue #752) — so the count on the
// card means what it means everywhere else.
export function sectionTakesIngredients(section: ListSection): boolean {
  return section === MEAL_SECTION ? true : takesIngredients(section);
}
