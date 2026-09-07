/**
 * The subscription contract — every exported `subscribe*`, one table (#928).
 *
 * ─── What this file is for ───────────────────────────────────────────────────
 * #941 measured `firebase-sync` as the sharpest risk in the #913 programme:
 * worst coverage in the repo (51.3% lines), worst scaffolding ratio (15.2 lines
 * per assertion), highest duplication (62.2%), and 36% of its assertions
 * checking only that a mock was called. Three refactors land on these files
 * (#928 consolidation, #931 the writer error contract, #939 query narrowing) and
 * before this suite existed the tests would not have noticed if any of them
 * broke a subscription.
 *
 * This is the characterisation net for all three. It runs against the real
 * Firestore emulator, so it pins OBSERVABLE BEHAVIOUR — what a subscriber
 * receives — and not the shape of the code that produces it. That is the whole
 * point: a net written against mocked `onSnapshot` calls re-breaks the moment
 * the consolidation changes which module calls it, which is precisely the noise
 * that stalls a refactor.
 *
 * ─── Why a table and not 28 describe blocks ──────────────────────────────────
 * #928's finding is that these modules are one file copied 13 times. A test
 * suite that copies its body 28 times would be the same defect, one level up —
 * and would leave the next subscription uncovered by default. The table inverts
 * that: a new subscription is a row, and `covers every exported subscribe*`
 * below FAILS until the row exists. That guard is derived from the barrel, never
 * from a hand-kept list (docs/unit-test-spec.md UT-E1/UT-E2).
 *
 * ─── The two families ────────────────────────────────────────────────────────
 * Every subscription is `(...keys, onData, onError) => unsubscribe`, and splits
 * by what it delivers:
 *   • COLLECTION — an array (or a Map) of documents. A corrupt document is
 *     skipped and the valid subset is still delivered.
 *   • DOCUMENT   — one `T | null`. An absent document delivers `null`; a corrupt
 *     one is a `StorageError`/`corruption` on `onError`.
 * Those two rules are the CLAUDE.md adapter contract, and the table asserts them
 * uniformly rather than trusting 28 files to have implemented them the same way.
 *
 * ─── What pins #939 (query narrowing) ────────────────────────────────────────
 * EVERY row seeds a fixed, complete world and asserts EXACTLY what comes out of
 * it: `toEqual` over the whole delivered id list on a collection row, and "every
 * delivery is either absent or THIS document" on a single-document one — never
 * the membership check (`toContain`, `.includes`) an earlier cut used, which one
 * more document in the answer satisfies just as happily. The world always has
 * two halves: the documents the subscription must return (`seed` plus, where a
 * second in-bounds document is possible, `alsoDelivers`) and at least one decoy
 * it must not (`excluded`, required on all 28 rows).
 *
 * That is the whole mechanism. Adding ANY narrowing to ANY subscription — a
 * `where`, a `limit`, a tighter path, a different document key — changes the
 * delivered set, and the row that owns it goes red with no test edit, whatever
 * shape the code has taken by then and wherever the constraint literal ends up
 * living. It is what the `ordered` rows already do for order, generalised to
 * membership.
 *
 * An earlier cut of this file tried to do the same job by reading `src/*.ts` as
 * TEXT and attributing each `where(`/`orderBy(`/`limit(` to the `subscribe*`
 * above it. That was deleted, and must not come back. It could not survive the
 * refactor it existed to guard: hoisting the constraints into a shared
 * descriptor — the most literal reading of #928's "a new collection means a
 * call, not a file" — left the walk reporting NO operators for a subscription
 * that still issued a `where`, so the guard went vacuously green exactly where
 * it was needed. It also broke on `export const subscribeX = …` and on the
 * modules simply moving into a subdirectory, and the only repair for either was
 * to edit this file — which is precisely what the consolidation commit is
 * forbidden to do. And it contradicted the paragraph above: a source-text shape
 * assertion is the thing this net exists NOT to be.
 *
 * The exact-set rule is also strictly stronger than that walk ever was. It sees
 * subcollection-path bounds and document-key bounds, which no scan for
 * `where(` can.
 *
 * The decoy a row seeds is chosen for what its own query could get wrong:
 *
 *   an owner filter        a document owned by someone else
 *   a documentId() range   the day either side of the inclusive bounds
 *   a subcollection path   the same document under a DIFFERENT parent
 *   a keyed document read  a valid, distinguishable document at another key
 *   an unfiltered read     a valid document one level deeper, in a subcollection
 *                          of the SAME NAME — the one thing a `collection()`
 *                          read must exclude and a `collectionGroup()` read
 *                          would not, which is a one-word difference in a helper
 *                          parameterised by collection name
 *
 * ─── The corrupt-document rows assert a REJECTION, not an absence ────────────
 * Every collection parse loop `console.error`s `Document {id} failed validation`
 * before skipping. The corrupt row asserts that log, because "the valid subset
 * was delivered and 'bad' was not in it" is ALSO satisfied by a corrupt document
 * the query never surfaced — which is exactly how the first cut of
 * `subscribeBatchObservations` passed: `CORRUPT` carried no `at`, and Firestore
 * excludes a document missing the ordered field, so nothing was ever skipped.
 * The log assertion turns that silent pass into a red.
 *
 * EVERY single-document row asserts that same bound log, and answers a refused
 * document the same way, and that is #928's doing rather than this file's. This
 * table used to carry an `onCorrupt` field recording two divergences it had
 * found: eight of fourteen reads logged nothing (`logsRejection`, finding
 * B2-008), and two answered a refusal with `null` rather than a `Failure`.
 * Phase 1 deleted the first and Phase 2 the second, so there is one outcome to
 * assert and it is asserted on all thirteen rows — strictly more than this file
 * asserted before, from a table with one fewer axis.
 *
 * The log is worth binding to a document id for the same reason it is on the
 * collection rows, and NOT for the reason an earlier cut of this file gave.
 * That cut claimed a `StorageError`/`corruption` on `onError` cannot be produced
 * by a document the read never saw; that is false.
 * `firestoreErrors.ts` maps the Firestore code `data-loss` to exactly
 * `{kind:'StorageError', reason:'corruption'}`, and every row passes stream
 * errors through `classifyFirestoreError`, so a stream-level `data-loss`
 * satisfies the error assertion with no document read at all. `Document {id}
 * failed validation` cannot be: it is emitted only by the parse.
 *
 * The second discriminator is `rawError`, and it is now real on every row rather
 * than on six of them. The stream path is `onError(classifyFirestoreError(err),
 * err)` — two arguments — and the parse path is
 * `onError({kind:'StorageError', reason:'corruption'})` — one. Phase 1 widened
 * the eight one-argument `onError` declarations (finding B2-009), so a row
 * asserting "no `rawError` arrived" is a claim every module is now capable of
 * falsifying, where on seven of them it used to be vacuously true. Asserted
 * uniformly rather than from a hand-kept list (UT-E1).
 *
 * Each row also asserts that NOTHING was delivered for the refused document.
 * That is the assertion Phase 2 bought: `subscribeCookSession` and
 * `subscribeKitchenTimers` used to hand the caller a `null`, which is what an
 * absent document hands it, so a corrupt cook session read as one that had been
 * ended on another device.
 *
 * ─── Seeding goes through the emulator's REST door, not a client ─────────────
 * Every row seeds with `seed()`, which writes through the Firestore emulator's
 * REST API with `Authorization: Bearer owner` — the same rules-bypassing door
 * `clearFirestoreEmulator` already uses, and the pre-boot REST seeding #721
 * established for e2e.
 *
 * This is a deliberate correction of the obvious approach (a second Firebase
 * client), which was tried first and does not work uniformly: firestore.rules
 * closes CLIENT writes to `equipmentIcons` and `weatherForecast` entirely
 * (`allow write: if false` — the Admin SDK writes them), gates `appSettings`,
 * `devSettings` and `members` behind `isAdmin()`, and requires the writer to BE
 * the owner for `chatSessions`, `cookSessions` and `kitchenTimers`. Eight of the
 * 28 could therefore never be seeded client-side, and a table with eight
 * exceptions is not a table.
 *
 * The important part is that this costs the suite nothing it needs. Reads are
 * uniformly `allow read: if request.auth != null`, so the subscriber is a normal
 * signed-in client in every row; only the seed takes the back door. What the
 * table pins is the READ contract — what a subscriber receives — and a
 * REST-written document reaches it through exactly the same `onSnapshot` path as
 * another client's write. Cross-client convergence proper, and the write path,
 * stay covered by realtimeSubscriptions.emulator.test.ts.
 *
 * Requires the isolated Vitest emulator stack; run via `pnpm test:emulator`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import type { DomainError } from '@salt/shared-types';
import * as barrel from '../src/index.js';
import { clearFirestoreEmulator, resetDefaultApp, PROJECT_ID } from './emulatorHelpers.js';

import { subscribeAisles } from '../src/aisleSubscription.js';
import { subscribeAppSettings } from '../src/appSettingsSync.js';
import { subscribeBatch, subscribeBatches } from '../src/batchSync.js';
import { subscribeBatchObservations } from '../src/batchObservationSync.js';
import { subscribeCanonItems } from '../src/canonSubscription.js';
import { subscribeChatSessions } from '../src/chatSessionSubscription.js';
import { subscribeCookSession, subscribeMyCookSessions } from '../src/cookSessionSubscription.js';
import { subscribeDevSettings } from '../src/devSettingsSync.js';
import { subscribeEquipmentIcons } from '../src/equipmentIconSubscription.js';
import { subscribeEquipmentManifest } from '../src/equipmentManifestSubscription.js';
import { subscribeFormula } from '../src/formulaSubscription.js';
import { subscribeGuidedPlan } from '../src/guidedPlanSubscription.js';
import { subscribeKitchenMemories } from '../src/kitchenMemorySubscription.js';
import { subscribeKitchenTimers } from '../src/kitchenTimerSubscription.js';
import { subscribeKitchenTools } from '../src/kitchenToolSubscription.js';
import {
  subscribeMealPlanConfig,
  subscribeMealPlanTemplate,
  subscribeMealPlanWeek,
} from '../src/mealPlanSync.js';
import { subscribeMembers } from '../src/membersSubscription.js';
import { subscribeProductForms } from '../src/productFormSubscription.js';
import { subscribeRecipes } from '../src/recipeSubscription.js';
import { subscribeShoppingDaysInRange } from '../src/shoppingDaySync.js';
import { subscribeShoppingListItems } from '../src/shoppingListItemSubscription.js';
import { subscribeShoppingLists } from '../src/shoppingListSubscription.js';
import { subscribeShoppingListsConfig } from '../src/shoppingListsConfigSubscription.js';
import { subscribeWeatherForecast } from '../src/weatherSync.js';

// ─── Harness ────────────────────────────────────────────────────────────────
// There is deliberately no second Firebase client here — seeding goes through
// the REST door (see the header), so the only SDK client in this file is the
// one under test.
//
// ─── Why the client is rebuilt per TEST ────────────────────────────────────
// `clearFirestoreEmulator` goes through the REST door, so it wipes the SERVER
// and cannot reach the SDK's local cache. That cache is the isolation boundary
// here: a listener attached after a REST clear still raises its first,
// `fromCache` snapshot from whatever the client learned in the previous test,
// because nothing told the client those documents were gone. Rebuilding the app
// per describe BLOCK was tried and is wrong for exactly that reason — 14 of the
// 15 collection blocks failed `delivers an empty list when the collection is
// empty` with the PREVIOUS test's document in the first snapshot. Data
// isolation is not a property of the clear; it is a property of the clear plus
// a fresh client.
//
// The rebuild also contains a poisoned Listen channel to the test that poisoned
// it, which is why `realtimeSubscriptions.emulator.test.ts` does the same in
// `beforeEach` (#319/#122) — but do not read that as this file's flake defence,
// because it measurably is not. Per-block and per-test shapes both hit
// #122 about once a run, so the number of client rebuilds is not what drives it.
// The note on the corrupt-document row below records one write pattern that
// reproduced it on demand, and removing that pattern was worth doing — but it is
// NOT the whole cause, and the row's claim that it is has now been falsified.
//
// AND DO NOT REACH FOR #122 TO EXPLAIN A TIMEOUT. Two CI runs of this file
// (32845375930, 32856731377) each failed exactly two rows, always on
// `delivers the document after it is written` and never on another test:
// subscribeBatch + subscribeMealPlanTemplate, then subscribeDevSettings +
// subscribeWeatherForecast. #122 was present in the first run and ENTIRELY
// ABSENT from the second — zero `RESOURCE_EXHAUSTED`, zero stream errors — so
// it cannot be the cause of a failure that reproduced identically both times.
// The real cause was that that row alone wrote without settling its listener
// first; the fix and the reasoning are on the row itself.
//
// #122 is still real, and one thing that run did settle is worth keeping: gRPC
// reported `RESOURCE_EXHAUSTED: Received message larger than max (1650553701 vs
// 17825792)`, and 1650553701 is 0x62617365 — the four ASCII bytes `base`. The
// client is not being sent a 1.65 GB message; it is reading a length prefix out
// of the middle of a payload string (`…/databases/…`), which is a FRAMING
// DESYNC in the message deframer, downstream of anything this suite writes.
// Firestore treats `resource-exhausted` as retryable, so the client goes to
// maximum backoff rather than surfacing anything on `onError` — which is why,
// when it DOES bite, it looks exactly like the bug fixed above and will be
// mistaken for it again. Two facts bound a real fix: the SDK's node build always
// uses `GrpcConnection` (`newConnection` has no long-polling branch at all), so
// no `experimentalForceLongPolling` setting can move it; and `grpcFlowControlWindow`
// (Firestore settings, node only, default 256 KB) is the one knob that reaches
// the deframer.
//
// This suite has NO retries and must not gain any (see vitest.emulator.config.ts
// and docs/unit-test-spec.md UT-G3). If it flakes, the fix is here or in the
// transport, never a retry.

const CONVERGENCE_MS = 15_000;
/** Cold-stack warm-up ceiling. Under vitest.emulator.config.ts's 30 s hookTimeout. */
const WARMUP_MS = 25_000;
const _env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const FIRESTORE_PORT = Number(_env['VITE_EMULATOR_FIRESTORE_PORT'] ?? 8080);

// Order matters: wipe the server first, then hand the test a client that has
// never seen the wiped data. The reverse leaves the fresh client's first read
// racing the delete.
beforeEach(async () => {
  await clearFirestoreEmulator();
  await resetDefaultApp();
});

// The corrupt rows spy on `console.error` (the rejection signal — see the
// header). Files share a worker and `isolate: false` keeps module state alive
// across them, so an unrestored spy would land on an unrelated file and read as
// flake (docs/unit-test-spec.md UT-F4).
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Pay the emulator's cold-start cost once, here, instead of charging it to
 * whichever row happens to run first.
 *
 * `docker compose up --wait` gates on the container healthcheck, which probes
 * the emulator's REST surface. The gRPC Listen path that healthcheck never
 * touches is cold on the first attach of a run: measured on a freshly
 * `down -v`/`up` stack, the first subscription to receive a snapshot took over
 * 15 s while every one after it took 65-190 ms. Without this hook that lands as
 * a convergence timeout on row 1 — `subscribeAisles`, which is why that name
 * keeps appearing in flake reports — and reads as a broken subscription when it
 * is nothing of the kind. It is the cold-start dominance #734 measured for e2e
 * (~47% failure cold vs ~0.6% warm) arriving in this suite.
 *
 * This is NOT a widened budget, which UT-F1 forbids: CONVERGENCE_MS stays at
 * 15 s and every row still has to meet it. The hook only moves an environmental
 * cost out of a measurement that was never about it, and a genuinely dead
 * emulator now fails HERE — naming the stack — instead of blaming a row.
 */
beforeAll(async () => {
  await resetDefaultApp();
  const seen: unknown[] = [];
  const stop = subscribeAisles(
    (aisles) => seen.push(aisles),
    (err) => seen.push(err),
  );
  try {
    await waitFor(
      () => seen.length > 0,
      WARMUP_MS,
      'the emulator to answer the first Listen of the run (cold gRPC stack)',
    );
  } finally {
    stop();
  }
});

/** The uid the SUBSCRIBING app is signed in as. Only valid inside a test. */
function ownerUid(): string {
  const uid = getAuth(getApp()).currentUser?.uid;
  if (!uid) throw new Error('default app is not signed in');
  return uid;
}

/**
 * Convert a plain JS value to the Firestore REST `Value` union.
 *
 * Integers and doubles are distinct Firestore types and zod cares: a
 * `schemaVersion: 1` written as a double reads back as 1 and still parses, but
 * an `order: 0` written as a string would not. Keep the mapping total — an
 * unhandled type must throw here rather than silently seed a document the
 * subscription then skips as invalid, which would look like a delivery failure.
 */
function toRestValue(v: unknown): Record<string, unknown> {
  if (v === null) return { nullValue: null };
  switch (typeof v) {
    case 'string':
      return { stringValue: v };
    case 'boolean':
      return { booleanValue: v };
    case 'number':
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    case 'object':
      if (Array.isArray(v)) return { arrayValue: { values: v.map(toRestValue) } };
      return { mapValue: { fields: toRestFields(v as Record<string, unknown>) } };
    default:
      throw new Error(`no Firestore REST mapping for ${typeof v}`);
  }
}

function toRestFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, toRestValue(v)]),
  );
}

/**
 * Seed one document through the emulator's REST API, bypassing security rules.
 * See the header: eight of the 28 collections are closed to client writes, so
 * this is the only door that seeds all of them the same way.
 */
async function writeAs(path: string[], data: Record<string, unknown>): Promise<void> {
  const url =
    `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}` +
    `/databases/(default)/documents/${path.join('/')}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: toRestFields(data) }),
  });
  if (!resp.ok) {
    throw new Error(
      `REST seed of ${path.join('/')} failed: HTTP ${resp.status} ${await resp.text()}`,
    );
  }
}

/**
 * `waitFor`'s poll tick, and nothing else. No test in this file sleeps to let
 * something happen — every wait is on an observed signal (UT-F3).
 */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `predicate` holds. On timeout the message carries whatever the
 * subscription reported to `onError` — without that, a schema mismatch in a
 * fixture and a genuine delivery failure produce the identical bare "timed out",
 * which is the difference between a five-minute fix and an afternoon.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  errors: DomainError[] = [],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const reported = errors.length ? ` — onError reported ${JSON.stringify(errors)}` : '';
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${reported}`);
    }
    await tick(50);
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Minimal documents that satisfy their schema. Every one was derived from the
// schema itself rather than hand-guessed, so a required field added upstream
// fails this suite loudly instead of silently skipping the doc as invalid.

const NOW = '2026-08-24T00:00:00.000Z';

/**
 * Structurally invalid for EVERY schema: the id/discriminant fields are wrong types.
 *
 * NOT sufficient on its own. A corrupt document only exercises the skip path if
 * the subscription's QUERY returns it, and Firestore excludes a document that is
 * missing the ordered field entirely — so a row whose query carries an `orderBy`
 * must spread this over a document that still has that field
 * (`subscribeBatchObservations` and its `at`), and a row with a `where` must keep
 * the filtered field valid (`chatSessions`/`cookSessions` and their `ownerUid`).
 * The corrupt rows assert the rejection LOG for exactly this reason.
 */
const CORRUPT = { id: 42, schemaVersion: 'not-a-number', updatedAt: false } as const;

// Marks that make a keyed row's own document distinguishable from an equally
// VALID decoy at another key in the same collection. Without one, a singleton
// row matching on `schemaVersion: 1` would accept the decoy and prove nothing.
const MODEL_MARK = 'the-model-under-test';
const TEMPLATE_MARK = 'the template under test';
const AISLE_ID = 'produce';
const DECOY_AISLE_ID = 'decoy-aisle';

/**
 * The parent and the id of the decoy an UNFILTERED collection row seeds: a valid
 * document one level deeper, in a subcollection of the SAME NAME as the
 * collection under test. `collection(db, 'recipes')` must not return it;
 * `collectionGroup(db, 'recipes')` would — and that is a one-word difference in a
 * helper parameterised by collection name, which is exactly the shape #928 is
 * heading for. The parent id is one the collection itself never holds, so a
 * phantom parent would show up in the delivered set too.
 */
const DECOY_PARENT = 'decoy-parent';
const NESTED_DECOY_ID = 'nested-decoy';
const nestedPath = (collectionName: string): string[] => [
  collectionName,
  DECOY_PARENT,
  collectionName,
  NESTED_DECOY_ID,
];
const NESTED_DECOY_WHAT =
  'a document nested in a subcollection of the same name — a collection read, never a collection-group read';

const fx = {
  aislesDoc: (ids: string[]) => ({
    schemaVersion: 1,
    updatedAt: NOW,
    aisles: ids.map((id, order) => ({ id, name: `Aisle ${id}`, order })),
  }),
  batch: (id: string) => ({
    id,
    schemaVersion: 1,
    recipeId: 'r1',
    recipeTitle: 'Sourdough',
    state: 'running',
    quantities: [],
    totals: {
      basisGrams: 1,
      totalGrams: 1,
      usableGrams: 1,
      units: { count: 1, unitDoughGrams: 1 },
    },
    stages: [],
    rationale: 'x',
    createdAt: NOW,
    updatedAt: NOW,
  }),
  batchObservation: (id: string, at: string = NOW) => ({
    id,
    schemaVersion: 1,
    at,
    weightGrams: 0,
    ph: 0,
    temperatureC: 0,
    note: 'x',
    image: { url: 'https://example.test/x.webp', source: 'upload' },
  }),
  // `embedding` is omitted unless a caller asks for one: the projection row is
  // the only place that wants an inline vector, because dropping it is an
  // observable per-subscription transform (#410 — see that row).
  canonItem: (id: string, embedding?: number[]) => ({
    id,
    schemaVersion: 5,
    name: 'Carrot',
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: NOW,
    ...(embedding ? { embedding } : {}),
  }),
  /**
   * The REAL sibling of `canonData/aisles` (issue #726). Nothing parses it here;
   * it is seeded so `subscribeAisles` has the neighbour its collection actually
   * holds, and a read that widened past its key would surface it as a corruption
   * error the row already forbids.
   */
  purchaseCounts: () => ({ counts: {}, lastAt: {} }),
  chatSession: (id: string, uid: string) => ({
    id,
    schemaVersion: 1,
    ownerUid: uid,
    recipeId: null,
    title: 'Chat',
    messages: [],
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW,
  }),
  cookSession: (id: string, uid: string, updatedAt: string = NOW) => ({
    id,
    schemaVersion: 1,
    ownerUid: uid,
    recipeId: 'r1',
    recipeUpdatedAtAtStart: NOW,
    createdAt: NOW,
    updatedAt,
  }),
  equipmentIcon: () => ({
    subjectBrief: 'a steel pan',
    briefSourceName: 'pan',
    thumbnail: 'https://example.test/x.webp',
  }),
  equipmentManifest: (updatedAt: string = NOW) => ({ schemaVersion: 1, updatedAt, items: [] }),
  formula: (recipeId: string) => ({
    recipeId,
    components: [],
    referenceYield: { kind: 'basis', grams: 1 },
  }),
  guidedPlan: (id: string) => ({
    id,
    schemaVersion: 1,
    recipeId: id,
    recipeUpdatedAtAtSave: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }),
  kitchenMemory: (id: string) => ({
    id,
    text: 'salt the pasta water',
    author: 'D',
    createdAt: NOW,
  }),
  kitchenTimers: (uid: string) => ({ ownerUid: uid, timers: [] }),
  kitchenTool: (id: string) => ({
    id,
    schemaVersion: 1,
    label: 'Whisk',
    matchers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }),
  mealPlanConfig: (firstDayOfWeek: string = 'fri') => ({ firstDayOfWeek, schemaVersion: 1 }),
  // `days.mon.note` carries the mark, because `schemaVersion` is the only other
  // field and a literal 1 cannot tell this document from a decoy at another key.
  mealPlanTemplate: (note: string = TEMPLATE_MARK) => ({
    schemaVersion: 1,
    days: { mon: { note, recipeIds: [], chefs: [], attendees: [], guests: 0 } },
  }),
  mealPlanWeek: (startDate: string) => ({
    id: startDate,
    schemaVersion: 1,
    startDate,
    days: {},
    updatedAt: NOW,
  }),
  member: (id: string) => ({
    id,
    schemaVersion: 1,
    name: 'Daniel',
    email: 'a@b.test',
    admin: false,
    sortOrder: 0,
    updatedAt: NOW,
  }),
  productForm: (id: string) => ({
    id,
    schemaVersion: 1,
    matchers: [],
    parentCanonId: 'canon-1',
    label: 'Yolk',
    yield: { formUnit: 'g', amountPerParent: 1 },
    updatedAt: NOW,
  }),
  recipe: (id: string) => ({
    id,
    schemaVersion: 1,
    title: 'Toast',
    description: '',
    ingredients: [],
    steps: [],
    metadata: {
      servings: 1,
      tags: [],
    },
    source: { type: 'manual' },
    notes: '',
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
  }),
  shoppingDay: (date: string) => ({ date, slot: 'am', setBy: 'x', setAt: NOW }),
  shoppingList: (id: string) => ({
    id,
    name: 'Weekly',
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }),
  shoppingListItem: (id: string) => ({
    id,
    rawText: 'carrots',
    notes: '',
    sources: [],
    canonId: null,
    matchState: 'pending',
    checked: false,
    needsCheck: false,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }),
  shoppingListsConfig: (defaultListId: string) => ({ defaultListId, schemaVersion: 1 }),
  weatherForecast: (timezone: string = 'Europe/London') => ({
    days: {},
    fetchedAt: 1,
    location: { latitude: 0, longitude: 0, timezone, label: 'London' },
    timezone,
  }),
  // `fast` is a free-text model name with a schema default, so it is the field
  // that can tell this document from an equally valid one at another key.
  appSettings: (fast: string = MODEL_MARK) => ({ schemaVersion: 1, fast }),
  devSettings: (canonIconGenerationEnabled = true) => ({
    schemaVersion: 1,
    canonIconGenerationEnabled,
  }),
};

// ─── The tables ─────────────────────────────────────────────────────────────

type ErrCb = (err: DomainError, rawError?: unknown) => void;

interface CollectionCase {
  name: string;
  /** Subscribe, normalising whatever is delivered to a list of ids. */
  subscribe: (onIds: (ids: string[]) => void, onError: ErrCb) => () => void;
  /** The id the seeded document will be recognised by. */
  id: string;
  /** Seed the valid document. */
  seed: () => Promise<void>;
  /**
   * Seed a structurally invalid sibling, and NAME it. Omitted only where the
   * subscription reads a SINGLE document holding an array, so a corrupt entry
   * fails the whole document rather than being skipped — the reason is the
   * string.
   *
   * `id` is the document id the subscription's parse loop logs on rejection, and
   * the row asserts that log. It must be an id the query actually RETURNS: see
   * the note on `CORRUPT`.
   */
  /**
   * Further documents the subscription MUST deliver, seeded BEFORE the listener
   * attaches (`seed` stays the single live write — see the corrupt row's note on
   * #122). Present wherever a second in-bounds document is possible, because the
   * exact-set assertion is what makes a future `limit` or `where` cost
   * something: with one document seeded, `limit(1)` is invisible.
   *
   * Absent only where the subscription reads ONE document that holds the whole
   * array, so there is no second document to add — the reason is written on the
   * row.
   */
  alsoDelivers?: { ids: string[]; seed: () => Promise<void> };
  /**
   * The exact set `seed()` alone produces, when that is more than `[id]`. Only
   * `subscribeAisles` needs it: its one document holds the whole array, so the
   * second in-bounds entry cannot be a separate write.
   */
  seedDelivers?: string[];
  corrupt?: { id: string; seed: () => Promise<void> };
  noCorruptCase?: string;
  /**
   * Seed the documents this subscription must LEAVE OUT, and name their ids.
   * REQUIRED on every row: a row that seeds only what its query admits pins
   * nothing about the query, and every narrowing #939 could add would pass
   * unnoticed. See the header for which decoy each shape of query gets.
   */
  excluded: { ids: string[]; what: string; seed: () => Promise<void> };
  /**
   * A per-subscription transform on the delivered DOCUMENTS that no list of ids
   * can see. Only canon has one today (#410), and a consolidated parse loop is
   * exactly what would drop it silently.
   */
  projection?: {
    what: string;
    seed: () => Promise<void>;
    subscribe: (onDocs: (docs: unknown[]) => void, onError: ErrCb) => () => void;
    assert: (docs: unknown[]) => void;
  };
  /**
   * Seed documents whose DELIVERED order the query fixes, and name that order
   * exactly. Only for rows carrying an `orderBy` (and, for cook sessions, a
   * `limit` — the expected list is shorter than what is seeded, which pins both
   * in one row). The seeded ids are chosen so Firestore's default `__name__`
   * ordering would give a DIFFERENT answer, or dropping the `orderBy` would
   * still pass.
   */
  ordered?: { ids: string[]; seed: () => Promise<void>; what: string };
}

const LIST_ID = 'list-1';
const OTHER_LIST_ID = 'list-2';
const BATCH_ID = 'batch-1';
const OTHER_BATCH_ID = 'batch-2';
const WEEK_START = '2026-08-21';
const OTHER_WEEK_START = '2026-08-14';
const RANGE_START = '2026-08-17';
const RANGE_END = '2026-08-23';
/** A uid that is never the subscriber's — every owner-filtered row seeds one of these. */
const OTHER_UID = 'not-the-subscriber';

const collectionCases: CollectionCase[] = [
  {
    name: 'subscribeAisles',
    subscribe: (on, err) => subscribeAisles((aisles) => on(aisles.map((a) => a.id)), err),
    id: AISLE_ID,
    // TWO aisles in the one document, so a narrowing applied to the ARRAY (a
    // filter or a slice inside the parse) changes the delivered set the same way
    // a `limit` would on the collection rows.
    seed: () => writeAs(['canonData', 'aisles'], fx.aislesDoc([AISLE_ID, 'dairy'])),
    seedDelivers: [AISLE_ID, 'dairy'],
    noCorruptCase:
      'reads ONE document holding the whole array, so a corrupt entry fails the document rather than being skipped past',
    // Two decoys, because this row reads one KEYED document out of a collection
    // that really does hold siblings. `canonData/purchaseCounts` is the sibling
    // production has (#726): nothing here parses it, and a read that widened past
    // its key would deliver it to `AislesDocumentSchema` and surface the
    // corruption error this row forbids. `canonData/aisles-decoy` is a VALID
    // aisles document at another key, so a read at the WRONG key delivers
    // `decoy-aisle` and the exact-set assertion names it.
    excluded: {
      ids: [DECOY_AISLE_ID],
      what: 'the aisles under another canonData key, or the purchase counts beside them',
      seed: async () => {
        await writeAs(['canonData', 'purchaseCounts'], fx.purchaseCounts());
        await writeAs(['canonData', 'aisles-decoy'], fx.aislesDoc([DECOY_AISLE_ID]));
      },
    },
  },
  {
    name: 'subscribeBatches',
    subscribe: (on, err) => subscribeBatches((batches) => on(batches.map((b) => b.id)), err),
    id: BATCH_ID,
    seed: () => writeAs(['batches', BATCH_ID], fx.batch(BATCH_ID)),
    alsoDelivers: {
      ids: ['batch-3'],
      seed: () => writeAs(['batches', 'batch-3'], fx.batch('batch-3')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['batches', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('batches'), fx.batch(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeBatchObservations',
    subscribe: (on, err) =>
      subscribeBatchObservations(BATCH_ID, (obs) => on(obs.map((o) => o.id)), err),
    id: 'obs-1',
    seed: () =>
      writeAs(['batches', BATCH_ID, 'observations', 'obs-1'], fx.batchObservation('obs-1')),
    alsoDelivers: {
      ids: ['obs-0'],
      seed: () =>
        writeAs(
          ['batches', BATCH_ID, 'observations', 'obs-0'],
          fx.batchObservation('obs-0', '2026-08-23T00:00:00.000Z'),
        ),
    },
    // `at` is NOT decoration here. The query is `orderBy('at','asc')` and
    // Firestore omits a document missing the ordered field, so a corrupt sibling
    // without one is never returned — nothing is skipped, and the row would go
    // green on an INVISIBLE document rather than a rejected one. `id: 42` is what
    // still fails the schema.
    corrupt: {
      id: 'bad',
      seed: () => writeAs(['batches', BATCH_ID, 'observations', 'bad'], { ...CORRUPT, at: NOW }),
    },
    // The log belongs to ONE run. An observation under another batch is a
    // different subcollection and must never appear.
    excluded: {
      ids: ['other-obs'],
      what: "another run's observations",
      seed: () =>
        writeAs(
          ['batches', OTHER_BATCH_ID, 'observations', 'other-obs'],
          fx.batchObservation('other-obs'),
        ),
    },
    // Ordered by WHEN THE READING WAS TAKEN, not by arrival or by id — the whole
    // point of the module's own comment. `obs-a` is later than `obs-b`, so id
    // order and `at` order disagree and only the real `orderBy` gives this answer.
    ordered: {
      what: "orderBy('at','asc') — oldest reading first, whatever the ids say",
      ids: ['obs-b', 'obs-a'],
      seed: async () => {
        await writeAs(
          ['batches', BATCH_ID, 'observations', 'obs-a'],
          fx.batchObservation('obs-a', '2026-08-24T03:00:00.000Z'),
        );
        await writeAs(
          ['batches', BATCH_ID, 'observations', 'obs-b'],
          fx.batchObservation('obs-b', '2026-08-24T01:00:00.000Z'),
        );
      },
    },
  },
  {
    name: 'subscribeCanonItems',
    subscribe: (on, err) => subscribeCanonItems((items) => on(items.map((i) => i.id)), err),
    id: 'carrot',
    seed: () => writeAs(['canonItems', 'carrot'], fx.canonItem('carrot')),
    alsoDelivers: {
      ids: ['onion'],
      seed: () => writeAs(['canonItems', 'onion'], fx.canonItem('onion')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['canonItems', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('canonItems'), fx.canonItem(NESTED_DECOY_ID)),
    },
    // The one per-subscription transform in the table that a list of ids cannot
    // see: `canonSubscription.ts` overwrites `embedding` with null on every
    // delivered item, so an un-migrated document's inline vector (#410) never
    // reaches the in-memory store — and a client edit cannot write one back.
    // A consolidated parse loop that just returned `result.data` would drop this
    // silently, which is exactly what a characterisation net is for.
    projection: {
      what: 'strips the server-only embedding vector off every item it delivers (#410)',
      seed: () => writeAs(['canonItems', 'carrot'], fx.canonItem('carrot', [0.25, 0.5, 0.75])),
      subscribe: (onDocs, err) => subscribeCanonItems((items) => onDocs(items), err),
      assert: (docs) => {
        expect(docs.map((d) => (d as { embedding?: unknown }).embedding)).toEqual([null]);
      },
    },
  },
  {
    name: 'subscribeChatSessions',
    subscribe: (on, err) =>
      subscribeChatSessions(ownerUid(), (sessions) => on(sessions.map((s) => s.id)), err),
    id: 'chat-1',
    seed: () => writeAs(['chatSessions', 'chat-1'], fx.chatSession('chat-1', ownerUid())),
    alsoDelivers: {
      ids: ['chat-2'],
      seed: () => writeAs(['chatSessions', 'chat-2'], fx.chatSession('chat-2', ownerUid())),
    },
    // The corrupt sibling must still be OWNED by the subscriber, or the query's
    // `where('ownerUid','==',uid)` filters it out server-side and the row would
    // prove nothing about skip-invalid.
    corrupt: {
      id: 'bad',
      seed: () => writeAs(['chatSessions', 'bad'], { ...CORRUPT, ownerUid: ownerUid() }),
    },
    excluded: {
      ids: ['chat-theirs'],
      what: "the other member's chat history",
      seed: () =>
        writeAs(['chatSessions', 'chat-theirs'], fx.chatSession('chat-theirs', OTHER_UID)),
    },
  },
  {
    name: 'subscribeMyCookSessions',
    subscribe: (on, err) =>
      subscribeMyCookSessions(ownerUid(), (sessions) => on(sessions.map((s) => s.id)), err),
    id: 'cook-1',
    seed: () => writeAs(['cookSessions', 'cook-1'], fx.cookSession('cook-1', ownerUid())),
    alsoDelivers: {
      ids: ['cook-2'],
      seed: () => writeAs(['cookSessions', 'cook-2'], fx.cookSession('cook-2', ownerUid())),
    },
    corrupt: {
      id: 'bad',
      seed: () => writeAs(['cookSessions', 'bad'], { ...CORRUPT, ownerUid: ownerUid() }),
    },
    excluded: {
      ids: ['cook-theirs'],
      what: "the other member's cook in progress",
      seed: () =>
        writeAs(['cookSessions', 'cook-theirs'], fx.cookSession('cook-theirs', OTHER_UID)),
    },
    // Six sessions, five delivered: this one row pins `orderBy('updatedAt','desc')`
    // AND `limit(5)`. The ids ascend with the timestamps, so the default
    // `__name__` order would deliver s1..s5 — the complement of the right answer
    // in both membership and order.
    ordered: {
      what: "orderBy('updatedAt','desc') + limit(5) — the five most recent, newest first",
      ids: ['s6', 's5', 's4', 's3', 's2'],
      seed: async () => {
        const uid = ownerUid();
        for (let i = 1; i <= 6; i += 1) {
          await writeAs(
            ['cookSessions', `s${i}`],
            fx.cookSession(`s${i}`, uid, `2026-08-24T00:00:0${i}.000Z`),
          );
        }
      },
    },
  },
  {
    name: 'subscribeEquipmentIcons',
    subscribe: (on, err) => subscribeEquipmentIcons((icons) => on([...icons.keys()]), err),
    id: 'pan',
    seed: () => writeAs(['equipmentIcons', 'pan'], fx.equipmentIcon()),
    alsoDelivers: {
      ids: ['pot'],
      seed: () => writeAs(['equipmentIcons', 'pot'], fx.equipmentIcon()),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['equipmentIcons', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('equipmentIcons'), fx.equipmentIcon()),
    },
  },
  {
    name: 'subscribeKitchenMemories',
    subscribe: (on, err) => subscribeKitchenMemories((mems) => on(mems.map((m) => m.id)), err),
    id: 'mem-1',
    seed: () => writeAs(['kitchenMemories', 'mem-1'], fx.kitchenMemory('mem-1')),
    alsoDelivers: {
      ids: ['mem-2'],
      seed: () => writeAs(['kitchenMemories', 'mem-2'], fx.kitchenMemory('mem-2')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['kitchenMemories', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('kitchenMemories'), fx.kitchenMemory(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeKitchenTools',
    subscribe: (on, err) => subscribeKitchenTools((tools) => on(tools.map((t) => t.id)), err),
    id: 'whisk',
    seed: () => writeAs(['kitchenTools', 'whisk'], fx.kitchenTool('whisk')),
    alsoDelivers: {
      ids: ['spatula'],
      seed: () => writeAs(['kitchenTools', 'spatula'], fx.kitchenTool('spatula')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['kitchenTools', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('kitchenTools'), fx.kitchenTool(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeMembers',
    subscribe: (on, err) => subscribeMembers((members) => on(members.map((m) => m.id)), err),
    id: 'a@b.test',
    seed: () => writeAs(['members', 'a@b.test'], fx.member('a@b.test')),
    alsoDelivers: {
      ids: ['c@d.test'],
      seed: () => writeAs(['members', 'c@d.test'], fx.member('c@d.test')),
    },
    corrupt: { id: 'bad@b.test', seed: () => writeAs(['members', 'bad@b.test'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('members'), fx.member(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeProductForms',
    subscribe: (on, err) => subscribeProductForms((forms) => on(forms.map((f) => f.id)), err),
    id: 'yolk',
    seed: () => writeAs(['productForms', 'yolk'], fx.productForm('yolk')),
    alsoDelivers: {
      ids: ['white'],
      seed: () => writeAs(['productForms', 'white'], fx.productForm('white')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['productForms', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('productForms'), fx.productForm(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeRecipes',
    subscribe: (on, err) => subscribeRecipes((recipes) => on(recipes.map((r) => r.id)), err),
    id: 'toast',
    seed: () => writeAs(['recipes', 'toast'], fx.recipe('toast')),
    alsoDelivers: {
      ids: ['soup'],
      seed: () => writeAs(['recipes', 'soup'], fx.recipe('soup')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['recipes', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('recipes'), fx.recipe(NESTED_DECOY_ID)),
    },
  },
  {
    name: 'subscribeShoppingDaysInRange',
    subscribe: (on, err) =>
      subscribeShoppingDaysInRange(
        RANGE_START,
        RANGE_END,
        (days) => on(days.map((d) => d.date)),
        err,
      ),
    id: '2026-08-19',
    seed: () => writeAs(['shoppingDays', '2026-08-19'], fx.shoppingDay('2026-08-19')),
    // The two range ENDS, which are inclusive. Tighten either `where` to a strict
    // comparison and one of these stops arriving.
    alsoDelivers: {
      ids: [RANGE_START, RANGE_END],
      seed: async () => {
        await writeAs(['shoppingDays', RANGE_START], fx.shoppingDay(RANGE_START));
        await writeAs(['shoppingDays', RANGE_END], fx.shoppingDay(RANGE_END));
      },
    },
    // In range, so the documentId() bounds return it and the parse loop rejects it.
    corrupt: { id: '2026-08-20', seed: () => writeAs(['shoppingDays', '2026-08-20'], CORRUPT) },
    // One day either side of the inclusive range. Delete either `where` clause in
    // shoppingDaySync.ts and one of these arrives.
    excluded: {
      ids: ['2026-08-16', '2026-08-24'],
      what: 'the day either side of the range',
      seed: async () => {
        await writeAs(['shoppingDays', '2026-08-16'], fx.shoppingDay('2026-08-16'));
        await writeAs(['shoppingDays', '2026-08-24'], fx.shoppingDay('2026-08-24'));
      },
    },
  },
  {
    name: 'subscribeShoppingListItems',
    subscribe: (on, err) =>
      subscribeShoppingListItems(LIST_ID, (items) => on(items.map((i) => i.id)), err),
    id: 'item-1',
    seed: () =>
      writeAs(['shoppingLists', LIST_ID, 'items', 'item-1'], fx.shoppingListItem('item-1')),
    alsoDelivers: {
      ids: ['item-2'],
      seed: () =>
        writeAs(['shoppingLists', LIST_ID, 'items', 'item-2'], fx.shoppingListItem('item-2')),
    },
    corrupt: {
      id: 'bad',
      seed: () => writeAs(['shoppingLists', LIST_ID, 'items', 'bad'], CORRUPT),
    },
    excluded: {
      ids: ['other-item'],
      what: "another list's items",
      seed: () =>
        writeAs(
          ['shoppingLists', OTHER_LIST_ID, 'items', 'other-item'],
          fx.shoppingListItem('other-item'),
        ),
    },
  },
  {
    name: 'subscribeShoppingLists',
    subscribe: (on, err) => subscribeShoppingLists((lists) => on(lists.map((l) => l.id)), err),
    id: LIST_ID,
    seed: () => writeAs(['shoppingLists', LIST_ID], fx.shoppingList(LIST_ID)),
    alsoDelivers: {
      ids: ['list-3'],
      seed: () => writeAs(['shoppingLists', 'list-3'], fx.shoppingList('list-3')),
    },
    corrupt: { id: 'bad', seed: () => writeAs(['shoppingLists', 'bad'], CORRUPT) },
    excluded: {
      ids: [NESTED_DECOY_ID],
      what: NESTED_DECOY_WHAT,
      seed: () => writeAs(nestedPath('shoppingLists'), fx.shoppingList(NESTED_DECOY_ID)),
    },
  },
];

interface DocumentCase {
  name: string;
  subscribe: (onDoc: (d: unknown) => void, onError: ErrCb) => () => void;
  seed: () => Promise<void>;
  corrupt: () => Promise<void>;
  /** Recognise the seeded document among what was delivered. */
  matches: (d: unknown) => boolean;
  /**
   * The document id the parse loop will name in its rejection log. REQUIRED, and
   * that is the guard: every row asserts the bound log, so a row added without
   * one does not compile. Stricter than the runtime check it replaced, which
   * could only fail after the table was already built. A function, because for
   * `subscribeKitchenTimers` the id IS the subscriber's uid and is only knowable
   * inside a test.
   */
  corruptDocId: () => string;
  /**
   * Seed a VALID document of the same schema at a DIFFERENT key in the same
   * collection, chosen so `matches` REJECTS it. REQUIRED on every row: a keyed
   * single-document read has no filter to narrow, but it does have a key, and a
   * row that only ever seeds the key it asks for cannot tell "reads the document
   * at this key" from "reads whatever is in the collection".
   *
   * The singleton rows are no exception. `appSettings/singleton` is a fixed id in
   * a collection that can hold any other, and a helper parameterised by
   * collection and key can be handed the wrong key as easily as the wrong
   * collection.
   */
  excluded: { seed: () => Promise<void>; what: string };
}

const has = (d: unknown, key: string, value: unknown): boolean =>
  typeof d === 'object' && d !== null && (d as Record<string, unknown>)[key] === value;

const documentCases: DocumentCase[] = [
  {
    name: 'subscribeAppSettings',
    subscribe: (on, err) => subscribeAppSettings(on, err),
    seed: () => writeAs(['appSettings', 'singleton'], fx.appSettings()),
    corrupt: () => writeAs(['appSettings', 'singleton'], { schemaVersion: 'nope' }),
    corruptDocId: () => 'singleton',
    // On `fast`, not on `schemaVersion`: the literal 1 is true of the decoy too,
    // and a predicate the decoy satisfies is not a predicate.
    matches: (d) => has(d, 'fast', MODEL_MARK),
    excluded: {
      what: 'another key in the same collection',
      seed: () => writeAs(['appSettings', 'not-the-singleton'], fx.appSettings('decoy-model')),
    },
  },
  {
    name: 'subscribeBatch',
    subscribe: (on, err) => subscribeBatch(BATCH_ID, on, err),
    seed: () => writeAs(['batches', BATCH_ID], fx.batch(BATCH_ID)),
    corrupt: () => writeAs(['batches', BATCH_ID], CORRUPT),
    corruptDocId: () => BATCH_ID,
    matches: (d) => has(d, 'id', BATCH_ID),
    excluded: {
      what: 'another run in the same collection',
      seed: () => writeAs(['batches', OTHER_BATCH_ID], fx.batch(OTHER_BATCH_ID)),
    },
  },
  {
    name: 'subscribeCookSession',
    subscribe: (on, err) => subscribeCookSession('cook-1', on, err),
    seed: () => writeAs(['cookSessions', 'cook-1'], fx.cookSession('cook-1', ownerUid())),
    // Keep ownerUid valid so the doc is READABLE; only the rest is corrupt. A
    // doc the rules deny is an AuthError, not the StorageError this row pins.
    corrupt: () => writeAs(['cookSessions', 'cook-1'], { ...CORRUPT, ownerUid: ownerUid() }),
    corruptDocId: () => 'cook-1',
    matches: (d) => has(d, 'id', 'cook-1'),
    // Owned by the subscriber, so the rules would ALLOW this read — the only
    // thing keeping it out of the delivery is the key.
    excluded: {
      what: "the same member's session on another recipe",
      seed: () => writeAs(['cookSessions', 'cook-2'], fx.cookSession('cook-2', ownerUid())),
    },
  },
  {
    name: 'subscribeDevSettings',
    subscribe: (on, err) => subscribeDevSettings(on, err),
    seed: () => writeAs(['devSettings', 'singleton'], fx.devSettings()),
    corrupt: () => writeAs(['devSettings', 'singleton'], { schemaVersion: 'nope' }),
    corruptDocId: () => 'singleton',
    matches: (d) => has(d, 'canonIconGenerationEnabled', true),
    excluded: {
      what: 'another key in the same collection',
      seed: () => writeAs(['devSettings', 'not-the-singleton'], fx.devSettings(false)),
    },
  },
  {
    name: 'subscribeEquipmentManifest',
    subscribe: (on, err) => subscribeEquipmentManifest(on, err),
    seed: () => writeAs(['equipmentManifest', 'current'], fx.equipmentManifest()),
    corrupt: () => writeAs(['equipmentManifest', 'current'], CORRUPT),
    corruptDocId: () => 'current',
    matches: (d) => has(d, 'updatedAt', NOW),
    excluded: {
      what: 'another key in the same collection',
      seed: () =>
        writeAs(
          ['equipmentManifest', 'not-current'],
          fx.equipmentManifest('2020-01-01T00:00:00.000Z'),
        ),
    },
  },
  {
    name: 'subscribeFormula',
    subscribe: (on, err) => subscribeFormula('r1', on, err),
    seed: () => writeAs(['formulas', 'r1'], fx.formula('r1')),
    corrupt: () => writeAs(['formulas', 'r1'], CORRUPT),
    corruptDocId: () => 'r1',
    matches: (d) => has(d, 'recipeId', 'r1'),
    excluded: {
      what: "another recipe's formula",
      seed: () => writeAs(['formulas', 'r2'], fx.formula('r2')),
    },
  },
  {
    name: 'subscribeGuidedPlan',
    subscribe: (on, err) => subscribeGuidedPlan('r1', on, err),
    seed: () => writeAs(['guidedPlans', 'r1'], fx.guidedPlan('r1')),
    corrupt: () => writeAs(['guidedPlans', 'r1'], CORRUPT),
    corruptDocId: () => 'r1',
    matches: (d) => has(d, 'recipeId', 'r1'),
    excluded: {
      what: "another recipe's plan",
      seed: () => writeAs(['guidedPlans', 'r2'], fx.guidedPlan('r2')),
    },
  },
  {
    name: 'subscribeKitchenTimers',
    subscribe: (on, err) => subscribeKitchenTimers(ownerUid(), on, err),
    seed: () => writeAs(['kitchenTimers', ownerUid()], fx.kitchenTimers(ownerUid())),
    corrupt: () => writeAs(['kitchenTimers', ownerUid()], { ownerUid: ownerUid(), timers: 'nope' }),
    // The document id IS the uid here (issue #842), so that is what the parse
    // loop logs.
    corruptDocId: () => ownerUid(),
    // Matches on the OWNER, not merely on the field being present: the id IS the
    // uid here, so a laxer predicate would accept the other member's document.
    matches: (d) => has(d, 'ownerUid', ownerUid()),
    excluded: {
      what: "another member's timers",
      seed: () => writeAs(['kitchenTimers', OTHER_UID], fx.kitchenTimers(OTHER_UID)),
    },
  },
  {
    name: 'subscribeMealPlanConfig',
    subscribe: (on, err) => subscribeMealPlanConfig(on, err),
    seed: () => writeAs(['mealPlanConfig', 'singleton'], fx.mealPlanConfig()),
    corrupt: () => writeAs(['mealPlanConfig', 'singleton'], CORRUPT),
    corruptDocId: () => 'singleton',
    matches: (d) => has(d, 'firstDayOfWeek', 'fri'),
    excluded: {
      what: 'another key in the same collection',
      seed: () => writeAs(['mealPlanConfig', 'not-the-singleton'], fx.mealPlanConfig('mon')),
    },
  },
  {
    name: 'subscribeMealPlanTemplate',
    subscribe: (on, err) => subscribeMealPlanTemplate(on, err),
    seed: () => writeAs(['mealPlanTemplate', 'singleton'], fx.mealPlanTemplate()),
    corrupt: () => writeAs(['mealPlanTemplate', 'singleton'], CORRUPT),
    corruptDocId: () => 'singleton',
    // `schemaVersion` is a literal 1 on the decoy too, so the mark has to be
    // inside the week — the only other field this schema has.
    matches: (d) =>
      (d as { days?: { mon?: { note?: string } } } | null)?.days?.mon?.note === TEMPLATE_MARK,
    excluded: {
      what: 'another key in the same collection',
      seed: () =>
        writeAs(['mealPlanTemplate', 'not-the-singleton'], fx.mealPlanTemplate('a decoy week')),
    },
  },
  {
    name: 'subscribeMealPlanWeek',
    subscribe: (on, err) => subscribeMealPlanWeek(WEEK_START, on, err),
    seed: () => writeAs(['mealPlans', WEEK_START], fx.mealPlanWeek(WEEK_START)),
    corrupt: () => writeAs(['mealPlans', WEEK_START], CORRUPT),
    corruptDocId: () => WEEK_START,
    matches: (d) => has(d, 'startDate', WEEK_START),
    excluded: {
      what: 'the week before',
      seed: () => writeAs(['mealPlans', OTHER_WEEK_START], fx.mealPlanWeek(OTHER_WEEK_START)),
    },
  },
  {
    name: 'subscribeShoppingListsConfig',
    subscribe: (on, err) => subscribeShoppingListsConfig(on, err),
    seed: () => writeAs(['shoppingListsConfig', 'singleton'], fx.shoppingListsConfig(LIST_ID)),
    corrupt: () => writeAs(['shoppingListsConfig', 'singleton'], { defaultListId: 42 }),
    corruptDocId: () => 'singleton',
    matches: (d) => has(d, 'defaultListId', LIST_ID),
    excluded: {
      what: 'another key in the same collection',
      seed: () =>
        writeAs(
          ['shoppingListsConfig', 'not-the-singleton'],
          fx.shoppingListsConfig(OTHER_LIST_ID),
        ),
    },
  },
  {
    name: 'subscribeWeatherForecast',
    subscribe: (on, err) => subscribeWeatherForecast(on, err),
    seed: () => writeAs(['weatherForecast', 'singleton'], fx.weatherForecast()),
    corrupt: () => writeAs(['weatherForecast', 'singleton'], CORRUPT),
    corruptDocId: () => 'singleton',
    matches: (d) => has(d, 'timezone', 'Europe/London'),
    excluded: {
      what: 'another key in the same collection',
      seed: () =>
        writeAs(['weatherForecast', 'not-the-singleton'], fx.weatherForecast('America/New_York')),
    },
  },
];

// ─── The guard ──────────────────────────────────────────────────────────────

// Everything here is a guard on the TABLE — that no subscription and no
// obligation has been left out of it. There is deliberately nothing that reads
// `src/` as text: see the header for the scan that used to live at this spot and
// why it had to go.
describe('subscription contract — table coverage', () => {
  it('covers every exported subscribe* — derived from the barrel, not a hand-kept list', () => {
    const exported = Object.keys(barrel)
      .filter((k) => k.startsWith('subscribe'))
      .sort();
    const tabled = [...collectionCases, ...documentCases].map((c) => c.name).sort();

    // A new subscription must arrive with a row. This is the recurrence guard
    // #928 asks for: the shape only exists once to copy from, and the table is
    // what notices when someone copies it anyway.
    expect(tabled).toEqual(exported);
    expect(exported).toHaveLength(28);
  });

  it('every row is uniquely named', () => {
    const names = [...collectionCases, ...documentCases].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a row that skips the corrupt-document case says why', () => {
    for (const c of collectionCases) {
      if (!c.corrupt) {
        expect(c.noCorruptCase, `${c.name} skips the corrupt case without a reason`).toBeTruthy();
      }
    }
  });

  /**
   * The #939 counterpart of the rule above, and the one the exact-set assertion
   * rests on. A row that seeds only what its query ADMITS pins nothing about the
   * query: whatever narrowing arrives, the delivered set is unchanged and the row
   * stays green. Since #1135 this tree IS in the root `typecheck` (UT-G1), so a
   * row missing a required field is now a compile error — but that only catches
   * an ABSENT field, never one seeded with a set the query would have admitted
   * anyway. This assertion is still the only thing checking that.
   */
  it('every row seeds at least one document its subscription must exclude', () => {
    for (const c of collectionCases) {
      expect(c.excluded.ids.length, `${c.name} names no excluded id`).toBeGreaterThan(0);
      expect(c.excluded.what, `${c.name} does not say what its decoy is`).toBeTruthy();
    }
    for (const c of documentCases) {
      expect(c.excluded, `${c.name} seeds nothing its read must exclude`).toBeTruthy();
      expect(c.excluded.what, `${c.name} does not say what its decoy is`).toBeTruthy();
    }
  });

  it('every corrupt case names the document id its parse loop will log', () => {
    for (const c of collectionCases) {
      if (c.corrupt) expect(c.corrupt.id, `${c.name} corrupt case has no id`).toBeTruthy();
    }
  });
});

// ─── Collection subscriptions ───────────────────────────────────────────────

/**
 * An id list, ordered so two of them can be compared for SET equality.
 *
 * Used only where the query imposes no order of its own. The `ordered` rows
 * compare raw, because there the order IS the assertion — do not route them
 * through here.
 */
const asSet = (ids: readonly string[]): string[] => [...ids].sort();
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const wanted = asSet(b);
  return asSet(a).every((id, i) => id === wanted[i]);
};

describe.each(collectionCases)('$name (collection)', (c) => {
  const background = c.alsoDelivers?.ids ?? [];
  const expected = [...background, ...(c.seedDelivers ?? [c.id])];

  /**
   * The exact-set row — the one that survives #928 and reds under #939.
   *
   * The whole world this subscription can see is seeded, and the assertion is
   * `toEqual` over the delivered ids, not `toContain`. Any narrowing that arrives
   * later — a `where`, a `limit`, a tighter path, a different key — changes that
   * set and fails HERE, whatever the code has been reshaped into and wherever the
   * constraint literal ends up living.
   *
   * Everything except ONE document goes in before the listener attaches. That is
   * what makes the negative half mean something without an arbitrary sleep
   * (UT-F3) — the decoys were on the server first, so by the time the last
   * document is DELIVERED they would have been delivered too if the query
   * admitted them — and it keeps this row to a single write under an attached
   * listener, like every other row here (see the corrupt row's note on #122).
   */
  it(`delivers exactly what its query admits, never ${c.excluded.what}`, async () => {
    await c.excluded.seed();
    if (c.alsoDelivers) await c.alsoDelivers.seed();

    const seen: string[][] = [];
    const errors: DomainError[] = [];
    const unsubscribe = c.subscribe(
      (ids) => seen.push(ids),
      (e) => errors.push(e),
    );
    try {
      await waitFor(
        () => seen.some((ids) => sameSet(ids, background)),
        CONVERGENCE_MS,
        `${c.name} to settle on ${JSON.stringify(asSet(background))} — what was seeded before it attached`,
        errors,
      );

      await c.seed();
      await waitFor(
        () => seen.some((ids) => sameSet(ids, expected)),
        CONVERGENCE_MS,
        `${c.name} to deliver exactly ${JSON.stringify(asSet(expected))}`,
        errors,
      );
      expect(asSet(seen[seen.length - 1]!)).toEqual(asSet(expected));

      // Nothing out of bounds may appear in ANY snapshot, not merely the last:
      // a filter that leaks and then self-corrects has still leaked.
      for (const ids of seen) {
        for (const id of c.excluded.ids) expect(ids).not.toContain(id);
      }
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('delivers an empty list when the collection is empty', async () => {
    const seen: string[][] = [];
    const unsubscribe = c.subscribe(
      (ids) => seen.push(ids),
      () => {},
    );
    try {
      await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`);
      expect(seen[0]).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('stops delivering after unsubscribe', async () => {
    const seen: string[][] = [];
    const unsubscribe = c.subscribe(
      (ids) => seen.push(ids),
      () => {},
    );
    await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`);
    const before = seen.length;
    unsubscribe();

    // A second, LIVE listener is the real signal that the write reached this
    // client: once the control has the document, the unsubscribed listener would
    // have had it too. Sleeping a fixed interval instead would be an arbitrary
    // sleep (docs/unit-test-spec.md UT-F3) — on a slow run it proves nothing,
    // and on a fast one it is dead time in 28 rows. The control settles its own
    // initial snapshot before the write, so this row still issues exactly one
    // write under an attached listener (see the corrupt row's note).
    const control: string[][] = [];
    const stopControl = c.subscribe(
      (ids) => control.push(ids),
      () => {},
    );
    try {
      await waitFor(() => control.length > 0, CONVERGENCE_MS, `${c.name} control snapshot`);
      await c.seed();
      await waitFor(
        () => control.some((ids) => ids.includes(c.id)),
        CONVERGENCE_MS,
        `${c.name} control delivery`,
      );
    } finally {
      stopControl();
    }

    expect(seen.length).toBe(before);
  });

  const projection = c.projection;
  if (projection) {
    /**
     * A transform the id list cannot see. Asserted on the delivered DOCUMENTS,
     * because that is the only place it is observable — and a consolidation that
     * replaced 13 parse loops with one would drop it without a single row here
     * changing colour otherwise.
     *
     * The listener is settled before the seed, like every other row: this row's
     * unsettled write-after-subscribe raced the Listen target's registration,
     * and both attempts of run 32876589235 failed here as a silent convergence
     * timeout (#999). The #122 framing desync (see the corrupt row's note)
     * appeared in only one of those attempts — incidental, not the trigger;
     * the unsettled write is the constant.
     */
    it(projection.what, async () => {
      const seen: unknown[][] = [];
      const errors: DomainError[] = [];
      const unsubscribe = projection.subscribe(
        (docs) => seen.push(docs),
        (e) => errors.push(e),
      );
      try {
        await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`, errors);
        expect(seen[0]).toEqual([]);

        await projection.seed();
        await waitFor(
          () => seen.some((docs) => docs.length > 0),
          CONVERGENCE_MS,
          `${c.name} to deliver the document its projection applies to`,
          errors,
        );
        projection.assert(seen[seen.length - 1]!);
        expect(errors).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  }

  const ordered = c.ordered;
  if (ordered) {
    it(`delivers in the order its query fixes — ${ordered.what}`, async () => {
      await ordered.seed();

      const seen: string[][] = [];
      const errors: DomainError[] = [];
      const unsubscribe = c.subscribe(
        (ids) => seen.push(ids),
        (e) => errors.push(e),
      );
      try {
        // The whole LIST, in order — membership would be satisfied by any
        // ordering and by an unbounded read, which is precisely the hole.
        await waitFor(
          () => seen.some((ids) => ids.length === ordered.ids.length),
          CONVERGENCE_MS,
          `${c.name} to converge on ${ordered.ids.length} documents`,
          errors,
        );
        expect(seen[seen.length - 1]).toEqual(ordered.ids);
        expect(errors).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  }

  const seedCorrupt = c.corrupt;
  if (seedCorrupt) {
    // The corrupt document is seeded BEFORE the subscription and the valid one
    // after it, which pins the skip on both snapshot paths — the initial read
    // and a live update — rather than only on whichever one a single
    // arrangement happens to hit. It also keeps this row to ONE write while a
    // listener is attached, like every other row.
    //
    // That second property is load-bearing. Seeding both documents back to back
    // under an attached listener is the only shape in this file that made the
    // emulator answer two Listen responses with no round trip between them, and
    // it reproduced #122 on demand: across five runs, EVERY
    // `RESOURCE_EXHAUSTED: Received message larger than max` (a phantom 0.5-3 GB
    // frame that puts the client into maximum backoff for good) landed on this
    // row and on no other, on a different collection each time. The transport
    // fix #122 shipped cannot help here — `experimentalForceLongPolling` is a
    // WebChannel option and the SDK's node build always uses `GrpcConnection`
    // (`dist/index.node.mjs`), so this suite is on gRPC whatever init.ts asks
    // for. Removing the back-to-back pair is therefore the only lever the test
    // side has, and it costs the assertion nothing.
    it('skips a corrupt document and still delivers the valid subset', async () => {
      // The rejection signal. Every collection parse loop logs before it skips,
      // so this is what separates "the document was REJECTED" from "the query
      // never returned it" — and the two are otherwise identical from out here.
      // Call-through: the zod error still reaches the console for diagnosis.
      const logged = vi.spyOn(console, 'error');
      await seedCorrupt.seed();

      const seen: string[][] = [];
      const errors: DomainError[] = [];
      const unsubscribe = c.subscribe(
        (ids) => seen.push(ids),
        (e) => errors.push(e),
      );
      try {
        // The initial snapshot already sees the corrupt document, and must
        // deliver the (empty) valid subset rather than failing the whole read.
        await waitFor(
          () => seen.length > 0,
          CONVERGENCE_MS,
          `${c.name} initial snapshot past a corrupt sibling`,
          errors,
        );
        expect(seen[0]).toEqual([]);

        await c.seed();
        const validSubset = c.seedDelivers ?? [c.id];
        await waitFor(
          () => seen.some((ids) => sameSet(ids, validSubset)),
          CONVERGENCE_MS,
          `${c.name} valid subset after a corrupt sibling`,
          errors,
        );

        // The contract (CLAUDE.md, zod conventions): skip the invalid doc, keep
        // the rest, and do NOT fail the whole read. Asserted as the EXACT set,
        // so the corrupt id being absent is not the only thing being checked —
        // nothing may have gone missing alongside it either.
        expect(asSet(seen[seen.length - 1]!)).toEqual(asSet(validSubset));
        expect(errors).toEqual([]);

        // …and it was skipped, not merely absent. Without this the row passes on
        // a document the query filtered out server-side, which is how
        // `subscribeBatchObservations` was green while rejecting nothing: the
        // delivered ids come from PARSED documents, so `not.toContain` can never
        // fail whatever the behaviour.
        const rejections = logged.mock.calls.filter(
          ([first]) =>
            typeof first === 'string' &&
            first.includes(`Document ${seedCorrupt.id} failed validation`),
        );
        expect(
          rejections.length,
          `${c.name} delivered the valid subset without ever rejecting ${seedCorrupt.id} — ` +
            'the corrupt document never reached the parse loop',
        ).toBeGreaterThan(0);
      } finally {
        unsubscribe();
      }
    });
  }
});

// ─── Single-document subscriptions ──────────────────────────────────────────

describe.each(documentCases)('$name (document)', (c) => {
  it('delivers null when the document does not exist', async () => {
    const seen: unknown[] = [];
    const unsubscribe = c.subscribe(
      (d) => seen.push(d),
      () => {},
    );
    try {
      await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`);
      expect(seen[0]).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it('delivers the document after it is written', async () => {
    const seen: unknown[] = [];
    const errors: DomainError[] = [];
    const unsubscribe = c.subscribe(
      (d) => seen.push(d),
      (e) => errors.push(e),
    );
    try {
      // SETTLE THE LISTENER BEFORE WRITING. The seed goes through the REST door
      // (see the header), so it is a genuinely out-of-band write racing the
      // Listen target's registration — and this was one of TWO write-after-
      // subscribe sites in the file that did not wait first (the other was the
      // projection row, missed at the time and fixed in #999). Its two siblings
      // both do: the collection row waits for the background set, and
      // `delivers only its own key` below waits for exactly this null.
      //
      // Unwaited, it failed twice on CI (runs 32845375930 and 32856731377) on
      // four different rows — subscribeBatch, subscribeMealPlanTemplate,
      // subscribeDevSettings, subscribeWeatherForecast — always this test, never
      // another, and always as a silent 15 s timeout with nothing on `onError`.
      // The first of those runs also carried a #122 RESOURCE_EXHAUSTED and the
      // second carried no transport error at all, which is what rules the
      // transport out as the explanation: the constant is the missing wait.
      //
      // The wait also makes the assertion STRONGER rather than merely calmer.
      // With it, the document provably arrives as a LIVE UPDATE to an attached
      // listener; without it, an initial snapshot that already contained the
      // document would satisfy the row just as happily — which is the one thing
      // a test named "after it is written" must not accept.
      await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`, errors);
      expect(seen[0]).toBeNull();

      await c.seed();
      await waitFor(() => seen.some(c.matches), CONVERGENCE_MS, `${c.name} document`, errors);
      expect(seen.some(c.matches)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('stops delivering after unsubscribe', async () => {
    const seen: unknown[] = [];
    const unsubscribe = c.subscribe(
      (d) => seen.push(d),
      () => {},
    );
    await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`);
    const before = seen.length;
    unsubscribe();

    // A second, LIVE listener is the real signal that the write reached this
    // client: once the control has the document, the unsubscribed listener would
    // have had it too. Sleeping a fixed interval instead would be an arbitrary
    // sleep (docs/unit-test-spec.md UT-F3) — on a slow run it proves nothing,
    // and on a fast one it is dead time in 28 rows. The control settles its own
    // initial snapshot before the write, so this row still issues exactly one
    // write under an attached listener (see the corrupt row's note).
    const control: unknown[] = [];
    const stopControl = c.subscribe(
      (d) => control.push(d),
      () => {},
    );
    try {
      await waitFor(() => control.length > 0, CONVERGENCE_MS, `${c.name} control snapshot`);
      await c.seed();
      await waitFor(() => control.some(c.matches), CONVERGENCE_MS, `${c.name} control delivery`);
    } finally {
      stopControl();
    }

    expect(seen.length).toBe(before);
  });

  /**
   * The single-document counterpart of the collection rows' exact-set assertion,
   * and REQUIRED on every row. A keyed read has no filter to narrow, but it does
   * have a key, and a row that only ever seeds the key it asks for cannot tell
   * "reads the document at this key" from "reads whatever is in the collection".
   * The decoy is a VALID document of the same schema that `matches` rejects, so
   * a read at the wrong key delivers a non-null value and fails here — it is
   * seeded FIRST, so it would already be in the very first snapshot.
   */
  it(`delivers only its own key, never ${c.excluded.what}`, async () => {
    await c.excluded.seed();

    const seen: unknown[] = [];
    const errors: DomainError[] = [];
    const unsubscribe = c.subscribe(
      (d) => seen.push(d),
      (e) => errors.push(e),
    );
    try {
      await waitFor(
        () => seen.length > 0,
        CONVERGENCE_MS,
        `${c.name} initial snapshot alongside ${c.excluded.what}`,
        errors,
      );
      expect(seen[0]).toBeNull();

      await c.seed();
      await waitFor(() => seen.some(c.matches), CONVERGENCE_MS, `${c.name} document`, errors);

      // Every delivery is either "absent" or THIS document.
      expect(seen.every((d) => d === null || c.matches(d))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('answers a document that fails its schema with a corruption Failure', async () => {
    const logged = vi.spyOn(console, 'error');
    const seen: unknown[] = [];
    const errors: DomainError[] = [];
    // The second argument of `onError`, captured alongside the first. It is what
    // separates the parse path from the stream path — see below.
    const raws: unknown[] = [];
    const unsubscribe = c.subscribe(
      (d) => seen.push(d),
      (e, raw) => {
        errors.push(e);
        raws.push(raw);
      },
    );
    try {
      // Settle the initial (absent) snapshot first. It delivers a `null` of its
      // own, so `before` has to be taken after it for the no-delivery assertion
      // below to mean anything.
      await waitFor(() => seen.length > 0, CONVERGENCE_MS, `${c.name} initial snapshot`);
      const before = seen.length;
      await c.corrupt();

      await waitFor(() => errors.length > 0, CONVERGENCE_MS, `${c.name} corruption error`);
      expect(errors[0]).toMatchObject({ kind: 'StorageError', reason: 'corruption' });

      // …and NOT a delivery. `subscribeCookSession` and `subscribeKitchenTimers`
      // used to answer a refused document with `null`, which is what an ABSENT
      // document delivers — so the caller could not tell a corrupt session from
      // a deleted one (#928 Phase 2). Nothing new may reach `onDoc` here.
      expect(
        seen.length,
        `${c.name} delivered for a document its schema refused — a caller cannot ` +
          'tell that from a document that does not exist',
      ).toBe(before);

      // The corruption assertion above does not prove a document was READ and
      // REFUSED: `{kind:'StorageError', reason:'corruption'}` is also what
      // classifyFirestoreError returns for the Firestore code `data-loss`, so a
      // stream-level failure satisfies it with nothing read at all. These two do.

      // The rejection log, bound to THIS document id — emitted only by the
      // parse. An unbound `failed validation` would be satisfied by a rejection
      // of any document at all. Every single-document read logs identically
      // since #928 Phase 1 deleted `logsRejection`, which is why this runs on
      // every row rather than on two of them.
      const wanted = `Document ${c.corruptDocId()} failed validation`;
      expect(
        logged.mock.calls.some(([first]) => typeof first === 'string' && first.includes(wanted)),
        `${c.name} answered a refused document without logging "${wanted}" — nothing here ` +
          'then distinguishes a document that was parsed and refused from one never read',
      ).toBe(true);

      // …and nothing reached `onError` carrying a rawError. The stream path
      // calls `onError(classifyFirestoreError(err), err)` — two arguments; the
      // parse path passes one. Since Phase 1 widened the last eight
      // one-argument declarations (B2-009), every module is capable of
      // falsifying this, where on seven of them it used to be vacuously true.
      expect(
        raws.every((r) => r === undefined),
        `${c.name} forwarded a rawError while answering a refused document — that is the ` +
          'stream path, so this row never proved the document was parsed and refused',
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
