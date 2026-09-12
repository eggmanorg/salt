import { get } from 'svelte/store';
import {
  upsertCanonItem,
  setFirestoreNetwork,
  setAiStub,
  saveMealPlanWeek,
  probeFirestoreCache,
} from '@salt/firebase-sync';
import type { CanonItem, MealPlanWeek, Recipe } from '@salt/domain';
import { devSignIn } from './auth.svelte.js';
import { addAislesBulk, aisles } from './aisleService.js';
import { canonItems, isLoadingAisles } from './canonService.js';
import { seedEquipmentManifest, getEquipmentSnapshot } from './equipmentService.js';
import { getRecipesSnapshot, persistRecipe } from './recipeService.js';
import { flushMealPlanWrites, getMealPlanWeekSnapshot } from './mealPlanService.js';
import { getChatSessionsSnapshot } from './chatService.js';
import {
  getShoppingListsSnapshot,
  getDefaultListIdSnapshot,
  getItemsSnapshot,
} from './shoppingListService.svelte.js';
import { tagSession, getSessionURL } from './observability.js';
import type { E2EBridge, SeedCanonItemInput } from './types/e2e.js';

export function installE2EHooks(): void {
  if (import.meta.env.VITE_USE_EMULATORS !== 'true') return;

  const bridge: E2EBridge = {
    devSignIn,

    async seedAisles(names) {
      const result = await addAislesBulk([...names]);
      if (result.kind !== 'ok') {
        throw new Error(`seedAisles failed: ${JSON.stringify(result.error)}`);
      }
      const deadline = Date.now() + 5000;
      while (!names.every((n) => get(aisles).some((a) => a.name === n))) {
        if (Date.now() > deadline) throw new Error(`seedAisles: aisles not in store after 5s`);
        await new Promise((r) => setTimeout(r, 50));
      }
      return result.value;
    },

    async seedCanonItem(input: SeedCanonItemInput) {
      const item: CanonItem = {
        id: input.id ?? crypto.randomUUID(),
        schemaVersion: 5,
        name: input.name,
        synonyms: [...(input.synonyms ?? [])],
        aisleId: input.aisleId ?? null,
        thumbnail: input.thumbnail ?? null,
        embedding: input.embedding ?? null,
        needs_approval: input.needs_approval ?? false,
        shoppingBehavior: 'needed',
        updatedAt: '',
      };
      // Fire-and-forget: setDoc hangs when the SDK network is disabled (offline
      // test). Firestore still writes to local cache and fires onSnapshot
      // immediately, so we wait for the store to reflect the write instead — the
      // wait below IS how this seed answers for the write. Since #931 the
      // discarded promise resolves to a `Failure` rather than rejecting, so
      // dropping it no longer leaves an unhandled rejection behind either.
      void upsertCanonItem(item);
      const deadline = Date.now() + 5000;
      while (!get(canonItems).some((i) => i.id === item.id)) {
        if (Date.now() > deadline)
          throw new Error(`seedCanonItem: item ${item.id} not in store after 5s`);
        await new Promise((r) => setTimeout(r, 50));
      }
      return item;
    },

    getAisles() {
      return get(aisles);
    },

    isCanonSynced() {
      // initCanonSync sets isLoadingAisles=false once both the items and aisles
      // listeners have fired their first snapshot — our "listeners attached and
      // settled" signal for the convergence tests.
      return !get(isLoadingAisles);
    },

    async getCanonItem(id) {
      return get(canonItems).find((i) => i.id === id) ?? null;
    },

    async clearStores() {
      // Firestore persistent cache is managed by the SDK; no local stores to clear.
    },

    async seedEquipmentManifest(manifest) {
      // The bridge's contract with Playwright is an exception, not a Result: a
      // seed that silently never landed would fail the spec later, somewhere
      // unrelated-looking.
      const written = await seedEquipmentManifest(manifest);
      if (written.kind === 'err')
        throw new Error(`seedEquipmentManifest: write refused (${written.error.kind})`);
    },

    getEquipmentManifest() {
      return getEquipmentSnapshot();
    },

    getShoppingLists() {
      return getShoppingListsSnapshot();
    },

    getDefaultListId() {
      return getDefaultListIdSnapshot();
    },

    getShoppingListItems() {
      return getItemsSnapshot();
    },

    getRecipes() {
      return getRecipesSnapshot();
    },

    async seedRecipe(recipe: Recipe) {
      // Goes through the real `persistRecipe` → `@salt/firebase-sync` write path
      // (NF-C4), exactly as the app's own edits do — the only difference is that
      // the fixture is handed over whole instead of being built a field at a
      // time. Specs need recipes NO UI can author: `firstUsedInStepId` is stamped
      // by the AI author flow, and a hand-built recipe leaves it null, so every
      // step renders zero first-use chips. Since #1319 Phase 8 retired
      // hand-authoring altogether this is also the only way a spec gets a recipe
      // at all without driving an import or the chef. `persistRecipe` stamps `updatedAt` and updates the store
      // before it resolves, so an `ok` result means the doc is live.
      const result = await persistRecipe(recipe);
      if (result.kind !== 'ok') {
        throw new Error(`seedRecipe failed: ${JSON.stringify(result.error)}`);
      }
    },

    getMealPlanSnapshot() {
      return getMealPlanWeekSnapshot();
    },

    flushMealPlanWrites() {
      // The planner's own flush (issue #940), not a reimplementation of it — the
      // promise returned here is the one the `setDoc` settles, so awaiting it
      // waits for the emulator's ack rather than for a timer.
      return flushMealPlanWrites();
    },

    async seedMealPlanWeek(week: MealPlanWeek) {
      // The same `saveMealPlanWeek` call `persistWeek` ends in (NF-C4) — the doc
      // arrives by subscription rather than being pushed into the store first,
      // which is what a week written by the other partner's phone looks like.
      const result = await saveMealPlanWeek(week);
      if (result.kind !== 'ok') {
        throw new Error(`seedMealPlanWeek failed: ${JSON.stringify(result.error)}`);
      }
    },

    getChatSessions() {
      return getChatSessionsSnapshot();
    },

    async setFirestoreOffline(offline: boolean) {
      await setFirestoreNetwork(!offline);
    },

    async stubAi(flowName, response) {
      // Register the canned answer the CF fake model returns for `flowName`.
      // Cross-process seam: this writes `_e2e_ai_stubs/{flowName}` to the shared
      // emulator Firestore; the CF fake model (FUNCTIONS_AI_FAKE=1) reads it.
      // See packages/adapters/firebase-sync/src/e2eAiStubSync.ts and
      // apps/cloud-functions/src/ai/fakeModel.ts for the full contract.
      const written = await setAiStub(flowName, response);
      if (written.kind === 'err')
        throw new Error(`stubAi(${flowName}): write refused (${written.error.kind})`);
    },

    async probeFirestoreCache(path) {
      // Reads the Firestore SDK's own local cache for `path` (issue #734).
      // Failure diagnostics only: it answers "did the SDK still have the
      // document the store was missing?". Never throws, never touches the
      // network. See packages/adapters/firebase-sync/src/e2eFirestoreProbe.ts.
      return probeFirestoreCache(path);
    },

    tagSession(meta) {
      tagSession(meta);
    },

    getLDSessionURL() {
      return getSessionURL();
    },
  };

  window.__e2e = bridge;

  if (window.__e2eAutoTag) {
    bridge.tagSession(window.__e2eAutoTag);
  }
}
