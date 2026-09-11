/**
 * The writer contract — every exported write, one table (#931).
 *
 * ─── What this file is for ───────────────────────────────────────────────────
 * #931's finding was that six writers in this package were typed `Promise<void>`
 * with no try/catch. A function that returns nothing cannot express failure, so
 * a rejected `setDoc` left the package as a thrown exception — which is what
 * CLAUDE.md Rule 10 forbids, and which the error-reporting gate never saw.
 *
 * It went in FIRST as a characterisation net, green against the unrefactored
 * source, with those six rows asserting IN TERMS that the writers threw. The fix
 * then turned all six red at once, which is the entire reason the net was
 * written before the change rather than after it: a return type is load-bearing
 * at every call site in `apps/web-pwa`, and this is what made a wide, quiet diff
 * announce itself.
 *
 * Those six rows have now moved to `'failure'`, and this file is no longer a
 * record of a defect — it is the standing contract that all 43 writers answer
 * for their failures the same way. The tri-state below is kept, empty states and
 * all, because that is what lets a regression be recorded rather than argued
 * about.
 *
 * It is the sibling of subscriptionContract.emulator.test.ts (#928), which pins
 * the read half of the same 115-export surface. Same shape, same rules: one
 * table, a coverage guard derived from the barrel, exact assertions rather than
 * membership, and no assertion about the SHAPE of the code that produces the
 * behaviour — commit 2 rewrites that shape.
 *
 * ─── Why mocks here, where #928 used the emulator ────────────────────────────
 * #928 pins what a SUBSCRIBER RECEIVES, which is a property of a live query and
 * of Firestore's own semantics; only a real emulator can produce it honestly.
 *
 * This file pins something else entirely: what a writer does WHEN THE WRITE
 * FAILS. Against a real emulator that is barely reachable — you would have to
 * provoke `permission-denied`, `resource-exhausted` and `unavailable` per row,
 * for 43 rows, and the emulator will not produce most of them on demand. A
 * mocked `setDoc` that rejects with a chosen Firestore code produces exactly
 * that failure, deterministically, in every row. The tri-state this table
 * exists to record — Failure / throws / swallows — is a property of the
 * writer's own try/catch, not of Firestore, so nothing is lost by mocking the
 * SDK and a great deal of determinism is gained.
 *
 * ─── The tri-state ───────────────────────────────────────────────────────────
 * Every row declares `onFailure`, and it is the whole point of the file:
 *
 *   'failure'  — returns `Failure<DomainError>` from `classifyFirestoreError`.
 *                The Rule 10 contract. All 43 writers, since #931.
 *   'throws'   — the rejected promise escapes the package RAW and unclassified.
 *                Rule 10 violated. Six writers until #931; NOBODY now, and
 *                RULE_TEN_VIOLATIONS is the empty list the guard holds it to.
 *   'swallows' — resolves as though nothing happened. Nobody has ever done this,
 *                and the guard asserts that empty list rather than leaving it
 *                unsaid: it is the state a careless repair of the six would
 *                have landed in, and the one no assertion elsewhere would catch.
 *
 * A 'throws' row asserts the thrown value is the INJECTED ERROR ITSELF (`toBe`,
 * identity), which is the discriminator that matters: it proves the error left
 * unclassified, so no caller can categorise it and the observability gate —
 * which routes on `DomainError.kind` — has nothing to route on. No row takes
 * that branch today; it stays because a regression has to land somewhere, and
 * an empty state that cannot be expressed is a state that gets argued away.
 *
 * ─── Why every row also pins the write it issues ─────────────────────────────
 * A row that only checked "returns a Failure when setDoc rejects" would stay
 * green if the refactor wrote to the wrong document, wrote the wrong payload, or
 * stopped writing at all. So each row declares `ops` — the exact Firestore
 * writes it issues, in order, as `{op, path, data}` — and the success test
 * asserts the recorded ops with `toEqual`, never membership. `doc()` is mocked
 * to return its path segments joined, so one assertion covers the primitive
 * (set vs update vs delete), the target document, and the payload at once.
 * `writeBatch`/`commit` record themselves in that same log, so the assertion
 * also covers whether the writes went out atomically — see the recorder below
 * for why the writes on their own could not say.
 *
 * That is what makes the table catch the transforms, which are the parts of
 * these writers that are not boilerplate and the parts a consolidation would
 * quietly lose: `upsertCanonItem` stripping the client-side embedding (#410),
 * `saveChatSession` stamping `expiresAt` (#696), `recordCanonPurchases`
 * collapsing repeats into one `increment(n)` under `{merge:true}` (#726),
 * `saveAisles` / `saveEquipmentManifest` wrapping their array in a versioned
 * envelope, and `saveShoppingListItem` stamping `traceContext` only when a
 * traceparent was passed (#362).
 *
 * ─── The clock ───────────────────────────────────────────────────────────────
 * Five writers stamp `new Date()` into the document. The clock is frozen for
 * the whole file so those payloads are exact values rather than
 * `expect.any(String)` — a wildcard there would accept a writer that stopped
 * stamping the field at all. Restored in `afterEach` (UT-F4).
 *
 * ─── What the coverage guard does, and what it cannot do ─────────────────────
 * `Object.keys(barrel)` is partitioned into WRITERS (a row each) and NON-WRITERS
 * (a one-word reason each), and their union must equal the barrel exactly. A new
 * export therefore cannot land silently: it fails the union until somebody
 * classifies it. That is the #928 pattern (`toEqual` + `toHaveLength`), and it is
 * deliberately NOT the retired one — nothing here reads `src/*.ts` as text. A
 * source-text scan goes vacuously green under exactly the refactor it guards.
 *
 * The honest limit: nothing here can PROVE a name in the non-writer list is not
 * a writer — that would mean invoking 72 functions with 72 argument shapes, most
 * of them callables that would then need a mocked Functions transport. What the
 * guard gives instead is that the classification is explicit, per-name, and
 * checked for exhaustiveness; and every row in the writer half is proved to
 * write, because its success test asserts the ops it issued. A writer misfiled
 * as a non-writer is a deliberate act with a reason string attached to it, not
 * an omission.
 *
 * The callables are the one judgement call in that partition. Several of them
 * (`callSetRecipeImageUpload`, `callRedoRecipeKit`, `callRegenerateCanonIcon` …)
 * do cause a document to change — server-side, through a Cloud Function. They
 * are not in this table because they are a different port with a different
 * classifier (`classifyCallableError`, covered by callableErrorMapping.test.ts),
 * and because #931 was about the writers that hold a `setDoc` themselves. All 28
 * already returned a `Result`, so none of them was a Rule 10 violation.
 *
 * Runs under plain `pnpm test` — no emulator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── The recorder ───────────────────────────────────────────────────────────
// One shared log of every Firestore write the module under test issues, and one
// switch that makes the next write reject. `doc()` returns its segments joined,
// so an op's `path` IS the document the write landed on.
//
// It records the BATCH PRIMITIVE as well as the writes, because the writes alone
// cannot tell you which primitive produced them: `batch.set(p, d)` and a bare
// `setDoc(p, d)` land the same `{op:'set', path, data}` in this log, and
// `commit()` is where the rejection is thrown rather than where a write is
// recorded. Two writers — `deleteShoppingListItems` and `moveShoppingListItems`,
// the only two in `src/` that call `writeBatch` — depend on atomicity for their
// correctness (a half-applied move is a duplicate on one list and a hole in the
// other), and without these markers rewriting either as a loop of standalone
// `deleteDoc`/`setDoc` calls left this whole file green. So `writeBatch()` logs
// `{op:'batch'}` and a successful `commit()` logs `{op:'commit'}`, uniformly for
// every writer: one batch, its writes between the pair, one commit. Two batches
// where there should be one, or none where there should be one, now reads off
// the `toEqual` directly.

interface WriteOp {
  op: 'set' | 'update' | 'delete' | 'batch' | 'commit';
  /** Absent on `batch`/`commit`: the primitive targets no single document. */
  path?: string;
  data?: unknown;
  options?: unknown;
}

const h = vi.hoisted(() => {
  const ops: WriteOp[] = [];
  const state: { reject: unknown } = { reject: null };
  const refuse = (): void => {
    if (state.reject !== null) throw state.reject;
  };

  return {
    ops,
    state,
    getFirestore: vi.fn(() => 'db'),
    doc: vi.fn((_db: unknown, ...segments: string[]) => segments.join('/')),
    collection: vi.fn((_db: unknown, ...segments: string[]) => segments.join('/')),
    setDoc: vi.fn(async (path: string, data: unknown, options?: unknown) => {
      refuse();
      ops.push(
        options === undefined ? { op: 'set', path, data } : { op: 'set', path, data, options },
      );
    }),
    updateDoc: vi.fn(async (path: string, data: unknown) => {
      refuse();
      ops.push({ op: 'update', path, data });
    }),
    deleteDoc: vi.fn(async (path: string) => {
      refuse();
      ops.push({ op: 'delete', path });
    }),
    writeBatch: vi.fn(() => {
      ops.push({ op: 'batch' });
      return {
        set: (path: string, data: unknown) => ops.push({ op: 'set', path, data }),
        delete: (path: string) => ops.push({ op: 'delete', path }),
        // `refuse()` first: a commit that rejected applied nothing, so it must
        // not leave a `commit` in the log.
        commit: vi.fn(async () => {
          refuse();
          ops.push({ op: 'commit' });
        }),
      };
    }),
    // A field transform is a sentinel object in the payload, so the ops
    // assertion sees `increment(2)` as a value and a writer that stopped using
    // one goes red (#726 — a read-modify-write would silently lose ticks).
    increment: vi.fn((n: number) => ({ __increment: n })),
    // The slice of the SDK's `Timestamp` the writers use. A real instance in the
    // payload would defeat `toEqual`'s exactness; this one compares by its
    // stored millis, so an expected `Timestamp.fromDate(...)` names the exact
    // instant and a writer that regressed to an ISO string goes red (#1008).
    Timestamp: class FakeTimestamp {
      private readonly ms: number;
      constructor(ms: number) {
        this.ms = ms;
      }
      static fromDate(date: Date): FakeTimestamp {
        return new FakeTimestamp(date.getTime());
      }
      toDate(): Date {
        return new Date(this.ms);
      }
    },
    noop: vi.fn(),
  };
});

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

// Two mocks, both on the SDK boundary this package exists to wrap (UT-B3).
vi.mock('firebase/firestore', () => ({
  getFirestore: h.getFirestore,
  initializeFirestore: h.noop,
  persistentLocalCache: h.noop,
  connectFirestoreEmulator: h.noop,
  enableNetwork: h.noop,
  disableNetwork: h.noop,
  collection: h.collection,
  doc: h.doc,
  documentId: h.noop,
  query: h.noop,
  where: h.noop,
  orderBy: h.noop,
  limit: h.noop,
  onSnapshot: vi.fn(() => vi.fn()),
  getDoc: h.noop,
  getDocs: h.noop,
  getDocFromCache: h.noop,
  setDoc: h.setDoc,
  updateDoc: h.updateDoc,
  deleteDoc: h.deleteDoc,
  writeBatch: h.writeBatch,
  increment: h.increment,
  Timestamp: h.Timestamp,
}));

// The public surface, which is also what the coverage guard partitions (UT-A3).
import * as barrel from '../src/index.js';
import { emptyRecipe, emptyTemplate, emptyWeek, type Aisle } from '@salt/domain';
import type { DomainError } from '@salt/shared-types';
import { AI_MODEL_DEFAULTS, type AppSettings } from '@salt/domain/schemas';

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Frozen clock: five writers stamp `new Date()` into the document, and the ops
// assertions below name the exact value rather than a wildcard.
const NOW = '2026-08-24T09:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;
// Eighteen months, the window a recipe-attached chat gets since #939. It replaced
// a `9999-12-31` sentinel: the reason a chat about a dish outlives a general one
// is unchanged, but "longer" and "never" are not the same claim.
const EIGHTEEN_MONTHS_MS = 540 * DAY_MS;

const AISLE: Aisle = { id: 'a-1', name: 'Dairy', order: 0 };
const RECIPE = emptyRecipe('r-1', NOW);

const CANON_ITEM = {
  id: 'c-1',
  schemaVersion: 5 as const,
  name: 'lime',
  synonyms: ['limes'],
  aisleId: 'a-1',
  thumbnail: null,
  // Server-only since #410. The write must drop it.
  embedding: [0.1, 0.2],
  needs_approval: false,
  shoppingBehavior: 'needed' as const,
  updatedAt: NOW,
};
const CANON_ITEM_WRITTEN = {
  id: 'c-1',
  schemaVersion: 5,
  name: 'lime',
  synonyms: ['limes'],
  aisleId: 'a-1',
  thumbnail: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  updatedAt: NOW,
};

const PRODUCT_FORM = {
  id: 'pf-1',
  schemaVersion: 1 as const,
  matchers: ['lime juice'],
  parentCanonId: 'c-1',
  label: 'lime juice',
  yield: { formUnit: 'ml' as const, amountPerParent: 30 },
  updatedAt: NOW,
  thumbnail: null,
};

const KITCHEN_TOOL = {
  id: 'mixing-bowl',
  schemaVersion: 1 as const,
  label: 'Mixing bowl',
  matchers: ['bowl'],
  thumbnail: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const MEMBER = {
  id: 'a@b.com',
  schemaVersion: 1 as const,
  name: 'Ada',
  email: 'a@b.com',
  admin: true,
  sortOrder: 0,
  icon: null,
  cookMode: 'standard' as const,
  system: false,
  updatedAt: NOW,
};

const SHOPPING_LIST = {
  id: 'list-1',
  name: 'Weekly',
  schemaVersion: 1 as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const LIST_ITEM = {
  id: 'item-1',
  rawText: '2 limes',
  notes: '',
  sources: [],
  canonId: null,
  matchState: 'pending' as const,
  checked: false,
  needsCheck: false,
  schemaVersion: 1 as const,
  createdAt: NOW,
  updatedAt: NOW,
};
const LIST_ITEM_2 = { ...LIST_ITEM, id: 'item-2', rawText: '1 lemon' };

const CHAT_SESSION = {
  id: 'chat-1',
  schemaVersion: 1 as const,
  ownerUid: 'uid-a',
  recipeId: null,
  basedOnRecipeId: null,
  title: 'Dinner',
  messages: [],
  createdAt: NOW,
  updatedAt: NOW,
  reopenedAt: null,
  expiresAt: NOW,
};

const COOK_SESSION = {
  id: 'r-1_uid-a',
  schemaVersion: 1 as const,
  ownerUid: 'uid-a',
  recipeId: 'r-1',
  recipeUpdatedAtAtStart: NOW,
  checkedIngredientIds: [],
  completedStepIds: [],
  activeTimers: [],
  checkedPrepIds: [],
  serveAt: null,
  servings: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const KITCHEN_TIMERS = {
  ownerUid: 'uid-a',
  timers: [{ id: 't-1', label: 'Egg', endsAt: NOW, durationMinutes: 6, notify: true }],
};

const GUIDED_PLAN = {
  id: 'r-1',
  schemaVersion: 1 as const,
  recipeId: 'r-1',
  recipeUpdatedAtAtSave: NOW,
  prep: [],
  stepNotes: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const FORMULA = {
  recipeId: 'r-1',
  components: [{ ingredientId: 'i-1', percent: 100, inBasis: true }],
  referenceYield: { kind: 'basis' as const, grams: 1000 },
  schemaVersion: 1 as const,
};

const BATCH = {
  id: 'b-1',
  schemaVersion: 1 as const,
  recipeId: 'r-1',
  recipeTitle: 'Sourdough',
  state: 'running' as const,
  abandonedAt: null,
  quantities: [],
  totals: {
    basisGrams: 1000,
    totalGrams: 1600,
    usableGrams: 1600,
    units: null,
    plannedStartAt: NOW,
    plannedEndAt: NOW,
    actualStartAt: null,
    actualEndAt: null,
  },
  stages: [],
  rationale: null,
  ambientCelsius: null,
  checkedIngredientIds: [],
  completedStepIds: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const OBSERVATION = {
  id: 'o-1',
  schemaVersion: 1 as const,
  at: NOW,
  stageId: null,
  weightGrams: 900,
  ph: null,
  temperatureC: null,
  relativeHumidityPercent: null,
  note: 'weighed',
  image: null,
};

const KITCHEN_MEMORY = {
  id: 'm-1',
  schemaVersion: 1 as const,
  text: 'we hate coriander',
  author: 'Ada',
  createdAt: NOW,
};

const PUSH_SUBSCRIPTION = {
  id: 'uid-a_device-1',
  schemaVersion: 1 as const,
  ownerUid: 'uid-a',
  endpoint: 'https://push.example/abc',
  keys: { auth: 'auth-key', p256dh: 'p256-key' },
  createdAt: NOW,
  updatedAt: NOW,
};

const SHOPPING_DAY = {
  date: '2026-08-28',
  slot: 'am' as const,
  schemaVersion: 1 as const,
  setBy: 'uid-a',
  setAt: NOW,
};

const APP_SETTINGS: AppSettings = { ...AI_MODEL_DEFAULTS, schemaVersion: 1 };
const DEV_SETTINGS = {
  canonIconGenerationEnabled: true,
  recipeImageGenerationEnabled: true,
  schemaVersion: 1 as const,
};
const LISTS_CONFIG = { defaultListId: 'list-1', schemaVersion: 1 as const };
const MEAL_PLAN_CONFIG = { firstDayOfWeek: 'fri' as const, schemaVersion: 1 as const };
const MEAL_PLAN_TEMPLATE = emptyTemplate();
const MEAL_PLAN_WEEK = emptyWeek('2026-08-28');
// `updatedAt` deliberately NOT `NOW`: `saveEquipmentManifest` stamps the clock,
// and a fixture carrying the asserted value would let a pass-through of the
// caller's field masquerade as a write-time stamp.
const EQUIPMENT_MANIFEST = {
  schemaVersion: 1 as const,
  updatedAt: '2020-01-01T00:00:00.000Z',
  items: [],
};

// ─── The table ──────────────────────────────────────────────────────────────

/**
 * What a writer does when its Firestore write rejects. THE column this file
 * exists for — see the header. `'throws'` is a Rule 10 violation and every row
 * carrying it must also appear in RULE_TEN_VIOLATIONS below. No row carries it
 * any more; the state is kept because a table that can only express the right
 * answer cannot record the wrong one arriving.
 */
type FailureContract = 'failure' | 'throws' | 'swallows';

interface WriterCase {
  name: string;
  /** Invoke the writer through the barrel with a valid payload. */
  run: () => Promise<unknown>;
  /** Every Firestore write it issues, in order. Asserted with `toEqual`. */
  ops: WriteOp[];
  /** What a SUCCESSFUL call resolves to. */
  onSuccess: 'success(undefined)' | 'undefined';
  onFailure: FailureContract;
  /**
   * Whether the error that crosses the boundary went through
   * `classifyFirestoreError`. Tracked separately from `onFailure` because it is
   * the half a caller can act on: an unclassified error has no `DomainError.kind`
   * for the reporting gate (docs/salt-architecture.md §7.6) to route on.
   */
  errorShape: 'classified' | 'raw';
}

/**
 * EMPTY, and that is the finding of #931 discharged rather than a list nobody
 * got round to filling in. It held the six — `saveAisles`,
 * `saveEquipmentManifest`, `setAiStub`, `upsertCanonItem`, `upsertKitchenTool`,
 * `upsertProductForm` — until the commit before this one gave them the same
 * `ReadResult<void, DomainError>` the other 37 already returned.
 *
 * It stays, empty, as the recurrence guard: the guard below asserts this is
 * EXACTLY the set of rows whose `onFailure` is `'throws'`, so a writer added
 * tomorrow with a bare `Promise<void>` cannot be recorded here without somebody
 * typing its name into a list called RULE_TEN_VIOLATIONS.
 */
const RULE_TEN_VIOLATIONS: string[] = [];

const writerCases: WriterCase[] = [
  // ── canon ────────────────────────────────────────────────────────────────
  {
    name: 'upsertCanonItem',
    run: () => barrel.upsertCanonItem(CANON_ITEM),
    // No `embedding` key: vectors are server-only since #410, and the write
    // strips one an un-migrated client edit would otherwise put back.
    ops: [{ op: 'set', path: 'canonItems/c-1', data: CANON_ITEM_WRITTEN }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteCanonItem',
    run: () => barrel.deleteCanonItem('c-1'),
    ops: [{ op: 'delete', path: 'canonItems/c-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveAisles',
    run: () => barrel.saveAisles([AISLE]),
    // The array goes into a versioned envelope, stamped at write time.
    ops: [
      {
        op: 'set',
        path: 'canonData/aisles',
        data: { schemaVersion: 1, updatedAt: NOW, aisles: [AISLE] },
      },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'recordCanonPurchases',
    // 'c-1' twice: a genuine double purchase accumulates into increment(2)
    // rather than being de-duplicated away (#726).
    run: () => barrel.recordCanonPurchases(['c-1', 'c-2', 'c-1']),
    ops: [
      {
        op: 'set',
        path: 'canonData/purchaseCounts',
        data: {
          counts: { 'c-1': { __increment: 2 }, 'c-2': { __increment: 1 } },
          lastAt: { 'c-1': NOW, 'c-2': NOW },
        },
        // merge, not updateDoc: the first ever tick-off has no document.
        options: { merge: true },
      },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── product forms & kitchen tools ────────────────────────────────────────
  {
    name: 'upsertProductForm',
    run: () => barrel.upsertProductForm(PRODUCT_FORM),
    ops: [{ op: 'set', path: 'productForms/pf-1', data: PRODUCT_FORM }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteProductForm',
    run: () => barrel.deleteProductForm('pf-1'),
    ops: [{ op: 'delete', path: 'productForms/pf-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'upsertKitchenTool',
    run: () => barrel.upsertKitchenTool(KITCHEN_TOOL),
    ops: [{ op: 'set', path: 'kitchenTools/mixing-bowl', data: KITCHEN_TOOL }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteKitchenTool',
    run: () => barrel.deleteKitchenTool('mixing-bowl'),
    ops: [{ op: 'delete', path: 'kitchenTools/mixing-bowl' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── equipment ────────────────────────────────────────────────────────────
  {
    name: 'saveEquipmentManifest',
    run: () => barrel.saveEquipmentManifest(EQUIPMENT_MANIFEST),
    ops: [
      {
        op: 'set',
        path: 'equipmentManifest/current',
        data: { schemaVersion: 1, updatedAt: NOW, items: [] },
      },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── members ──────────────────────────────────────────────────────────────
  {
    name: 'upsertMember',
    run: () => barrel.upsertMember(MEMBER),
    ops: [{ op: 'set', path: 'members/a@b.com', data: MEMBER }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteMember',
    run: () => barrel.deleteMember('a@b.com'),
    ops: [{ op: 'delete', path: 'members/a@b.com' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── shopping lists ───────────────────────────────────────────────────────
  {
    name: 'createShoppingList',
    run: () => barrel.createShoppingList(SHOPPING_LIST),
    ops: [{ op: 'set', path: 'shoppingLists/list-1', data: SHOPPING_LIST }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'renameShoppingList',
    // The one partial write in the package: `updateDoc`, not a full-doc `setDoc`.
    run: () => barrel.renameShoppingList('list-1', 'Fortnightly', NOW),
    ops: [
      { op: 'update', path: 'shoppingLists/list-1', data: { name: 'Fortnightly', updatedAt: NOW } },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteShoppingList',
    run: () => barrel.deleteShoppingList('list-1'),
    ops: [{ op: 'delete', path: 'shoppingLists/list-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── shopping list items (a subcollection of the list) ─────────────────────
  {
    name: 'saveShoppingListItem',
    // No traceparent here — the stamped variant is pinned in its own test below.
    run: () => barrel.saveShoppingListItem('list-1', LIST_ITEM),
    ops: [{ op: 'set', path: 'shoppingLists/list-1/items/item-1', data: LIST_ITEM }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteShoppingListItem',
    run: () => barrel.deleteShoppingListItem('list-1', 'item-1'),
    ops: [{ op: 'delete', path: 'shoppingLists/list-1/items/item-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteShoppingListItems',
    run: () => barrel.deleteShoppingListItems('list-1', ['item-1', 'item-2']),
    // One batched commit, not two round trips — and the `batch`/`commit` pair
    // is what says so. Without them the same two deletes are recorded by two
    // standalone `deleteDoc` calls.
    ops: [
      { op: 'batch' },
      { op: 'delete', path: 'shoppingLists/list-1/items/item-1' },
      { op: 'delete', path: 'shoppingLists/list-1/items/item-2' },
      { op: 'commit' },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'moveShoppingListItems',
    run: () => barrel.moveShoppingListItems('list-1', 'list-2', [LIST_ITEM, LIST_ITEM_2]),
    // Delete-then-set per item, all in ONE batch — a single `batch`/`commit`
    // pair around all four writes: a move is atomic or it is a duplicate on one
    // list and a hole in the other. A batch per item would read as four pairs.
    ops: [
      { op: 'batch' },
      { op: 'delete', path: 'shoppingLists/list-1/items/item-1' },
      { op: 'set', path: 'shoppingLists/list-2/items/item-1', data: LIST_ITEM },
      { op: 'delete', path: 'shoppingLists/list-1/items/item-2' },
      { op: 'set', path: 'shoppingLists/list-2/items/item-2', data: LIST_ITEM_2 },
      { op: 'commit' },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveShoppingListsConfig',
    run: () => barrel.saveShoppingListsConfig(LISTS_CONFIG),
    ops: [{ op: 'set', path: 'shoppingListsConfig/singleton', data: LISTS_CONFIG }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── recipes ──────────────────────────────────────────────────────────────
  {
    name: 'saveRecipe',
    run: () => barrel.saveRecipe(RECIPE),
    ops: [{ op: 'set', path: 'recipes/r-1', data: { ...RECIPE } }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteRecipe',
    run: () => barrel.deleteRecipe('r-1'),
    ops: [{ op: 'delete', path: 'recipes/r-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── chat & cook sessions ─────────────────────────────────────────────────
  {
    name: 'saveChatSession',
    // recipeId null → the ordinary 14-day TTL branch (#696). The recipe-attached
    // branch, which gets a longer window rather than none, has its own test below.
    run: () => barrel.saveChatSession(CHAT_SESSION),
    ops: [
      {
        op: 'set',
        path: 'chatSessions/chat-1',
        // A `Timestamp`, not an ISO string: the TTL policy acts on nothing
        // else (#1008). Same frozen instant.
        data: {
          ...CHAT_SESSION,
          expiresAt: h.Timestamp.fromDate(new Date(NOW_MS + FOURTEEN_DAYS_MS)),
        },
      },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteChatSession',
    run: () => barrel.deleteChatSession('chat-1'),
    ops: [{ op: 'delete', path: 'chatSessions/chat-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveCookSession',
    run: () => barrel.saveCookSession(COOK_SESSION),
    ops: [{ op: 'set', path: 'cookSessions/r-1_uid-a', data: COOK_SESSION }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteCookSession',
    run: () => barrel.deleteCookSession('r-1_uid-a'),
    ops: [{ op: 'delete', path: 'cookSessions/r-1_uid-a' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveKitchenTimers',
    // Keyed by ownerUid, which IS the document id (#842).
    run: () => barrel.saveKitchenTimers(KITCHEN_TIMERS),
    ops: [{ op: 'set', path: 'kitchenTimers/uid-a', data: KITCHEN_TIMERS }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── guided plans, formulas, batches ──────────────────────────────────────
  {
    name: 'saveGuidedPlan',
    run: () => barrel.saveGuidedPlan(GUIDED_PLAN),
    ops: [{ op: 'set', path: 'guidedPlans/r-1', data: GUIDED_PLAN }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteGuidedPlan',
    run: () => barrel.deleteGuidedPlan('r-1'),
    ops: [{ op: 'delete', path: 'guidedPlans/r-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveFormula',
    // Keyed by recipeId, not by an id of its own.
    run: () => barrel.saveFormula(FORMULA),
    ops: [{ op: 'set', path: 'formulas/r-1', data: FORMULA }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveBatch',
    run: () => barrel.saveBatch(BATCH),
    ops: [{ op: 'set', path: 'batches/b-1', data: BATCH }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'addBatchObservation',
    // A subcollection under the run, keyed by the observation's own id.
    run: () => barrel.addBatchObservation('b-1', OBSERVATION),
    ops: [{ op: 'set', path: 'batches/b-1/observations/o-1', data: OBSERVATION }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── kitchen memories ─────────────────────────────────────────────────────
  {
    name: 'saveKitchenMemory',
    run: () => barrel.saveKitchenMemory(KITCHEN_MEMORY),
    ops: [{ op: 'set', path: 'kitchenMemories/m-1', data: KITCHEN_MEMORY }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteKitchenMemory',
    run: () => barrel.deleteKitchenMemory('m-1'),
    ops: [{ op: 'delete', path: 'kitchenMemories/m-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── push subscriptions ───────────────────────────────────────────────────
  {
    name: 'savePushSubscription',
    run: () => barrel.savePushSubscription(PUSH_SUBSCRIPTION),
    ops: [{ op: 'set', path: 'pushSubscriptions/uid-a_device-1', data: PUSH_SUBSCRIPTION }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deletePushSubscription',
    run: () => barrel.deletePushSubscription('uid-a_device-1'),
    ops: [{ op: 'delete', path: 'pushSubscriptions/uid-a_device-1' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── meal planner & shop days ─────────────────────────────────────────────
  {
    name: 'saveMealPlanConfig',
    run: () => barrel.saveMealPlanConfig(MEAL_PLAN_CONFIG),
    ops: [{ op: 'set', path: 'mealPlanConfig/singleton', data: MEAL_PLAN_CONFIG }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveMealPlanTemplate',
    run: () => barrel.saveMealPlanTemplate(MEAL_PLAN_TEMPLATE),
    ops: [{ op: 'set', path: 'mealPlanTemplate/singleton', data: { ...MEAL_PLAN_TEMPLATE } }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveMealPlanWeek',
    // Keyed by week.id, which is the start date.
    run: () => barrel.saveMealPlanWeek(MEAL_PLAN_WEEK),
    ops: [{ op: 'set', path: 'mealPlans/2026-08-28', data: { ...MEAL_PLAN_WEEK } }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveShoppingDay',
    // Keyed by the date (#629) — the id is what makes the week a range read.
    run: () => barrel.saveShoppingDay(SHOPPING_DAY),
    ops: [{ op: 'set', path: 'shoppingDays/2026-08-28', data: SHOPPING_DAY }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'deleteShoppingDay',
    run: () => barrel.deleteShoppingDay('2026-08-28'),
    ops: [{ op: 'delete', path: 'shoppingDays/2026-08-28' }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── settings singletons ──────────────────────────────────────────────────
  {
    name: 'saveAppSettings',
    run: () => barrel.saveAppSettings(APP_SETTINGS),
    ops: [{ op: 'set', path: 'appSettings/singleton', data: APP_SETTINGS }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
  {
    name: 'saveDevSettings',
    run: () => barrel.saveDevSettings(DEV_SETTINGS),
    ops: [{ op: 'set', path: 'devSettings/singleton', data: DEV_SETTINGS }],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },

  // ── e2e-only ─────────────────────────────────────────────────────────────
  {
    name: 'setAiStub',
    // Emulator-only, but exported from the barrel and holding a `setDoc`, so it
    // is in the table like any other writer — and answers for its failure like
    // one, because test infrastructure is still adapter code.
    run: () => barrel.setAiStub('populateEquipmentEntry', { ok: true }),
    ops: [
      {
        op: 'set',
        path: '_e2e_ai_stubs/populateEquipmentEntry',
        data: { response: { ok: true }, updatedAt: NOW },
      },
    ],
    onSuccess: 'success(undefined)',
    onFailure: 'failure',
    errorShape: 'classified',
  },
];

/**
 * Every barrel export that is NOT a writer, with the reason it is not one.
 *
 * Hand-listed, and safe to be: the guard below asserts WRITERS ∪ NON-WRITERS is
 * exactly the barrel, so a new export cannot be absent from both — the failure
 * is on the union, not on this list's freshness. See the header for the limit
 * this does have.
 */
const NON_WRITERS: Record<string, 'subscription' | 'read' | 'callable' | 'infrastructure'> = {
  // Realtime reads. Their contract is pinned by subscriptionContract.emulator.test.ts (#928).
  subscribeAisles: 'subscription',
  subscribeAppSettings: 'subscription',
  subscribeBatch: 'subscription',
  subscribeBatchObservations: 'subscription',
  subscribeBatches: 'subscription',
  subscribeCanonItems: 'subscription',
  subscribeChatSessions: 'subscription',
  subscribeCookSession: 'subscription',
  subscribeDevSettings: 'subscription',
  subscribeEquipmentIcons: 'subscription',
  subscribeEquipmentManifest: 'subscription',
  subscribeFormula: 'subscription',
  subscribeGuidedPlan: 'subscription',
  subscribeKitchenMemories: 'subscription',
  subscribeKitchenTimers: 'subscription',
  subscribeKitchenTools: 'subscription',
  subscribeMealPlanConfig: 'subscription',
  subscribeMealPlanTemplate: 'subscription',
  subscribeMealPlanWeek: 'subscription',
  subscribeMembers: 'subscription',
  subscribeMyCookSessions: 'subscription',
  subscribeProductForms: 'subscription',
  subscribeRecipes: 'subscription',
  subscribeShoppingDaysInRange: 'subscription',
  subscribeShoppingListItems: 'subscription',
  subscribeShoppingLists: 'subscription',
  subscribeShoppingListsConfig: 'subscription',
  subscribeWeatherForecast: 'subscription',

  // One-shot reads.
  listShoppingListItems: 'read',
  listShoppingLists: 'read',
  loadAllGuidedPlans: 'read',
  loadCanonPurchaseCounts: 'read',
  loadChatSession: 'read',
  loadCookSession: 'read',
  loadFormula: 'read',
  loadGuidedPlan: 'read',
  loadMealPlanWeek: 'read',
  loadRecipe: 'read',
  loadShoppingListsConfig: 'read',
  probeFirestoreCache: 'read',

  // Cloud Function callables. Some of them do cause a document to change, but
  // server-side and through `classifyCallableError` — a different port with a
  // different classifier (see the header). All 28 already return a Result.
  callAuthorRecipe: 'callable',
  callCanonicaliseRecipeIngredients: 'callable',
  callDescribeEquipmentSubject: 'callable',
  callDescribeRecipeScene: 'callable',
  callDrawEquipmentIcon: 'callable',
  callExtractProcessStages: 'callable',
  callExtractRecipeFromPhoto: 'callable',
  callExtractRecipeFromUrl: 'callable',
  callGenerateChatTitle: 'callable',
  callGenerateGuidedPlan: 'callable',
  callGetImagePrompt: 'callable',
  callIdentifyEquipment: 'callable',
  callListAiModels: 'callable',
  callListPushoverDevices: 'callable',
  callMatchOrCreate: 'callable',
  callParseRecipeIngredients: 'callable',
  callPopulateEquipmentEntry: 'callable',
  callProposeSchedule: 'callable',
  callRedoRecipeKit: 'callable',
  callRefreshWeatherForecast: 'callable',
  callRegenerateCanonIcon: 'callable',
  callRegenerateProductFormIcon: 'callable',
  callRegenerateRecipeImage: 'callable',
  callSetIconUpload: 'callable',
  callSetObservationImageUpload: 'callable',
  callSetRecipeImageUpload: 'callable',
  callTestModel: 'callable',
  streamChefChat: 'callable',

  // SDK lifecycle. No document is involved.
  createFirebaseAuth: 'infrastructure',
  initFirebase: 'infrastructure',
  isAuthTransitioning: 'infrastructure',
  setFirestoreNetwork: 'infrastructure',
};

// ─── Harness ────────────────────────────────────────────────────────────────

const FIRESTORE_ERROR = (code: string): Error & { code: string } =>
  Object.assign(new Error(`firestore ${code}`), { code });

beforeEach(() => {
  vi.clearAllMocks();
  h.ops.length = 0;
  h.state.reject = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  // `classifyFirestoreError` short-circuits to NetworkError/offline when the
  // browser is offline, which would mask every code below. Node's own global
  // `navigator` has no `onLine`, so it must be stubbed rather than left alone.
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── The guard ──────────────────────────────────────────────────────────────
// Guards on the TABLE — that no writer and no obligation has been left out of
// it. Nothing here reads `src/` as text; see the header for why.

describe('writer contract — table coverage', () => {
  it('classifies every barrel export — derived from the barrel, not a hand-kept list', () => {
    const exported = Object.keys(barrel).sort();
    const classified = [...writerCases.map((c) => c.name), ...Object.keys(NON_WRITERS)].sort();

    // A new export must arrive as a row or as a stated non-writer. This is the
    // recurrence guard: a writer added with neither fails here.
    expect(classified).toEqual(exported);
    expect(exported).toHaveLength(115);
    expect(writerCases).toHaveLength(43);
  });

  it('every row is uniquely named', () => {
    const names = writerCases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every row issues at least one write', () => {
    for (const c of writerCases) {
      // Counted on `path`, so a row made of nothing but `batch`/`commit`
      // markers cannot satisfy this vacuously — a batch that touches no
      // document is not a write.
      const writes = c.ops.filter((o) => o.path !== undefined);
      expect(writes.length, `${c.name} declares no write`).toBeGreaterThan(0);
    }
  });

  /**
   * The headline. Three exact lists, so the tri-state is readable without
   * running anything — and so a refactor that moves a writer between states
   * has to say so here.
   */
  it('records the failure contract of all 43 writers as three exact sets', () => {
    const named = (state: FailureContract): string[] =>
      writerCases
        .filter((c) => c.onFailure === state)
        .map((c) => c.name)
        .sort();

    // Both empty since #931's fix. Stated, not assumed: 'swallows' is the state
    // a careless repair of the six would have landed in, and 'throws' is the one
    // they came from.
    expect(named('throws')).toEqual([...RULE_TEN_VIOLATIONS].sort());
    expect(named('throws')).toEqual([]);
    expect(named('swallows')).toEqual([]);
    expect(named('failure')).toHaveLength(43);
  });

  it('a writer that returns a Result classifies its error, and one that throws would not', () => {
    for (const c of writerCases) {
      const expected = c.onFailure === 'failure' ? 'classified' : 'raw';
      expect(c.errorShape, `${c.name} disagrees with its own failure contract`).toBe(expected);
    }
  });

  /**
   * The positive form of what the six rows used to say by their absence. A
   * writer that returns nothing cannot report a failure — that was #931's whole
   * argument — so the answer to it is that all 43 now return something.
   */
  it('every writer returns a Result, which is what makes the failure reportable', () => {
    for (const c of writerCases) {
      expect(c.onSuccess, `${c.name} returns nothing, so it cannot report`).toBe(
        'success(undefined)',
      );
    }
  });
});

// ─── The rows ───────────────────────────────────────────────────────────────

describe.each(writerCases)('$name', (c) => {
  it(`writes ${JSON.stringify(c.ops.map((o) => (o.path === undefined ? o.op : `${o.op} ${o.path}`)))} and resolves to ${c.onSuccess}`, async () => {
    const result = await c.run();

    expect(h.ops).toEqual(c.ops);
    if (c.onSuccess === 'success(undefined)') {
      expect(result).toEqual({ kind: 'ok', value: undefined });
    } else {
      expect(result).toBeUndefined();
    }
  });

  it(`on a rejected write it ${c.onFailure}`, async () => {
    const err = FIRESTORE_ERROR('permission-denied');
    h.state.reject = err;

    if (c.onFailure === 'throws') {
      // No row reaches this today. Kept because the branch is what a regression
      // would land in: the rejection escaping the package AS IS — the same
      // object, uncategorised — with no `kind` for a caller to branch on or the
      // reporting gate to route on, which is what Rule 10 exists to prevent.
      await expect(c.run()).rejects.toBe(err);
      return;
    }

    const result = await c.run();
    if (c.onFailure === 'swallows') {
      expect(result).toBeUndefined();
      return;
    }
    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' } satisfies DomainError,
    });
  });

  it('maps the Firestore code rather than returning a fixed error', async () => {
    if (c.onFailure !== 'failure') {
      // Unreached since #931: a throwing writer maps nothing, and asserting that
      // directly rather than skipping the row is what keeps the claim on the
      // record for all 43 whichever state a row is in.
      const err = FIRESTORE_ERROR('resource-exhausted');
      h.state.reject = err;
      await expect(c.run()).rejects.toBe(err);
      return;
    }

    h.state.reject = FIRESTORE_ERROR('resource-exhausted');
    await expect(c.run()).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'quota-exceeded' } satisfies DomainError,
    });

    h.state.reject = FIRESTORE_ERROR('unavailable');
    await expect(c.run()).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' } satisfies DomainError,
    });
  });
});

// ─── The transforms a single row cannot hold ────────────────────────────────
// Some writers branch on their input, and a row can only take one branch. These
// take the other, so neither is left to a wildcard.

describe('saveShoppingListItem — the trace stamp (#362)', () => {
  it('stamps traceContext when a traceparent is passed', async () => {
    await barrel.saveShoppingListItem('list-1', LIST_ITEM, '00-abc-def-01');

    expect(h.ops).toEqual([
      {
        op: 'set',
        path: 'shoppingLists/list-1/items/item-1',
        data: { ...LIST_ITEM, traceContext: '00-abc-def-01' },
      },
    ]);
  });

  it('writes no traceContext key at all when none is passed', async () => {
    await barrel.saveShoppingListItem('list-1', LIST_ITEM);

    expect(h.ops[0]!.data).not.toHaveProperty('traceContext');
  });
});

describe('saveChatSession — the expiry stamp (#696, #939)', () => {
  it('a recipe-attached chat is written to last eighteen months, not for ever', async () => {
    await barrel.saveChatSession({ ...CHAT_SESSION, recipeId: 'r-1' });

    expect(h.ops).toEqual([
      {
        op: 'set',
        path: 'chatSessions/chat-1',
        data: {
          ...CHAT_SESSION,
          recipeId: 'r-1',
          expiresAt: h.Timestamp.fromDate(new Date(NOW_MS + EIGHTEEN_MONTHS_MS)),
        },
      },
    ]);
  });
});

describe('deleteShoppingListItems — the empty selection', () => {
  // Migrated from shoppingListItemSubscription.test.ts when #928's replacement
  // of that file was completed (#939). The row above deletes two items; this is
  // the other branch of the same loop, and it is the one the shopping page hits
  // whenever "clear checked" is pressed with nothing checked.
  it('commits an empty batch and still succeeds when no items were selected', async () => {
    const result = await barrel.deleteShoppingListItems('list-1', []);

    // A batch opened and committed with nothing between it: the writer does not
    // short-circuit on an empty selection, and Firestore is content with that.
    expect(h.ops).toEqual([{ op: 'batch' }, { op: 'commit' }]);
    expect(result).toEqual({ kind: 'ok', value: undefined });
  });
});

describe('recordCanonPurchases — the empty gesture (#726)', () => {
  it('writes nothing and still succeeds when every ticked row was unmatched', async () => {
    const result = await barrel.recordCanonPurchases([]);

    expect(h.ops).toEqual([]);
    expect(result).toEqual({ kind: 'ok', value: undefined });
  });
});
