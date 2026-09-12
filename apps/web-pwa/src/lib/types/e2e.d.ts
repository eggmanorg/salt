import type {
  Aisle,
  CanonItem,
  EquipmentManifest,
  MealPlanWeek,
  Recipe,
  ShoppingList,
  ShoppingListItem,
} from '@salt/domain';
import type { ObservabilitySessionMeta } from '@salt/observability';
import type { E2EFirestoreCacheProbe } from '@salt/firebase-sync';
import type { ChatSessionDoc } from '@salt/domain/schemas';

export interface SeedCanonItemInput {
  readonly id?: string;
  readonly name: string;
  readonly aisleId?: string | null;
  readonly synonyms?: readonly string[];
  readonly thumbnail?: string | null;
  readonly embedding?: readonly number[] | null;
  readonly needs_approval?: boolean;
}

export interface E2EBridge {
  devSignIn(email: string): Promise<void>;
  seedAisles(names: readonly string[]): Promise<readonly Aisle[]>;
  seedCanonItem(input: SeedCanonItemInput): Promise<CanonItem>;
  getAisles(): readonly Aisle[];
  getCanonItem(id: string): Promise<CanonItem | null>;
  // True once the canon sync (items + aisles onSnapshot listeners) has
  // delivered its first snapshot — i.e. the listeners are attached and settled.
  // Cross-tab convergence tests wait on this before the writer tab seeds, so
  // the reader's listener attaches in a calm window rather than mid-navigation.
  isCanonSynced(): boolean;
  clearStores(): Promise<void>;
  setFirestoreOffline(offline: boolean): Promise<void>;
  seedEquipmentManifest(manifest: EquipmentManifest): Promise<void>;
  getEquipmentManifest(): EquipmentManifest | null;
  getShoppingLists(): readonly ShoppingList[];
  getDefaultListId(): string | null | undefined;
  getShoppingListItems(): readonly ShoppingListItem[];
  // Synchronous snapshot of the recipes store. Lets specs assert the parsed /
  // canonical ingredient structure (quantity, unit, item, canonId, matchState)
  // that lives in the store but is only partially surfaced in the DOM.
  getRecipes(): readonly Recipe[];
  // Seeds a whole recipe document through the real `persistRecipe` adapter path
  // (NF-C4). The cook-mode spec needs a recipe no UI can author: the AI author
  // flow is what stamps `firstUsedInStepId` on each ingredient, and a hand-built
  // recipe leaves it null — so a step's first-use chips (the thing the
  // layout assertions measure) never render. Emulator-only, like every other
  // seeder here.
  seedRecipe(recipe: Recipe): Promise<void>;
  // Synchronous snapshot of the current meal-plan week store. Lets the meal
  // planner spec assert per-day config (note, attendees, chefs, guests) and
  // prove the Firestore round-trip across reload.
  getMealPlanSnapshot(): MealPlanWeek;
  // Writes out the planner's debounced edits now, resolving once Firestore has
  // acked them. `getMealPlanSnapshot` above reads the STORE, which the optimistic
  // apply updates synchronously, so it cannot tell a spec whether the write behind
  // it has been issued — and under emulators the client runs without
  // `persistentLocalCache` (`src/lib/firebase.ts`), so an unissued write is not
  // queued anywhere a reload can replay it. A spec that reloads to prove a typed
  // field round-tripped must await this first (issue #1085).
  //
  // Settles writes still inside the debounce window. A write whose window has
  // ALREADY elapsed has left the coalescer and is in flight to the server, and
  // this does not wait for that one — see the caller's note in
  // `e2e/mealplan-split.spec.ts`.
  flushMealPlanWrites(): Promise<void>;
  // Seeds a whole week document through the real `saveMealPlanWeek` adapter path
  // (NF-C4). The planner's layout tests need a week that is already full when the
  // page first mounts — seven days, each with a recipe attached so every row
  // carries a photograph — and building that through the day sheets would be
  // seven dialogs of typing. Emulator-only, like every other seeder here.
  seedMealPlanWeek(week: MealPlanWeek): Promise<void>;
  // Synchronous snapshot of the owner-scoped chat-sessions store (test-infra
  // Phase 5). Chat is the one owner-scoped exception to the family-shared rule:
  // each user's store holds only their own sessions (subscribeChatSessions
  // filters where ownerUid == uid). Lets the chat spec assert owner-scoping —
  // user B's snapshot must be empty of user A's sessions — and the session
  // lifecycle/persistence across reload.
  getChatSessions(): readonly ChatSessionDoc[];
  tagSession(meta: ObservabilitySessionMeta): void;
  getLDSessionURL(): string | null;
  // E2E AI stub seam (test-infra Phase 1). Registers the canned answer the CF
  // fake model returns for a flow. Writes `_e2e_ai_stubs/{flowName}` to the
  // shared emulator Firestore; the CF fake model (FUNCTIONS_AI_FAKE=1) reads it
  // and returns `response` as the model output, so the real callable + flow run
  // unchanged with a deterministic answer. `flowName` is the Genkit flow name
  // (e.g. 'populateEquipmentEntry'); `response` is the structured object the
  // flow's `ai.generate({ output })` should resolve to. Emulator-only.
  stubAi(flowName: string, response: unknown): Promise<void>;
  // Firestore local-cache probe (issue #734). Reads `path` (a full slash-
  // separated document path, e.g. `canonData/aisles`) from the SDK's own cache
  // and reports what it found, so a failure snapshot can say whether the SDK
  // still held a document the store was missing. Pure diagnostics: it resolves
  // rather than throwing — including for the absent-from-cache case — and does
  // no network I/O, so it can never change a test's outcome. Emulator-only.
  probeFirestoreCache(path: string): Promise<E2EFirestoreCacheProbe>;
}

declare global {
  interface Window {
    __e2e?: E2EBridge;
    __e2eAutoTag?: ObservabilitySessionMeta;
  }
}

export {};
