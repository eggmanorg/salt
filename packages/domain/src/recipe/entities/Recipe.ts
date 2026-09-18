import type {
  CureCategoryDoc,
  RecipeDoc,
  RecipeKindDoc,
  RecipeMetadataDoc,
  RecipePhaseDoc,
} from '../../schemas/recipe.js';

// The recipe entity graph (issue #179). Schema-first (issue #417): these are
// aliases of the inferred schema types from `@salt/domain/schemas` — `RecipeSchema`
// & co. are the single source of truth, so the entity and the Firestore document
// can no longer drift behind a cast. Only the aliases something imports are kept
// (issue #923); the rest of the document shape is reachable as `*Doc` types.

// Free-form numeric metadata. Every field is `number | null`: null means "not
// recorded", which is a valid authored state, not a missing value.
export type RecipeMetadata = RecipeMetadataDoc;

// One named block of a recipe's timing (issue #1122). Displayed, summed and
// hand-edited; never branched on — see `RecipePhaseSchema`.
export type RecipePhase = RecipePhaseDoc;

// What kind of entry a `recipes/{id}` document is (issue #637). Aliased here so
// the whole recipe surface — including the kind — is reachable from `@salt/domain`
// (Svelte files import from the package root, never from `@salt/domain/schemas`).
// Never switch on this outside the domain: use the capability predicates.
export type RecipeKind = RecipeKindDoc;

// Which of the five kinds of cure a `cure` entry is (issue #1404). Aliased here
// for the same reason as `RecipeKind` above: Svelte files import from the package
// root, never from `@salt/domain/schemas`, and the recipe page's category editor
// needs the type to name the value it writes. Like the kind, it is never switched
// on to decide what something can DO — it picks words and groupings.
export type CureCategory = CureCategoryDoc;

// One Firestore document at `recipes/{id}`. Whole-document last-write-wins on
// `updatedAt` (Firestore-as-master; no tombstones, no revision counter).
export type Recipe = RecipeDoc;
