/**
 * Firestore emulator integration tests for taking packs out of a freezer item
 * (issue #1684, Phase 2).
 *
 * The writer-contract row pins the SHAPE of the take — one `updateDoc` carrying
 * `increment(delta)`. What only a real Firestore can prove is that the shape
 * behaves: that a take queued offline and replayed on reconnect composes with
 * one made meanwhile on another phone (five less two is three, never four), that
 * two takes of the last pack land below zero and still read, and that a take on
 * an item another phone removed is refused rather than recreating it.
 *
 * The adapter runs on the default app, which is the phone taken offline; the
 * other phone is a second "writer" app making the same write.
 *
 * Requires the isolated Vitest emulator stack (issue #84 Phase 3).
 * Run via: pnpm test:emulator
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp, getApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getFirestore,
  increment,
  updateDoc,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { displayAmount, type FreezerItem } from '@salt/domain';
import { FreezerItemSchema } from '@salt/domain/schemas';
import {
  deleteFreezerItem,
  saveFreezerItem,
  takeFreezerItemAmount,
} from '../src/freezerItemSync.js';
import { clearFirestoreEmulator, resetDefaultApp, PROJECT_ID } from './emulatorHelpers.js';

const _env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const WRITER_FIRESTORE_PORT = Number(_env['VITE_EMULATOR_FIRESTORE_PORT'] ?? 8080);
const WRITER_AUTH_PORT = _env['VITE_EMULATOR_AUTH_PORT'] ?? '9099';
const WRITER_APP_NAME = 'freezer-other-phone';

let writerApp: FirebaseApp;
let otherPhone: Firestore;

// Same construction as realtimeSubscriptions.emulator.test.ts: re-created per
// test, long-polling, signed in, so a poisoned channel cannot bleed across tests.
async function createOtherPhone(): Promise<void> {
  const stale = getApps().find((app) => app.name === WRITER_APP_NAME);
  if (stale) await deleteApp(stale);
  writerApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, WRITER_APP_NAME);
  otherPhone = initializeFirestore(writerApp, { experimentalForceLongPolling: true });
  connectFirestoreEmulator(otherPhone, '127.0.0.1', WRITER_FIRESTORE_PORT);
  const auth = getAuth(writerApp);
  connectAuthEmulator(auth, `http://127.0.0.1:${WRITER_AUTH_PORT}`, { disableWarnings: true });
  await signInAnonymously(auth);
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  await resetDefaultApp();
  await createOtherPhone();
});

afterEach(async () => {
  await deleteApp(writerApp);
});

function item(amount: number): FreezerItem {
  return {
    schemaVersion: 1,
    number: 47,
    name: 'Pork loin',
    freezerId: 'fz-garage',
    shelf: 'B',
    amount,
    canonId: null,
    recipeId: null,
    purchasedFrom: null,
    addedAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
  };
}

/** The other phone takes one, exactly as `takeFreezerItemAmount` writes it. */
async function otherPhoneTakesOne(): Promise<void> {
  await updateDoc(doc(otherPhone, 'freezerItems', '047'), {
    amount: increment(-1),
    updatedAt: new Date().toISOString(),
  });
}

/** What the server holds, read from the other phone. */
async function stored(): Promise<Record<string, unknown> | undefined> {
  const snap = await getDoc(doc(otherPhone, 'freezerItems', '047'));
  return snap.exists() ? snap.data() : undefined;
}

describe('takeFreezerItemAmount — Firestore emulator', () => {
  it('composes an offline take with one made meanwhile on another phone: 5 less 2 is 3', async () => {
    await saveFreezerItem(item(5));
    const thisPhone = getFirestore(getApp());

    await disableNetwork(thisPhone);
    // Offline the write is queued and does not settle until reconnect.
    const queued = takeFreezerItemAmount(47, -1);
    await otherPhoneTakesOne();
    expect((await stored())?.['amount']).toBe(4);

    await enableNetwork(thisPhone);
    await expect(queued).resolves.toEqual({ kind: 'ok', value: undefined });

    expect((await stored())?.['amount']).toBe(3);
  });

  it('lands two takes of the last pack on -1, which still reads and shows as none', async () => {
    await saveFreezerItem(item(1));

    await expect(takeFreezerItemAmount(47, -1)).resolves.toEqual({ kind: 'ok', value: undefined });
    await otherPhoneTakesOne();

    const data = await stored();
    expect(data?.['amount']).toBe(-1);
    const parsed = FreezerItemSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    expect(displayAmount(parsed.success ? parsed.data.amount : NaN)).toBe(0);
  });

  it('refuses a take on an item another phone removed, and does not bring it back', async () => {
    await saveFreezerItem(item(5));
    await deleteFreezerItem(47);

    await expect(takeFreezerItemAmount(47, -1)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezerItem', id: '47' },
    });
    expect(await stored()).toBeUndefined();
  });
});
