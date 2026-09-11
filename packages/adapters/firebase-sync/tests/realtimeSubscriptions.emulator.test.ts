/**
 * Firestore emulator integration tests for real-time subscription primitives.
 *
 * Proves that a write on one client (named "writer" app) lands in another
 * client's (default app) subscription callback within the convergence window.
 *
 * Requires the isolated Vitest emulator stack (issue #84 Phase 3); ports come
 * from this package's .env.test via import.meta.env, with the dev emulator
 * (8080/9099) as the ad-hoc fallback.
 * Run via: pnpm test:emulator
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp, getApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { subscribeCanonItems, upsertCanonItem, deleteCanonItem } from '../src/canonSubscription.js';
import { subscribeAisles, saveAisles } from '../src/aisleSubscription.js';
import {
  subscribeEquipmentManifest,
  saveEquipmentManifest,
} from '../src/equipmentManifestSubscription.js';
import { subscribeShoppingLists, createShoppingList } from '../src/shoppingListSubscription.js';
import {
  subscribeShoppingListItems,
  saveShoppingListItem,
} from '../src/shoppingListItemSubscription.js';
import {
  subscribeShoppingListsConfig,
  saveShoppingListsConfig,
} from '../src/shoppingListsConfigSubscription.js';
import {
  subscribeCookSession,
  saveCookSession,
  deleteCookSession,
} from '../src/cookSessionSubscription.js';
import {
  subscribeShoppingDaysInRange,
  saveShoppingDay,
  deleteShoppingDay,
} from '../src/shoppingDaySync.js';
import { clearFirestoreEmulator, resetDefaultApp, PROJECT_ID } from './emulatorHelpers.js';
import type {
  CanonItem,
  Aisle,
  EquipmentManifest,
  EquipmentItem,
  ShoppingList,
  ShoppingListItem,
  ShoppingListsConfig,
} from '@salt/domain';
import type { CookSessionDoc, ShoppingDayDoc } from '@salt/domain/schemas';

// Cross-client onSnapshot propagation tolerance. Generous to absorb cold-start
// latency on CI's Dockerized emulator (the first subscription in each block and
// the server-confirmed-empty delivery can take several seconds there). waitFor
// polls and resolves the instant data converges, so this only raises the
// failure ceiling — warm local runs stay sub-second. Kept below the Vitest
// testTimeout in vitest.emulator.config.ts so waitFor surfaces its own clearer
// error rather than being pre-empted by Vitest's per-test timeout.
const CONVERGENCE_MS = 15_000;

// The "writer" app connects to the emulator directly (it does not go through
// init.ts), so resolve the isolated Vitest stack ports from the same source
// init.ts/auth.ts/emulatorHelpers.ts use — .env.test → import.meta.env — so
// the writer and the default app always hit the same emulator (issue #84
// Phase 3). Dev ports stay as the ad-hoc fallback.
const _env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const WRITER_FIRESTORE_PORT = Number(_env['VITE_EMULATOR_FIRESTORE_PORT'] ?? 8080);
const WRITER_AUTH_PORT = _env['VITE_EMULATOR_AUTH_PORT'] ?? '9099';
const WRITER_APP_NAME = 'rt-writer';

let writerApp: FirebaseApp;
let writerDb: Firestore;

function makeItem(id: string, name = 'Test'): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

function makeAisle(id: string, name: string): Aisle {
  return { id, name, order: 0 };
}

// Both apps are re-created per test (not once in beforeAll) so a Listen channel
// poisoned by a prior test's emulator gRPC corruption cannot bleed into the next
// — that cross-test connection-state bleed is what turned a single transient
// hiccup into a hard `subscribeAisles` convergence timeout (#319). resetDefaultApp
// rebuilds the default app the subscribe* functions read through; createWriterApp
// rebuilds the cross-client "writer" app.
async function createWriterApp(): Promise<void> {
  const stale = getApps().find((app) => app.name === WRITER_APP_NAME);
  if (stale) {
    await deleteApp(stale);
  }
  writerApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, WRITER_APP_NAME);
  // Force long-polling for the same reason as the default app (see init.ts): the
  // emulator's gRPC streaming transport intermittently corrupts the Listen
  // channel and poisons the writer's connection. (#122)
  writerDb = initializeFirestore(writerApp, { experimentalForceLongPolling: true });
  connectFirestoreEmulator(writerDb, '127.0.0.1', WRITER_FIRESTORE_PORT);
  const writerAuth = getAuth(writerApp);
  connectAuthEmulator(writerAuth, `http://127.0.0.1:${WRITER_AUTH_PORT}`, {
    disableWarnings: true,
  });
  await signInAnonymously(writerAuth);
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  await resetDefaultApp();
  await createWriterApp();
});

afterEach(async () => {
  await deleteApp(writerApp);
});

describe('realtimeSubscriptions — Firestore emulator', () => {
  describe('subscribeCanonItems', () => {
    it('delivers a cross-client write within the convergence window', async () => {
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      await setDoc(doc(writerDb, 'canonItems', 'carrot'), makeItem('carrot', 'Carrot'));

      await waitFor(
        () => received.some((items) => items.some((i) => i.id === 'carrot')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((items) => items.some((i) => i.id === 'carrot'))).toBe(true);
    });

    it('delivers items written via upsertCanonItem', async () => {
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      await upsertCanonItem(makeItem('onion', 'Onion'));

      await waitFor(
        () => received.some((items) => items.some((i) => i.id === 'onion')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((items) => items.some((i) => i.id === 'onion'))).toBe(true);
    });

    it('deleteCanonItem removes the doc and the deletion converges via onSnapshot', async () => {
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      await upsertCanonItem(makeItem('garlic', 'Garlic'));
      await waitFor(
        () => received.some((items) => items.some((i) => i.id === 'garlic')),
        CONVERGENCE_MS,
      );

      const result = await deleteCanonItem('garlic');
      expect(result.kind).toBe('ok');

      await waitFor(
        () => received.some((items) => !items.some((i) => i.id === 'garlic')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      const last = received[received.length - 1]!;
      expect(last.some((i) => i.id === 'garlic')).toBe(false);
    });

    it('returns the unsubscribe function that stops callbacks', async () => {
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      // Wait for initial snapshot to settle
      await waitFor(() => received.length > 0, CONVERGENCE_MS);
      const countBeforeUnsub = received.length;
      unsubscribe();

      // Write after unsubscribe — callback must not fire
      await setDoc(doc(writerDb, 'canonItems', 'after'), makeItem('after', 'After'));
      await delay(500);

      expect(received.length).toBe(countBeforeUnsub);
    });
  });

  describe('subscribeAisles', () => {
    it('delivers a cross-client write within the convergence window', async () => {
      const received: Aisle[][] = [];
      const unsubscribe = subscribeAisles(
        (aisles) => received.push(aisles),
        () => {},
      );

      await setDoc(doc(writerDb, 'canonData', 'aisles'), {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        aisles: [{ id: 'produce', name: 'Produce', order: 0 }],
      });

      await waitFor(
        () => received.some((aisles) => aisles.some((a) => a.id === 'produce')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((aisles) => aisles.some((a) => a.id === 'produce'))).toBe(true);
    });

    it('delivers aisles written via saveAisles', async () => {
      const received: Aisle[][] = [];
      const unsubscribe = subscribeAisles(
        (aisles) => received.push(aisles),
        () => {},
      );

      await saveAisles([makeAisle('meat', 'Meat & Seafood')]);

      await waitFor(
        () => received.some((aisles) => aisles.some((a) => a.id === 'meat')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((aisles) => aisles.some((a) => a.id === 'meat'))).toBe(true);
    });

    it('delivers empty array when document does not exist', async () => {
      const received: Aisle[][] = [];
      const unsubscribe = subscribeAisles(
        (aisles) => received.push(aisles),
        () => {},
      );

      // Firestore may deliver a stale cache snapshot first; wait for the
      // server-confirmed empty delivery.
      await waitFor(() => received.some((r) => r.length === 0), CONVERGENCE_MS);

      unsubscribe();
      expect(received.some((r) => r.length === 0)).toBe(true);
    });
  });

  describe('subscribeEquipmentManifest', () => {
    it('delivers null when document does not exist', async () => {
      const received: (EquipmentManifest | null)[] = [];
      const unsubscribe = subscribeEquipmentManifest(
        (m) => received.push(m),
        () => {},
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);

      unsubscribe();
      expect(received.some((r) => r === null)).toBe(true);
    });

    it('delivers manifest written via saveEquipmentManifest', async () => {
      const received: (EquipmentManifest | null)[] = [];
      const unsubscribe = subscribeEquipmentManifest(
        (m) => received.push(m),
        () => {},
      );

      const item: EquipmentItem = {
        id: 'mixer-1',
        schemaVersion: 1,
        name: 'Stand Mixer',
        accessories: [{ id: 'acc-1', name: 'Dough Hook', owned: true, included: true }],
        rules: ['Use speed 2 for bread'],
        environment: null,
        updatedAt: new Date().toISOString(),
      };
      await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [item] });

      await waitFor(
        () => received.some((m) => m !== null && m.items.some((i) => i.id === 'mixer-1')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((m) => m !== null && m.items.some((i) => i.id === 'mixer-1'))).toBe(
        true,
      );
    });

    it('stops callbacks after unsubscribe', async () => {
      const received: (EquipmentManifest | null)[] = [];
      const unsubscribe = subscribeEquipmentManifest(
        (m) => received.push(m),
        () => {},
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);
      const countBeforeUnsub = received.length;
      unsubscribe();

      await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [] });
      await delay(500);

      expect(received.length).toBe(countBeforeUnsub);
    });
  });

  describe('subscribeShoppingLists', () => {
    it('delivers a list written via createShoppingList', async () => {
      const received: ShoppingList[][] = [];
      const unsubscribe = subscribeShoppingLists(
        (lists) => received.push(lists),
        () => {},
      );

      const list: ShoppingList = {
        id: 'weekly',
        name: 'Weekly Shop',
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await createShoppingList(list);

      await waitFor(
        () => received.some((lists) => lists.some((l) => l.id === 'weekly')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((lists) => lists.some((l) => l.id === 'weekly'))).toBe(true);
    });

    it('stops callbacks after unsubscribe', async () => {
      const received: ShoppingList[][] = [];
      const unsubscribe = subscribeShoppingLists(
        (lists) => received.push(lists),
        () => {},
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);
      const countBeforeUnsub = received.length;
      unsubscribe();

      await createShoppingList({
        id: 'after-unsub',
        name: 'After',
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await delay(500);

      expect(received.length).toBe(countBeforeUnsub);
    });
  });

  describe('subscribeShoppingListItems (subcollection)', () => {
    it('delivers an item written via saveShoppingListItem', async () => {
      const listId = 'emulator-list';
      const received: ShoppingListItem[][] = [];
      const unsubscribe = subscribeShoppingListItems(
        listId,
        (items) => received.push(items),
        () => {},
      );

      const item: ShoppingListItem = {
        id: 'item-1',
        rawText: 'milk 2L',
        notes: '',
        sources: [{ kind: 'manual' }],
        canonId: null,
        matchState: 'pending',
        checked: false,
        needsCheck: false,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveShoppingListItem(listId, item);

      await waitFor(
        () => received.some((items) => items.some((i) => i.id === 'item-1')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((items) => items.some((i) => i.id === 'item-1'))).toBe(true);
    });

    it('delivers an updated item when saved again', async () => {
      const listId = 'emulator-list-update';
      const received: ShoppingListItem[][] = [];
      const unsubscribe = subscribeShoppingListItems(
        listId,
        (items) => received.push(items),
        () => {},
      );

      const item: ShoppingListItem = {
        id: 'item-u',
        rawText: 'eggs',
        notes: '',
        sources: [{ kind: 'manual' }],
        canonId: null,
        matchState: 'pending',
        checked: false,
        needsCheck: false,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveShoppingListItem(listId, item);
      await waitFor(
        () => received.some((items) => items.some((i) => i.id === 'item-u')),
        CONVERGENCE_MS,
      );

      const updated: ShoppingListItem = {
        ...item,
        canonId: 'canon-egg',
        matchState: 'matched',
        updatedAt: new Date().toISOString(),
      };
      await saveShoppingListItem(listId, updated);

      await waitFor(
        () =>
          received.some((items) =>
            items.some((i) => i.id === 'item-u' && i.matchState === 'matched'),
          ),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(
        received.some((items) =>
          items.some((i) => i.id === 'item-u' && i.matchState === 'matched'),
        ),
      ).toBe(true);
    });
  });

  describe('subscribeShoppingListsConfig', () => {
    it('delivers null when document does not exist', async () => {
      const received: (ShoppingListsConfig | null)[] = [];
      const unsubscribe = subscribeShoppingListsConfig(
        (cfg) => received.push(cfg),
        () => {},
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);

      unsubscribe();
      expect(received.some((r) => r === null)).toBe(true);
    });

    it('delivers config written via saveShoppingListsConfig', async () => {
      const received: (ShoppingListsConfig | null)[] = [];
      const unsubscribe = subscribeShoppingListsConfig(
        (cfg) => received.push(cfg),
        () => {},
      );

      await saveShoppingListsConfig({ defaultListId: 'weekly', schemaVersion: 1 });

      await waitFor(
        () => received.some((cfg) => cfg !== null && cfg.defaultListId === 'weekly'),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(received.some((cfg) => cfg !== null && cfg.defaultListId === 'weekly')).toBe(true);
    });
  });

  // Cook sessions (issue #558). The odd one out among these subscriptions in two
  // ways, and both shape the tests:
  //   * It is a SINGLE-DOCUMENT subscription (`onSnapshot(doc(...))`) on a
  //     deterministic id, not a collection query, so the payload is one
  //     `CookSessionDoc | null` rather than an array.
  //   * It is owner-scoped. The cross-client "writer" app is a DIFFERENT
  //     anonymous user, and firestore.rules pins `ownerUid` on create, so the
  //     writer literally cannot author a session the default app is allowed to
  //     read — the deny side of that is proven in firestoreRules.emulator.test.ts.
  //     Here the round-trip is therefore same-client (subscribe + saveCookSession),
  //     matching subscribeEquipmentManifest / subscribeShoppingListsConfig.
  describe('subscribeCookSession', () => {
    const RECIPE_ID = 'cook-recipe-1';

    // The anonymous uid of the default app for THIS test — resetDefaultApp mints
    // a fresh one per test, so it must be read inside the test, never hoisted.
    function currentUid(): string {
      const uid = getAuth(getApp()).currentUser?.uid;
      if (!uid) throw new Error('default app is not signed in');
      return uid;
    }

    // Newest non-null delivery. The subscription emits null when the doc goes
    // away, so scan newest → oldest for the last real session rather than
    // trusting any single index.
    function latestSession(received: (CookSessionDoc | null)[]): CookSessionDoc | undefined {
      for (let i = received.length - 1; i >= 0; i--) {
        const s = received[i];
        if (s) return s;
      }
      return undefined;
    }

    function makeSession(uid: string, overrides: Partial<CookSessionDoc> = {}): CookSessionDoc {
      const now = new Date().toISOString();
      return {
        id: `${RECIPE_ID}_${uid}`,
        schemaVersion: 1,
        ownerUid: uid,
        recipeId: RECIPE_ID,
        recipeUpdatedAtAtStart: now,
        checkedIngredientIds: [],
        checkedPrepIds: [],
        completedStepIds: [],
        activeTimers: [],
        serveAt: null,
        servings: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    async function seedSession(uid: string): Promise<CookSessionDoc> {
      const session = makeSession(uid);
      const result = await saveCookSession(session);
      expect(result.kind).toBe('ok');
      return session;
    }

    it('delivers an existing session to a fresh subscriber', async () => {
      const uid = currentUid();
      await seedSession(uid);

      const received: (CookSessionDoc | null)[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${uid}`,
        (s) => received.push(s),
        () => {},
      );

      await waitFor(() => received.some((s) => s?.recipeId === RECIPE_ID), CONVERGENCE_MS);

      unsubscribe();
      const delivered = latestSession(received)!;
      expect(delivered.id).toBe(`${RECIPE_ID}_${uid}`);
      expect(delivered.ownerUid).toBe(uid);
    });

    it('delivers mise ticks saved onto the session', async () => {
      const uid = currentUid();
      const session = await seedSession(uid);

      const received: (CookSessionDoc | null)[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${uid}`,
        (s) => received.push(s),
        () => {},
      );
      await waitFor(() => received.some((s) => s !== null), CONVERGENCE_MS);

      // Whole-document write, exactly as the cook page persists a tick.
      await saveCookSession({
        ...session,
        checkedIngredientIds: ['ing-1'],
        updatedAt: new Date().toISOString(),
      });

      await waitFor(
        () => received.some((s) => s?.checkedIngredientIds.includes('ing-1')),
        CONVERGENCE_MS,
      );

      unsubscribe();
      expect(latestSession(received)!.checkedIngredientIds).toEqual(['ing-1']);
    });

    it('stops callbacks after unsubscribe', async () => {
      const uid = currentUid();
      const session = await seedSession(uid);

      const received: (CookSessionDoc | null)[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${uid}`,
        (s) => received.push(s),
        () => {},
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);
      const countBeforeUnsub = received.length;
      unsubscribe();

      await saveCookSession({ ...session, updatedAt: new Date().toISOString() });
      await delay(500);

      expect(received.length).toBe(countBeforeUnsub);
    });

    // ── Absence, on both sides of the bootstrap ───────────────────────────────
    // The three cases below cover the path the cook page actually takes and the
    // one that #558 found broken: it subscribes to the deterministic id BEFORE
    // the session exists, then bootstraps it. That only works because the read
    // rule tolerates `resource == null` — a rule that dereferences
    // `resource.data` cannot be evaluated against an absent document, so
    // Firestore denied the read and tore the listener down permanently, leaving
    // the first cook of a recipe without a live subscription (and reporting a
    // spurious permission-denied). These are the regression guard for that
    // clause: if it is ever dropped from firestore.rules, all three fail with an
    // onError instead of a snapshot.
    it('delivers null when the session does not exist', async () => {
      const received: (CookSessionDoc | null)[] = [];
      const errors: unknown[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${currentUid()}`,
        (s) => received.push(s),
        (_err, raw) => errors.push(raw),
      );

      await waitFor(() => received.length > 0, CONVERGENCE_MS);

      unsubscribe();
      expect(received.some((r) => r === null)).toBe(true);
      expect(errors).toEqual([]);
    });

    it('delivers a session created after the subscription attaches', async () => {
      const uid = currentUid();
      const received: (CookSessionDoc | null)[] = [];
      const errors: unknown[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${uid}`,
        (s) => received.push(s),
        (_err, raw) => errors.push(raw),
      );

      // Subscribe first, THEN bootstrap — the cook page's order, and the one the
      // owner-scoped rule used to make unserviceable.
      await waitFor(() => received.length > 0, CONVERGENCE_MS);
      await seedSession(uid);

      await waitFor(() => received.some((s) => s?.recipeId === RECIPE_ID), CONVERGENCE_MS);

      unsubscribe();
      expect(latestSession(received)!.ownerUid).toBe(uid);
      expect(errors).toEqual([]);
    });

    it('delivers null again after deleteCookSession', async () => {
      const uid = currentUid();
      await seedSession(uid);

      const received: (CookSessionDoc | null)[] = [];
      const errors: unknown[] = [];
      const unsubscribe = subscribeCookSession(
        `${RECIPE_ID}_${uid}`,
        (s) => received.push(s),
        (_err, raw) => errors.push(raw),
      );
      await waitFor(() => received.some((s) => s !== null), CONVERGENCE_MS);

      const result = await deleteCookSession(`${RECIPE_ID}_${uid}`);
      expect(result.kind).toBe('ok');

      // Complete / Restart delete the doc; the subscription reports the absence
      // as null and stays alive, so a Restart's fresh session lands on the same
      // listener rather than needing a re-subscribe.
      await waitFor(() => received[received.length - 1] === null, CONVERGENCE_MS);
      await delay(1_000); // give a would-be teardown error time to arrive

      unsubscribe();
      expect(received[received.length - 1]).toBeNull();
      expect(errors).toEqual([]);
    });
  });

  // LWW / concurrent-write semantics (issue #302). The product has no application
  // merge policy — "conflict resolution" is purely Firestore's document-level
  // last-write-wins (the domain merge helpers were vestigial and removed, #419).
  // These pin the OBSERVABLE contract at the seam where our write shape meets
  // Firestore: a client edit is a FULL-document `upsertCanonItem` (setDoc), while
  // a CF trigger writes back a single field via `.update()` (onCanonItemWritten
  // does `{ thumbnail: url }`). Whether a concurrent trigger field survives a
  // client edit therefore depends only on whether the client held a fresh
  // snapshot — never on a merge. Deterministic: every step is sequenced with
  // waitFor on the subscription, never on wall-clock timing, so there is no
  // cross-client race to flake on (contrast an e2e write/write race).
  describe('LWW / concurrent-write semantics (issue #302)', () => {
    // Newest observed state of one item across all delivered snapshots. The
    // subscription re-delivers the whole collection on every change, so scan
    // newest → oldest and return the item's most recent view.
    function latestItem(received: CanonItem[][], id: string): CanonItem | undefined {
      for (let i = received.length - 1; i >= 0; i--) {
        const found = received[i]!.find((it) => it.id === id);
        if (found) return found;
      }
      return undefined;
    }

    it('a full-doc client edit against a STALE snapshot clobbers a concurrently trigger-written field', async () => {
      const id = 'lww-clobber';
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      try {
        // Client creates the item (thumbnail null), exactly as the UI does.
        await upsertCanonItem(makeItem(id, 'Tomato'));
        await waitFor(() => latestItem(received, id) !== undefined, CONVERGENCE_MS);

        // A CF trigger writes an icon back via a single-field `.update()`.
        await updateDoc(doc(writerDb, 'canonItems', id), {
          thumbnail: 'https://icons.example/tomato.webp',
        });
        await waitFor(() => Boolean(latestItem(received, id)?.thumbnail), CONVERGENCE_MS);

        // The client renames using the snapshot it ORIGINALLY wrote — which never
        // saw the trigger's thumbnail — and persists the whole document. This is
        // the real lost-update window: setDoc overwrites the entire doc.
        await upsertCanonItem({ ...makeItem(id, 'Tomatoes'), thumbnail: null });
        await waitFor(() => latestItem(received, id)?.name === 'Tomatoes', CONVERGENCE_MS);

        // Contract: LWW is per-DOCUMENT. The stale full-doc write won wholesale,
        // so the trigger's thumbnail is gone. If this ever flips (e.g. canon
        // edits move to field-scoped updateDoc), this assertion is the tripwire.
        const final = latestItem(received, id)!;
        expect(final.name).toBe('Tomatoes');
        expect(final.thumbnail).toBeNull();
      } finally {
        unsubscribe();
      }
    });

    it('a full-doc client edit against the FRESH snapshot preserves a trigger-written field', async () => {
      const id = 'lww-fresh';
      const received: CanonItem[][] = [];
      const unsubscribe = subscribeCanonItems(
        (items) => received.push(items),
        () => {},
      );

      try {
        await upsertCanonItem(makeItem(id, 'Onion'));
        await waitFor(() => latestItem(received, id) !== undefined, CONVERGENCE_MS);

        await updateDoc(doc(writerDb, 'canonItems', id), {
          thumbnail: 'https://icons.example/onion.webp',
        });
        await waitFor(() => Boolean(latestItem(received, id)?.thumbnail), CONVERGENCE_MS);

        // This time the client edits the FRESH item it just observed (thumbnail
        // included), so its full-doc write carries the trigger's field forward.
        const fresh = latestItem(received, id)!;
        await upsertCanonItem({ ...fresh, name: 'Onions' });
        await waitFor(() => latestItem(received, id)?.name === 'Onions', CONVERGENCE_MS);

        const final = latestItem(received, id)!;
        expect(final.name).toBe('Onions');
        expect(final.thumbnail).toBe('https://icons.example/onion.webp');
      } finally {
        unsubscribe();
      }
    });
  });

  // Two weeks on screen (issue #639). The planner can now hold a second week, and
  // the shop marker is ONE PER WEEK — so re-marking one week's shop must clear
  // that week's previous day and nothing else. Against real Firestore this pins
  // the property the service's week-keyed clear depends on: the week reads are
  // disjoint ranges over doc ids, so a delete inside one week's range is
  // invisible to the other's — including to the `shoppingDays/{YYYY-MM-DD}` get
  // the daily reminder function does by deterministic id.
  describe('shoppingDays — one shop per week, two weeks held (issue #639)', () => {
    const WEEK_A = '2026-08-10'; // Mon
    const WEEK_A_END = '2026-08-16';
    const WEEK_B = '2026-08-17'; // the Mon after
    const WEEK_B_END = '2026-08-23';

    function shopDay(date: string, slot: 'am' | 'pm'): ShoppingDayDoc {
      return {
        date,
        slot,
        schemaVersion: 1,
        setBy: 'uid-a',
        setAt: '2026-08-09T09:00:00.000Z',
      };
    }

    function dates(received: ShoppingDayDoc[][]): string[] {
      return (received.at(-1) ?? []).map((d) => d.date).sort();
    }

    it('re-marking one week’s shop leaves the other week’s doc untouched', async () => {
      const weekA: ShoppingDayDoc[][] = [];
      const weekB: ShoppingDayDoc[][] = [];
      const unsubA = subscribeShoppingDaysInRange(
        WEEK_A,
        WEEK_A_END,
        (days) => weekA.push(days),
        () => {},
      );
      const unsubB = subscribeShoppingDaysInRange(
        WEEK_B,
        WEEK_B_END,
        (days) => weekB.push(days),
        () => {},
      );

      try {
        // Each week has its shop: Saturday in week A, Wednesday in week B.
        await saveShoppingDay(shopDay('2026-08-15', 'am'));
        await saveShoppingDay(shopDay('2026-08-19', 'pm'));
        await waitFor(() => dates(weekA).length === 1 && dates(weekB).length === 1, CONVERGENCE_MS);

        // Move week B's shop to the Tuesday — the clear is scoped to week B, as
        // `setShopDay` computes it from weekStartFor(date, firstDayOfWeek).
        await deleteShoppingDay('2026-08-19');
        await saveShoppingDay(shopDay('2026-08-18', 'am'));
        await waitFor(() => dates(weekB).join() === '2026-08-18', CONVERGENCE_MS);

        // One shop in week B, and week A's Saturday is exactly where it was. A
        // clear scoped to the displayed RANGE rather than the date's week would
        // have taken it — and the reminder that reads it — with it.
        expect(dates(weekB)).toEqual(['2026-08-18']);
        expect(dates(weekA)).toEqual(['2026-08-15']);
      } finally {
        unsubA();
        unsubB();
      }
    });

    it('a week’s range read never sees the adjacent week’s shop', async () => {
      const weekA: ShoppingDayDoc[][] = [];
      const unsubA = subscribeShoppingDaysInRange(
        WEEK_A,
        WEEK_A_END,
        (days) => weekA.push(days),
        () => {},
      );

      try {
        await saveShoppingDay(shopDay('2026-08-15', 'am'));
        await waitFor(() => dates(weekA).length === 1, CONVERGENCE_MS);

        // The very next day after week A's window, and the last day of week B.
        await saveShoppingDay(shopDay('2026-08-17', 'pm'));
        await saveShoppingDay(shopDay('2026-08-23', 'am'));
        await delay(500);

        expect(dates(weekA)).toEqual(['2026-08-15']);
      } finally {
        unsubA();
      }
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await delay(50);
  }
}
