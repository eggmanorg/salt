/// <reference path="../../src/lib/types/e2e.d.ts" />
import type { Page } from '@playwright/test';
import type {
  Aisle,
  CanonItem,
  MealPlanWeek,
  Recipe,
  ShoppingList,
  ShoppingListItem,
  Weekday,
} from '@salt/domain';
import type { GuidedPlanDoc } from '@salt/domain/schemas';
import { FIRESTORE_DOCUMENTS_BASE_URL } from './emulator';

export interface SeedCanonItemInput {
  readonly id?: string;
  readonly name: string;
  readonly aisleId?: string | null;
  readonly synonyms?: readonly string[];
  readonly thumbnail?: string | null;
  readonly embedding?: readonly number[] | null;
  readonly needs_approval?: boolean;
}

export async function seedAisles(page: Page, names: readonly string[]): Promise<readonly Aisle[]> {
  return page.evaluate((ns) => window.__e2e!.seedAisles(ns), names);
}

export async function seedCanonItem(page: Page, input: SeedCanonItemInput): Promise<CanonItem> {
  return page.evaluate((i) => window.__e2e!.seedCanonItem(i), input);
}

// Writes a whole recipe document through the real `persistRecipe` path (NF-C4).
// The recipe editor is the right seam for specs about authoring; this one is for
// specs that need a recipe shaped in ways the editor cannot produce — notably
// `firstUsedInStepId`, stamped by the AI author flow and left null by the UI, so
// a UI-authored recipe shows no per-step first-use ingredients at all.
export async function seedRecipe(page: Page, recipe: Recipe): Promise<void> {
  await page.evaluate((r) => window.__e2e!.seedRecipe(r), recipe);
}

// Writes a whole week document through the real `saveMealPlanWeek` path (NF-C4).
// The day sheet is the right seam for specs about editing a day; this one is for
// specs that need a week already FULL when the page first mounts — seven days,
// each with its recipe attached — which through the sheets would be seven dialogs
// of typing before the thing under test even starts.
export async function seedMealPlanWeek(page: Page, week: MealPlanWeek): Promise<void> {
  await page.evaluate((w) => window.__e2e!.seedMealPlanWeek(w), week);
}

// Which day starts the week — written straight into the emulator, BEFORE the app
// boots, rather than through the bridge.
//
// Not a shortcut, and the one place in this file that goes around the adapter on
// purpose. `firstDayOfWeek` is pre-existing household setup, not an action under
// test: it decides which seven days "this week" means, and nothing in the planner
// re-reads it, so a spec that writes it into a running app is betting the whole
// run on one `onSnapshot` update. That bet loses often enough to matter — the
// emulator's forced long-polling transport drops updates delivered while other
// listeners are attaching (the same hazard `waitForCanonReady` exists for) — and
// when it loses, the page spends the test on a different week and every geometry
// assertion is measuring the wrong thing. A listener's FIRST snapshot is not
// subject to that, so the doc is put in place before there is a listener at all,
// exactly as `seedMemberAllowlist` seeds the allowlist before sign-in.
export async function seedFirstDayOfWeek(day: Weekday): Promise<void> {
  const url = `${FIRESTORE_DOCUMENTS_BASE_URL}/mealPlanConfig/singleton`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        firstDayOfWeek: { stringValue: day },
        schemaVersion: { integerValue: '1' },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`seedFirstDayOfWeek failed: HTTP ${res.status} ${await res.text()}`);
  }
}

// The aisle list — written straight into the emulator, BEFORE the app boots,
// rather than through the bridge `seedAisles` above.
//
// Same drop hazard as `seedFirstDayOfWeek`, only this one is measured. Aisles
// live in ONE document (`canonData/aisles`), and the app attaches its
// `onSnapshot` for that document at boot, with the doc absent. A bridge write
// afterwards is a post-attach update, and the e2e build's
// `experimentalForceLongPolling` + `persistentLocalCache` transport drops those
// intermittently: latency compensation shows the aisle for a moment, then the
// store settles permanently empty. 35 of 35 recorded CI failures across the two
// aisle-seeding specs carry `ctx_aisles_count: 0` alongside
// `ctx_canon_synced: true` — the listener was healthy, the update simply never
// landed. A listener's FIRST snapshot is not subject to that, so the document is
// put in place before there is a listener at all.
//
// The bridge `seedAisles` stays, and stays correct, for specs where the live
// write itself is the subject under test (cross-tab convergence in
// canon-sync.spec.ts) — there the post-attach update IS the assertion.
export async function seedAislesBeforeBoot(names: readonly string[]): Promise<readonly Aisle[]> {
  const aisles: Aisle[] = names.map((name, order) => ({
    id: crypto.randomUUID(),
    name,
    order,
  }));
  const url = `${FIRESTORE_DOCUMENTS_BASE_URL}/canonData/aisles`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        schemaVersion: { integerValue: '1' },
        updatedAt: { stringValue: new Date().toISOString() },
        aisles: {
          arrayValue: {
            values: aisles.map((aisle) => ({
              mapValue: {
                fields: {
                  id: { stringValue: aisle.id },
                  name: { stringValue: aisle.name },
                  order: { integerValue: String(aisle.order) },
                },
              },
            })),
          },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`seedAislesBeforeBoot failed: HTTP ${res.status} ${await res.text()}`);
  }
  return aisles;
}

// A shopping list that is ALREADY the default — both documents written straight
// into the emulator, BEFORE the app boots, rather than created through the UI.
//
// Same drop hazard as `seedAislesBeforeBoot`, and equally measured. What makes a
// list the default lives in ONE document (`shoppingListsConfig/singleton`), and
// the app attaches its `onSnapshot` for that document at boot, with the doc
// absent — nothing writes it until the user creates their first list, which is
// necessarily afterwards. That post-attach update is what the e2e build's
// `experimentalForceLongPolling` + `persistentLocalCache` transport drops, and
// when it goes it is gone rather than late: every recorded CI failure of the
// three specs that bootstrapped a list this way carries
// `ctx_shopping_lists_count: 1` alongside `ctx_has_default_list: false` — the
// list document arrived, the config never did. Downstream, `defaultListId`
// stays null, so `openAddToList` toasts and returns, `/#/shopping` redirects to
// `/#/shopping/new`, and no list is *the* default for the delete-button rule.
// A listener's FIRST snapshot is not subject to that, so both documents are put
// in place before there is a listener at all.
//
// Creating a list through the UI is still covered where it is the subject under
// test — `shopping-list-multi-list.spec.ts` and `shopping-list-happy-path.spec.ts`.
export async function seedShoppingListBeforeBoot(name: string): Promise<ShoppingList> {
  const now = new Date().toISOString();
  const list: ShoppingList = {
    id: crypto.randomUUID(),
    name,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };

  const listRes = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/shoppingLists/${list.id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        id: { stringValue: list.id },
        name: { stringValue: list.name },
        schemaVersion: { integerValue: '1' },
        createdAt: { stringValue: list.createdAt },
        updatedAt: { stringValue: list.updatedAt },
      },
    }),
  });
  if (!listRes.ok) {
    throw new Error(
      `seedShoppingListBeforeBoot failed (list): HTTP ${listRes.status} ${await listRes.text()}`,
    );
  }

  const configRes = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/shoppingListsConfig/singleton`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        defaultListId: { stringValue: list.id },
        schemaVersion: { integerValue: '1' },
      },
    }),
  });
  if (!configRes.ok) {
    throw new Error(
      `seedShoppingListBeforeBoot failed (config): HTTP ${configRes.status} ${await configRes.text()}`,
    );
  }

  return list;
}

// A guided plan (issue #751) — written straight into the emulator BEFORE the
// recipe view is opened, rather than through the bridge or the AI flow.
//
// There is no bridge writer to use. `guidedPlans` has exactly two writers in the
// app — the plan editor and the generateGuidedPlan flow — and neither is a seam a
// spec about COOKING should go through: the editor would be several screens of
// typing before the thing under test starts, and the flow is a live model call
// (NF-E4). `guidedPlans` is greenfield (see the header of
// `packages/domain/src/schemas/guidedPlan.ts`), so the document shape is settled
// by the schema alone and writing it directly costs no back-compat reasoning.
//
// And the ordering is the same drop hazard the four seeds above exist for. A plan
// lives in ONE document at `guidedPlans/{recipeId}` and there is no all-plans
// subscription anywhere in the app: `RecipeViewPage` attaches its `onSnapshot` for
// this one document when it mounts, and the split Cook control's guided half is
// rendered on what that listener reports. Written afterwards, that is a
// post-attach update, and the e2e build's `experimentalForceLongPolling` +
// `persistentLocalCache` transport drops those intermittently — with the button
// then absent for the rest of the run and the spec failing on a missing locator
// rather than on anything it means to assert. A listener's FIRST snapshot is not
// subject to that, so the document is put in place before there is a listener.
//
// Not a fifth back door in the NF-C4 sense as much as the same one again: like
// `seedFirstDayOfWeek` it takes no `Page`, and that is what keeps the ordering
// honest — there is nothing here to call once the app is looking at the recipe.
export async function seedGuidedPlan(plan: GuidedPlanDoc): Promise<void> {
  const url = `${FIRESTORE_DOCUMENTS_BASE_URL}/guidedPlans/${plan.id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(plan) }),
  });
  if (!res.ok) {
    throw new Error(`seedGuidedPlan failed: HTTP ${res.status} ${await res.text()}`);
  }
}

// Any document, written straight into the emulator BEFORE the app boots
// (issue #1685) — for household setup a spec needs in place when the first
// listener attaches, for the same post-attach drop hazard as the seeds above:
// the freezer setup and its stock, and shopping rows already matched to a canon
// (which the canonicalisation trigger leaves alone: it acts only on `pending`).
export async function seedDocumentBeforeBoot(path: string, document: object): Promise<void> {
  const res = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(document) }),
  });
  if (!res.ok) {
    throw new Error(
      `seedDocumentBeforeBoot(${path}) failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}

// The REST document encoding, derived from the value rather than hand-written per
// field. The seeds above spell theirs out because each is three or four flat
// fields; a plan is two arrays of maps, one of which contains a third, and forty
// lines of nested `mapValue`/`arrayValue` literals would be a second, silent copy
// of `GuidedPlanSchema` — one that goes stale the moment a field is added and
// fails as an unexplained parse miss rather than as a type error.
function toFirestoreFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      // An `.optional()` field left unset (`needs_approval`) must stay absent
      // rather than be written as null — absent means reviewed.
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => [key, toFirestoreValue(v)]),
  );
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  return { mapValue: { fields: toFirestoreFields(value as object) } };
}

export async function getAisles(page: Page): Promise<readonly Aisle[]> {
  return page.evaluate(() => window.__e2e!.getAisles());
}

export async function getCanonItem(page: Page, id: string): Promise<CanonItem | null> {
  return page.evaluate((i) => window.__e2e!.getCanonItem(i), id);
}

// Wait until a tab's canon sync has attached and delivered its first snapshot.
// Cross-tab convergence tests call this on the reader tab before the writer
// seeds: it ensures the reader's onSnapshot listeners settle in a calm window
// rather than mid-navigation, where the emulator's forced long-polling
// transport can drop the update (residual flake, #199).
export async function waitForCanonReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__e2e?.isCanonSynced() === true, null, {
    timeout: 15_000,
  });
}

export async function clearAllStores(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e!.clearStores());
}

// Snapshot of the active shopping list's items straight from the store —
// the observable post-trigger state (canonId, matchState, rawText, amount,
// unit, notes). Used to assert the onShoppingListItemWrite trigger's rewrite
// deterministically, without racing the DOM.
export async function getShoppingListItems(page: Page): Promise<readonly ShoppingListItem[]> {
  return page.evaluate(() => window.__e2e!.getShoppingListItems());
}
