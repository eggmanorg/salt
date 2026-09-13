import type { Recipe, RecipeKind } from '../entities/Recipe.js';
import type { Ingredient, IngredientGroup } from '../entities/Ingredient.js';
import type { Step } from '../entities/Step.js';

// Pure constructors for the recipe entity graph. They establish the invariants —
// `rawText` preserved, `parsed`/`canonId` null until later phases, `matchState`
// 'pending', `schemaVersion` 1 — so callers (the service, tests) never hand-roll
// a partial entity. `updatedAt` is left blank until the service stamps it on save.

// A blank recipe: no ingredients, no steps, empty metadata. `kind` defaults to
// 'recipe' (issue #637) so every existing caller is untouched; a special or a
// cocktail is built by passing it.
export function emptyRecipe(id: string, now: string, kind: RecipeKind = 'recipe'): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind,
    title: '',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      // No timing yet (issue #1122). An empty list rather than the absent key a
      // pre-#1122 document carries: this constructor is the WRITE side, and a
      // recipe built here has genuinely been asked and has no phases, which is a
      // different statement from "written before phases existed".
      phases: [],
      timingSummary: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    // No kit yet, and no `kitInferredAt` either (issue #882): a blank recipe has
    // no method to read, so the onRecipeWritten kit branch simply finds nothing to
    // work from and asks again on the save that gives it steps.
    kit: [],
    image: null,
    createdAt: now,
    updatedAt: '',
    // Blank until the service stamps them on save, exactly as `updatedAt` is:
    // `packages/domain` reads no clock and knows no user, so attribution (#845)
    // is the service layer's to fill in, not this constructor's.
    createdBy: '',
    lastEditedBy: '',
  };
}

// A copy of an existing entry, ready to be edited and saved as a NEW document
// (issue #735). This function is the single home of the what-carries policy —
// no field-reset logic belongs in the UI. Like `emptyRecipe` it mints nothing and
// reads no clock: the caller passes `newId` (`crypto.randomUUID()`) and `now`.
//
// Carried verbatim, value-cloned so the copy never aliases the original's nested
// objects: `kind` (immutable — you cannot turn a takeaway into a recipe by
// copying it), `description`, the whole ingredient tree, the steps, `metadata`,
// `source`, `notes`, and `needs_approval` — that flag means "AI-authored, not yet
// read by a human", and copying something is not reading it.
//
// `componentRecipeIds` carries too (issue #752), value-cloned like
// `metadata.tags`: a copy of a Sunday roast is still a Sunday roast, so it is
// still built from roast chicken, roast potatoes and onion gravy. The components
// themselves are separate documents and are NOT duplicated — the copy points at
// the same three dishes, which is the whole reason a meal stores ids rather than
// dishes. It is not the `producesCanonId` case: two copies of a roast pointing at
// the same gravy is simply true, whereas two recipes claiming to produce the same
// grocery item is a contradiction.
//
// Ingredient / group / step ids are deliberately NOT re-minted. They are
// document-local, and `Ingredient.firstUsedInStepId` points at a step id inside
// the SAME document, so copying verbatim preserves every ingredient→step link for
// free; re-minting would need a remap table and buys no property. `parsed` /
// `canonId` / `matchState` ride along for the same reason: `rawText` is identical,
// so the existing resolutions are still correct and the copy costs no
// canonicalisation round-trip.
//
// Reset: `producesCanonId` → null. Two recipes both claiming to produce Chicken
// Stock would both surface from `findProducingRecipes`, so the copy starts
// unclaimed and the buy-or-make link is re-set deliberately if the variant really
// is the new producer.
//
// Dropped entirely: `image` and every hero-image control field (`imageBrief`,
// `imageHint`, `imageRequestedAt`, `imageHidden`). See docs/recipe-module.md
// § "Duplicating a recipe" — carrying `image` would point the copy at the
// ORIGINAL's Storage object, which the doc-id-keyed orphan sweep deletes once the
// original is gone; and a carried `imageBrief` is used verbatim by the
// onRecipeWritten trigger, so it would art-direct the copy as the dish it is no
// longer. With all of them absent the copy gets its own hero, generated from what
// was actually saved.
//
// Attribution (#845) is dropped too, and for a policy reason rather than a
// mechanical one: a copy belongs to whoever copied it, so the source's creator is
// deliberately NOT carried. Both fields go out blank and the service stamps the
// copier on save, exactly as `updatedAt` works — this constructor knows no user.
export function duplicateRecipe(source: Recipe, newId: string, now: string): Recipe {
  return {
    id: newId,
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    title: `${source.title} (copy)`,
    description: source.description,
    ingredients: source.ingredients.map((group) => ({
      ...group,
      items: group.items.map((item) => ({
        ...item,
        parsed:
          item.parsed === null
            ? null
            : {
                ...item.parsed,
                quantity: item.parsed.quantity === null ? null : { ...item.parsed.quantity },
                preparation: [...item.parsed.preparation],
              },
      })),
    })),
    steps: source.steps.map((step) => ({
      ...step,
      timer: step.timer === null ? null : { ...step.timer },
    })),
    metadata: { ...source.metadata, tags: [...source.metadata.tags] },
    source:
      source.source === null
        ? null
        : {
            ...source.source,
            ...(source.source.book === undefined ? {} : { book: { ...source.source.book } }),
          },
    notes: source.notes,
    // Spread-or-omit, not `needs_approval: source.needs_approval`: the field is
    // `.optional()`, so an absent flag must stay absent rather than become an
    // explicit `undefined` on the document.
    ...(source.needs_approval === undefined ? {} : { needs_approval: source.needs_approval }),
    producesCanonId: null,
    componentRecipeIds: [...source.componentRecipeIds],
    // Kit carries (issue #882), value-cloned like `componentRecipeIds` — and it is
    // the `componentRecipeIds` case, not the `imageBrief` one. A brief was dropped
    // because it art-directs the copy as the dish it is no longer; nothing about
    // copying a recipe changes which pans it needs. Crucially the STEP IDS are not
    // re-minted (see the note above), so every `stepIds` reference is still a step
    // in this document — the same property that preserves `firstUsedInStepId`.
    kit: source.kit.map((entry) => ({ ...entry, stepIds: [...entry.stepIds] })),
    // `kitInferredAt` carries with it, so the copy does not pay for an inference
    // that could only produce the answer already sitting above. Spread-or-omit
    // because the field is `.optional()`: a source that was never inferred must
    // leave the copy un-stamped so the trigger picks it up.
    ...(source.kitInferredAt === undefined ? {} : { kitInferredAt: source.kitInferredAt }),
    image: null,
    createdAt: now,
    // Blank until `persistRecipe` stamps it on save, exactly as `emptyRecipe` leaves it.
    updatedAt: '',
    // Blank for the same reason, and see the what-carries note above: the copy is
    // NOT credited to the original's creator.
    createdBy: '',
    lastEditedBy: '',
  };
}

// An empty ingredient group. `name` null is the default/unnamed group.
export function emptyIngredientGroup(id: string, name: string | null = null): IngredientGroup {
  return { id, name, items: [] };
}

// A fresh ingredient from a raw line. Unparsed and unmatched until later phases;
// `rawText` is the sacred original.
export function newIngredient(id: string, rawText: string, isOptional = false): Ingredient {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'pending',
    isOptional,
    firstUsedInStepId: null,
  };
}

// A fresh step with no timer and no note.
export function newStep(id: string, text: string): Step {
  return { id, text, timer: null, note: null };
}
