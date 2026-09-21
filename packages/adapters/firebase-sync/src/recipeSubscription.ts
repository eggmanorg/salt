import { getFirestore, doc, setDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { Recipe } from '@salt/domain';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import { RecipeSchema } from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';

// Recipe persistence (issue #179). One document per recipe at `recipes/{id}`,
// whole-document last-write-wins on `updatedAt`. The list subscription skips and
// logs invalid docs (list-read contract); the single-doc load returns a Failure
// on corruption (single-doc-read contract). See docs/recipe-module.md.

const RECIPES_COLLECTION = 'recipes';

export function subscribeRecipes(
  onRecipes: (recipes: Recipe[]) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [RECIPES_COLLECTION],
      schema: RecipeSchema,
      label: 'RecipeSchema',
      project: (recipe) => recipe,
    },
    onRecipes,
    onError,
  );
}

export async function loadRecipe(id: string): Promise<ReadResult<Recipe | null, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const snap = await getDoc(doc(db, RECIPES_COLLECTION, id));
    if (!snap.exists()) return success(null);
    const result = RecipeSchema.safeParse(snap.data());
    if (!result.success) return failure({ kind: 'StorageError', reason: 'corruption' });
    return success(result.data);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

// Keyed by recipe.id. Whole-document last-write-wins.
export async function saveRecipeDoc(recipe: Recipe): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, RECIPES_COLLECTION, recipe.id), { ...recipe });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function deleteRecipe(id: string): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, RECIPES_COLLECTION, id));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
