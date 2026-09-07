/**
 * Emulator integration test for firestore.rules — members allowlist (issue #155).
 *
 * Proves the real (server-side) enforcement that the client admin gating only
 * mirrors cosmetically:
 *   - any signed-in user may READ the roster
 *   - only an admin member may WRITE (create/update/delete) members
 *   - a non-admin member is denied writes even though the client UI is bypassed
 *   - an unauthenticated caller is denied reads
 *   - EXCEPT: a member may update their own `cookMode` and nothing else (#776),
 *     which is the one place a non-admin may write this collection at all
 *   - the `system` flag (#1300) is admin-only, and its arrival must NOT break
 *     that exception for the member docs written before it existed
 *
 * Admin-ness is resolved by the rules via get(/members/$(token.email)), so the
 * caller's token email must equal an admin member doc id.
 *
 * Requires the Firestore emulator. Mirrors storageRules.emulator.test.ts: the
 * reachability probe is timer-bounded (WSL2 free-port contract, #79) and the
 * suite SKIPS when the emulator is not up.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const PROJECT_ID = 'demo-salt';
const HOST = '127.0.0.1';
const PORT = Number(
  (import.meta as { env?: Record<string, string | undefined> }).env?.[
    'VITE_EMULATOR_FIRESTORE_PORT'
  ] ?? '8080',
);

const RULES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../firestore.rules');

async function firestoreEmulatorReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`http://${HOST}:${PORT}/`, { signal: controller.signal });
    return resp.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function memberDoc(email: string, admin: boolean, over: Record<string, unknown> = {}) {
  return {
    id: email,
    schemaVersion: 1,
    name: email.split('@')[0],
    email,
    admin,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  };
}

// A member document as PRODUCTION holds it: written before `system` existed, so
// the key is absent rather than `false`. Its own helper rather than an inline
// destructure because three tests below turn on that absence — the suite's
// complete-document fixture is exactly why this class of break was invisible
// until #1300 went looking for it.
function preSystemMemberDoc(email: string, admin: boolean, over: Record<string, unknown> = {}) {
  const { system: _system, ...rest } = memberDoc(email, admin, over);
  return rest;
}

const reachable = await firestoreEmulatorReachable();
if (!reachable) {
  console.warn(
    `[firestoreRules.emulator] Firestore emulator not reachable on ${HOST}:${PORT} — skipping.`,
  );
}

describe.skipIf(!reachable)('firestore.rules — members allowlist', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    // Seed the roster with the Admin SDK (rules disabled): one admin, one not.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'members', 'admin@e.org'), memberDoc('admin@e.org', true));
      await setDoc(doc(db, 'members', 'kid@e.org'), memberDoc('kid@e.org', false));
    });
  });

  function adminCtx() {
    return testEnv.authenticatedContext('uid-admin', { email: 'admin@e.org' });
  }
  function kidCtx() {
    return testEnv.authenticatedContext('uid-kid', { email: 'kid@e.org' });
  }

  it('lets an admin create a new member', async () => {
    const db = adminCtx().firestore();
    await assertSucceeds(setDoc(doc(db, 'members', 'new@e.org'), memberDoc('new@e.org', false)));
  });

  it('lets an admin update and delete members', async () => {
    const db = adminCtx().firestore();
    await assertSucceeds(setDoc(doc(db, 'members', 'kid@e.org'), memberDoc('kid@e.org', true)));
    await assertSucceeds(deleteDoc(doc(db, 'members', 'kid@e.org')));
  });

  it('lets a non-admin member read the roster', async () => {
    const db = kidCtx().firestore();
    await assertSucceeds(getDoc(doc(db, 'members', 'admin@e.org')));
  });

  it('denies a non-admin member from creating a member', async () => {
    const db = kidCtx().firestore();
    await assertFails(setDoc(doc(db, 'members', 'sneak@e.org'), memberDoc('sneak@e.org', true)));
  });

  it('denies a non-admin member from editing or deleting a member', async () => {
    const db = kidCtx().firestore();
    await assertFails(setDoc(doc(db, 'members', 'admin@e.org'), memberDoc('admin@e.org', false)));
    await assertFails(deleteDoc(doc(db, 'members', 'admin@e.org')));
  });

  it('denies an unauthenticated caller from reading the roster', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'members', 'admin@e.org')));
  });

  it('denies a signed-in user whose email is not a member', async () => {
    const db = testEnv.authenticatedContext('uid-ghost', { email: 'ghost@e.org' }).firestore();
    // can read (any signed-in user) but cannot write (not an admin member)
    await assertSucceeds(getDoc(doc(db, 'members', 'admin@e.org')));
    await assertFails(setDoc(doc(db, 'members', 'x@e.org'), memberDoc('x@e.org', false)));
  });

  // ─── The self-serve cook-mode exception (issue #776) ───────────────────────
  //
  // A member may update their OWN doc, but only to change `cookMode`. This doc
  // carries the `admin` flag, so the denials below are the point of the feature's
  // security review — the permitted case is one line and the ways to abuse it are
  // the rest. Everything here runs as `kid`, a NON-admin.

  it('lets a member set their own cook mode', async () => {
    const db = kidCtx().firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'members', 'kid@e.org'),
        memberDoc('kid@e.org', false, { cookMode: 'guided' }),
      ),
    );
  });

  it('lets a member set it back', async () => {
    const db = kidCtx().firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'members', 'kid@e.org'), { cookMode: 'guided', updatedAt: 'x' }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'members', 'kid@e.org'), { cookMode: 'standard', updatedAt: 'y' }),
    );
  });

  it('DENIES making yourself an admin while changing your cook mode', async () => {
    // The attack the pinning exists for. Both fields move in one write, which is
    // exactly what an attacker would send.
    const db = kidCtx().firestore();
    await assertFails(
      setDoc(doc(db, 'members', 'kid@e.org'), memberDoc('kid@e.org', true, { cookMode: 'guided' })),
    );
  });

  it('DENIES making yourself an admin on its own', async () => {
    const db = kidCtx().firestore();
    await assertFails(updateDoc(doc(db, 'members', 'kid@e.org'), { admin: true }));
  });

  it('DENIES changing anything else about yourself', async () => {
    // Not a security hole so much as a scope one: the exception is for a cooking
    // preference, and a member editing their own name or sort order is the admin
    // screen's job.
    const db = kidCtx().firestore();
    await assertFails(updateDoc(doc(db, 'members', 'kid@e.org'), { name: 'Renamed' }));
    await assertFails(updateDoc(doc(db, 'members', 'kid@e.org'), { sortOrder: 99 }));
    await assertFails(updateDoc(doc(db, 'members', 'kid@e.org'), { email: 'other@e.org' }));
  });

  it("DENIES setting someone ELSE's cook mode", async () => {
    const db = kidCtx().firestore();
    await assertFails(
      updateDoc(doc(db, 'members', 'admin@e.org'), { cookMode: 'guided', updatedAt: 'x' }),
    );
  });

  it('DENIES a cook mode that is not one of the two the schema allows', async () => {
    // The doc is family-readable, so an unconstrained string here is a place to
    // park arbitrary data on someone else's screen.
    const db = kidCtx().firestore();
    await assertFails(
      updateDoc(doc(db, 'members', 'kid@e.org'), { cookMode: 'anything', updatedAt: 'x' }),
    );
  });

  it('DENIES creating or deleting your own member doc', async () => {
    // The exception is an UPDATE exception. A member who could delete themselves
    // could then be re-created by the blocking function with a fresh doc.
    const db = kidCtx().firestore();
    await assertFails(deleteDoc(doc(db, 'members', 'kid@e.org')));
    await assertFails(
      setDoc(
        doc(db, 'members', 'kid2@e.org'),
        memberDoc('kid2@e.org', false, { cookMode: 'guided' }),
      ),
    );
  });

  it('lets a member on a doc written before `icon` existed still set their cook mode', async () => {
    // `icon` carries `.default(null)`, so the oldest member docs have no such key.
    // A rule that pinned fields by comparing them one by one would read a missing
    // key here and deny — working everywhere except on the longest-standing
    // accounts, which is precisely the failure that ships green.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const { icon: _icon, cookMode: _cookMode, ...legacy } = memberDoc('old@e.org', false);
      await setDoc(doc(db, 'members', 'old@e.org'), legacy);
    });
    const db = testEnv.authenticatedContext('uid-old', { email: 'old@e.org' }).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'members', 'old@e.org'), { cookMode: 'guided', updatedAt: 'x' }),
    );
  });

  // ─── The `system` flag, and the trap it sets for the above (issue #1300) ───
  //
  // `system` carries `.default(false)`, so `upsertMember` writes the key onto a
  // document that never had it — which puts `system` in `affectedKeys()` on a
  // plain cook-mode save. These three are the mechanical form of the claim that
  // the rule change is safe; the first goes red against the pre-#1300 rule.

  async function seedPreSystemMember(email: string, admin = false): Promise<void> {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'members', email), preSystemMemberDoc(email, admin));
    });
  }

  it('lets a non-admin on a doc with no `system` key still change their own cook mode', async () => {
    // The regression the rule change exists to prevent, written as production
    // sends it: a full setDoc of the whole document, `system: false` materialised
    // by the schema default on a doc that has no such key.
    await seedPreSystemMember('legacy@e.org');
    const db = testEnv.authenticatedContext('uid-legacy', { email: 'legacy@e.org' }).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'members', 'legacy@e.org'),
        memberDoc('legacy@e.org', false, { cookMode: 'guided' }),
      ),
    );
  });

  it('DENIES a non-admin flagging themselves a system account while changing cook mode', async () => {
    // Tolerating the absent → false materialisation must not tolerate a real
    // flip. Run from a doc with no `system` key, which is the harder case: the
    // rule has to read a missing key on one side without erroring.
    await seedPreSystemMember('legacy@e.org');
    const db = testEnv.authenticatedContext('uid-legacy', { email: 'legacy@e.org' }).firestore();
    await assertFails(
      setDoc(
        doc(db, 'members', 'legacy@e.org'),
        memberDoc('legacy@e.org', false, { cookMode: 'guided', system: true }),
      ),
    );
  });

  it('DENIES a non-admin clearing `system` on their own record', async () => {
    // The other direction: an account already flagged must not be able to unflag
    // itself back into the household's people-pickers.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'members', 'fridge@e.org'),
        memberDoc('fridge@e.org', false, { system: true }),
      );
    });
    const db = testEnv.authenticatedContext('uid-fridge', { email: 'fridge@e.org' }).firestore();
    await assertFails(
      updateDoc(doc(db, 'members', 'fridge@e.org'), { system: false, updatedAt: 'x' }),
    );
  });

  it('lets an admin set `system` on any member, including one with no such key', async () => {
    await seedPreSystemMember('legacy@e.org');
    const db = adminCtx().firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'members', 'legacy@e.org'),
        memberDoc('legacy@e.org', false, { system: true }),
      ),
    );
    await assertSucceeds(
      setDoc(doc(db, 'members', 'kid@e.org'), memberDoc('kid@e.org', false, { system: true })),
    );
  });
});

describe.skipIf(!reachable)('firestore.rules — meal planning (issue #169)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  function userCtx() {
    // Any signed-in user is already an allowlisted member; no member doc needed
    // because meal-plan rules never call get(/members/...) (writes are open).
    return testEnv.authenticatedContext('uid-user', { email: 'user@e.org' }).firestore();
  }

  it('lets any signed-in user read and write the config singleton', async () => {
    const db = userCtx();
    await assertSucceeds(
      setDoc(doc(db, 'mealPlanConfig', 'singleton'), { firstDayOfWeek: 'mon', schemaVersion: 1 }),
    );
    await assertSucceeds(getDoc(doc(db, 'mealPlanConfig', 'singleton')));
  });

  it('lets any signed-in user read and write the template singleton', async () => {
    const db = userCtx();
    await assertSucceeds(
      setDoc(doc(db, 'mealPlanTemplate', 'singleton'), { schemaVersion: 1, days: {} }),
    );
    await assertSucceeds(getDoc(doc(db, 'mealPlanTemplate', 'singleton')));
  });

  it('lets any signed-in user read and write a week doc', async () => {
    const db = userCtx();
    await assertSucceeds(
      setDoc(doc(db, 'mealPlans', '2026-06-08'), {
        id: '2026-06-08',
        schemaVersion: 1,
        startDate: '2026-06-08',
        days: {},
        updatedAt: '2026-06-08T00:00:00.000Z',
      }),
    );
    await assertSucceeds(getDoc(doc(db, 'mealPlans', '2026-06-08')));
  });

  it('denies an unauthenticated caller on every meal-plan doc', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'mealPlanConfig', 'singleton')));
    await assertFails(getDoc(doc(db, 'mealPlanTemplate', 'singleton')));
    await assertFails(getDoc(doc(db, 'mealPlans', '2026-06-08')));
  });
});

describe.skipIf(!reachable)('firestore.rules — devSettings (issue #238)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    // devSettings writes are admin-gated via get(/members/...), so seed a roster.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'members', 'admin@e.org'), memberDoc('admin@e.org', true));
      await setDoc(doc(db, 'members', 'kid@e.org'), memberDoc('kid@e.org', false));
    });
  });

  const settings = { canonIconGenerationEnabled: false, schemaVersion: 1 };

  it('lets an admin write the settings singleton', async () => {
    const db = testEnv.authenticatedContext('uid-admin', { email: 'admin@e.org' }).firestore();
    await assertSucceeds(setDoc(doc(db, 'devSettings', 'singleton'), settings));
  });

  it('lets any signed-in user read the settings singleton', async () => {
    const db = testEnv.authenticatedContext('uid-kid', { email: 'kid@e.org' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'devSettings', 'singleton')));
  });

  it('denies a non-admin member from writing the settings', async () => {
    const db = testEnv.authenticatedContext('uid-kid', { email: 'kid@e.org' }).firestore();
    await assertFails(setDoc(doc(db, 'devSettings', 'singleton'), settings));
  });

  it('denies an unauthenticated caller from reading the settings', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'devSettings', 'singleton')));
  });
});

describe.skipIf(!reachable)('firestore.rules — weatherForecast (issue #382)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    // The cache is written by the refreshWeatherForecast CF (Admin SDK, bypasses
    // rules); seed one with rules disabled so the read assertions have a doc.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'weatherForecast', 'singleton'), forecast);
    });
  });

  const forecast = {
    days: {},
    fetchedAt: 0,
    location: { latitude: 51.5085, longitude: -0.1257, timezone: 'Europe/London', label: 'Home' },
    timezone: 'Europe/London',
  };

  it('lets any signed-in user read the forecast singleton', async () => {
    const db = testEnv.authenticatedContext('uid-kid', { email: 'kid@e.org' }).firestore();
    await assertSucceeds(getDoc(doc(db, 'weatherForecast', 'singleton')));
  });

  it('denies a signed-in client from writing the forecast directly', async () => {
    // Clients only ever trigger a refresh via the callable; the doc is written by
    // the CF Admin SDK, so direct client writes (even by an admin) are closed.
    const db = testEnv.authenticatedContext('uid-admin', { email: 'admin@e.org' }).firestore();
    await assertFails(setDoc(doc(db, 'weatherForecast', 'singleton'), forecast));
  });

  it('denies an unauthenticated caller from reading the forecast', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'weatherForecast', 'singleton')));
  });
});

describe.skipIf(!reachable)('firestore.rules — canonEmbeddings server-only (issue #410)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    // Vectors are written by the CF match path (Admin SDK, bypasses rules); seed
    // one with rules disabled so the read-deny assertion has a doc to be denied.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'canonEmbeddings', 'c1'), { embedding: [0.1, 0.2] });
    });
  });

  // The whole point of #410: the collection is server-only. Unlike canonItems
  // (open read/write to any signed-in user), NO client — signed-in or not — may
  // read or write canonEmbeddings, so the browser never syncs vectors it never
  // uses. The CF match path reaches it via the Admin SDK, which bypasses rules.
  it('denies a signed-in user from reading a canonEmbeddings doc', async () => {
    const db = testEnv.authenticatedContext('uid-user', { email: 'user@e.org' }).firestore();
    await assertFails(getDoc(doc(db, 'canonEmbeddings', 'c1')));
  });

  it('denies a signed-in user from writing a canonEmbeddings doc', async () => {
    const db = testEnv.authenticatedContext('uid-user', { email: 'user@e.org' }).firestore();
    await assertFails(setDoc(doc(db, 'canonEmbeddings', 'c2'), { embedding: [0.3] }));
  });

  it('denies an unauthenticated caller on canonEmbeddings', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'canonEmbeddings', 'c1')));
  });
});

describe.skipIf(!reachable)('firestore.rules — notes collection removed (issue #408)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  // The old `notes` rule allowed unauthenticated reads (`allow read: if true`).
  // The block was deleted, so `notes` now falls through to the terminal
  // default-deny — no caller (authed or not) may read or write it.
  it('denies an unauthenticated caller from reading notes', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'notes', 'n1')));
  });

  it('denies a signed-in user from reading or writing notes', async () => {
    const db = testEnv.authenticatedContext('uid-user', { email: 'user@e.org' }).firestore();
    await assertFails(getDoc(doc(db, 'notes', 'n1')));
    await assertFails(setDoc(doc(db, 'notes', 'n1'), { text: 'hi' }));
  });
});

describe.skipIf(!reachable)('firestore.rules — chatSessions ownerUid (issue #206, #408)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  const session = (ownerUid: string) => ({
    ownerUid,
    title: 'Chat',
    schemaVersion: 1,
    updatedAt: '2026-07-03T00:00:00.000Z',
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    // Seed a session owned by uid-a with rules disabled.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'chatSessions', 's1'), session('uid-a'));
    });
  });

  function ownerDb() {
    return testEnv.authenticatedContext('uid-a', { email: 'a@e.org' }).firestore();
  }
  function otherDb() {
    return testEnv.authenticatedContext('uid-b', { email: 'b@e.org' }).firestore();
  }

  it('lets the owner create a session with their own uid', async () => {
    const db = ownerDb();
    await assertSucceeds(setDoc(doc(db, 'chatSessions', 's2'), session('uid-a')));
  });

  it('denies creating a session owned by someone else', async () => {
    const db = ownerDb();
    await assertFails(setDoc(doc(db, 'chatSessions', 's3'), session('uid-b')));
  });

  it('lets the owner read, update (keeping ownerUid), and delete their session', async () => {
    const db = ownerDb();
    await assertSucceeds(getDoc(doc(db, 'chatSessions', 's1')));
    await assertSucceeds(updateDoc(doc(db, 'chatSessions', 's1'), { title: 'Renamed' }));
    await assertSucceeds(deleteDoc(doc(db, 'chatSessions', 's1')));
  });

  // The core #408 fix: an owner must not be able to reassign ownerUid, which
  // would plant a session in another user's list.
  it('denies the owner reassigning ownerUid to another user', async () => {
    const db = ownerDb();
    await assertFails(updateDoc(doc(db, 'chatSessions', 's1'), { ownerUid: 'uid-b' }));
  });

  it("denies a non-owner from reading or writing another user's session", async () => {
    const db = otherDb();
    await assertFails(getDoc(doc(db, 'chatSessions', 's1')));
    await assertFails(updateDoc(doc(db, 'chatSessions', 's1'), { title: 'hijack' }));
    await assertFails(deleteDoc(doc(db, 'chatSessions', 's1')));
  });

  it('denies an unauthenticated caller on chatSessions', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'chatSessions', 's1')));
  });
});

// cookSessions is the second (and only other) owner-scoped collection in an
// otherwise entirely family-shared data model, and its rule is the ONLY thing
// stopping one household member from reading another's in-progress cook. The
// cook-mode e2e only ever runs as a single user, so it exercises the permit side
// and never the deny side — that is the gap these cover (issue #558).
//
// The deterministic id (`cookSessionId`'s `${recipeId}_${uid}`) is a convention,
// not an enforcement: the rules never parse the id, so every assertion here is
// about the `ownerUid` FIELD. A doc id that embeds another user's uid buys no
// access, and one that embeds your own buys none either if the field disagrees.
describe.skipIf(!reachable)('firestore.rules — cookSessions ownerUid (issue #558)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  const session = (ownerUid: string, recipeId = 'recipe-1') => ({
    id: `${recipeId}_${ownerUid}`,
    schemaVersion: 1,
    ownerUid,
    recipeId,
    recipeUpdatedAtAtStart: '2026-07-24T00:00:00.000Z',
    checkedIngredientIds: [],
    completedStepIds: [],
    activeTimers: [],
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  });

  // uid-a's in-progress cook of recipe-1, seeded with rules disabled.
  const A_SESSION = 'recipe-1_uid-a';

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'cookSessions', A_SESSION), session('uid-a'));
    });
  });

  function ownerDb() {
    return testEnv.authenticatedContext('uid-a', { email: 'a@e.org' }).firestore();
  }
  function otherDb() {
    return testEnv.authenticatedContext('uid-b', { email: 'b@e.org' }).firestore();
  }

  it('lets the owner create a session with their own uid', async () => {
    const db = ownerDb();
    await assertSucceeds(
      setDoc(doc(db, 'cookSessions', 'recipe-2_uid-a'), session('uid-a', 'recipe-2')),
    );
  });

  it('denies creating a session owned by someone else', async () => {
    const db = ownerDb();
    await assertFails(
      setDoc(doc(db, 'cookSessions', 'recipe-2_uid-b'), session('uid-b', 'recipe-2')),
    );
  });

  it('lets the owner read, update (keeping ownerUid), and delete their session', async () => {
    const db = ownerDb();
    await assertSucceeds(getDoc(doc(db, 'cookSessions', A_SESSION)));
    await assertSucceeds(
      updateDoc(doc(db, 'cookSessions', A_SESSION), { checkedIngredientIds: ['ing-1'] }),
    );
    await assertSucceeds(deleteDoc(doc(db, 'cookSessions', A_SESSION)));
  });

  // The owner must not be able to reassign ownerUid, which would plant a cook
  // session in another user's list (the chatSessions #408 fix, mirrored here).
  it('denies the owner reassigning ownerUid to another user', async () => {
    const db = ownerDb();
    await assertFails(updateDoc(doc(db, 'cookSessions', A_SESSION), { ownerUid: 'uid-b' }));
  });

  // The load-bearing assertion: a signed-in household member is NOT entitled to
  // another member's cook session just by being signed in, unlike every
  // family-shared collection in the app.
  it("denies a non-owner from reading, updating or deleting another user's session", async () => {
    const db = otherDb();
    await assertFails(getDoc(doc(db, 'cookSessions', A_SESSION)));
    await assertFails(updateDoc(doc(db, 'cookSessions', A_SESSION), { checkedIngredientIds: [] }));
    await assertFails(deleteDoc(doc(db, 'cookSessions', A_SESSION)));
  });

  // A non-owner cannot take the doc over by overwriting it either: setDoc on an
  // existing doc is an update, so the pinned-ownerUid clause rejects it whether
  // the payload claims uid-a (fails the existing-owner check) or uid-b (fails
  // the pin). Without this, "read is denied" would still leave a clobber open.
  it("denies a non-owner from overwriting another user's session wholesale", async () => {
    const db = otherDb();
    await assertFails(setDoc(doc(db, 'cookSessions', A_SESSION), session('uid-b')));
    await assertFails(setDoc(doc(db, 'cookSessions', A_SESSION), session('uid-a')));
  });

  // The `resource == null` clause (#558). The cook page subscribes to the
  // deterministic id BEFORE bootstrapping the session, so a signed-in user must
  // be able to read an id that holds nothing yet — without this the listener is
  // denied and torn down permanently on every first cook. Absence carries no
  // data, so this grants no access to anyone's session.
  it('lets a signed-in user read a session id that does not exist yet', async () => {
    await assertSucceeds(getDoc(doc(ownerDb(), 'cookSessions', 'recipe-9_uid-a')));
    // Including one keyed to another user — there is nothing there to read, and
    // the moment uid-b creates it the deny assertions above take over.
    await assertSucceeds(getDoc(doc(otherDb(), 'cookSessions', 'recipe-9_uid-a')));
  });

  // Same clause on delete: the deleted-recipe orphan cleanup fires
  // removeCookSession for an id that may never have been created.
  it('lets a signed-in user delete a session id that does not exist yet', async () => {
    await assertSucceeds(deleteDoc(doc(ownerDb(), 'cookSessions', 'recipe-9_uid-a')));
  });

  it('denies an unauthenticated caller on cookSessions', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'cookSessions', A_SESSION)));
    await assertFails(setDoc(doc(db, 'cookSessions', 'recipe-3_anon'), session('uid-a')));
    // The absent-doc allowance is scoped to signed-in callers, not everyone.
    await assertFails(getDoc(doc(db, 'cookSessions', 'recipe-9_uid-a')));
  });
});

describe.skipIf(!reachable)('firestore.rules — shoppingDays (issue #629)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  const SHOP_DATE = '2026-08-15';
  const shopDay = (setBy: string) => ({
    date: SHOP_DATE,
    slot: 'am',
    schemaVersion: 1,
    setBy,
    setAt: '2026-08-10T09:00:00.000Z',
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  it('lets any signed-in user mark, read and clear a shop day', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(setDoc(doc(db, 'shoppingDays', SHOP_DATE), shopDay('uid-a')));
    await assertSucceeds(getDoc(doc(db, 'shoppingDays', SHOP_DATE)));
    await assertSucceeds(deleteDoc(doc(db, 'shoppingDays', SHOP_DATE)));
  });

  // The load-bearing difference from the owner-scoped collections: when the
  // household shops is FAMILY-SHARED, and `setBy` is an audit field that is
  // deliberately NOT pinned — either of them may reschedule the other's shop.
  it('lets another member move a shop day someone else set', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'shoppingDays', SHOP_DATE), shopDay('uid-a'));
    });
    const db = userCtx('uid-b');
    await assertSucceeds(setDoc(doc(db, 'shoppingDays', SHOP_DATE), shopDay('uid-b')));
    await assertSucceeds(deleteDoc(doc(db, 'shoppingDays', SHOP_DATE)));
  });

  // The planner reads a week as a range over doc ids, so the collection itself
  // must be listable by a signed-in member.
  it('lets a signed-in user read the collection', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(getDocs(collection(db, 'shoppingDays')));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'shoppingDays', SHOP_DATE)));
    await assertFails(getDocs(collection(db, 'shoppingDays')));
    await assertFails(setDoc(doc(db, 'shoppingDays', SHOP_DATE), shopDay('anon')));
    await assertFails(deleteDoc(doc(db, 'shoppingDays', SHOP_DATE)));
  });
});

describe.skipIf(!reachable)('firestore.rules — guidedPlans (issue #751)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  const PLAN_RECIPE = 'recipe-1';
  const plan = () => ({
    id: PLAN_RECIPE,
    schemaVersion: 1,
    recipeId: PLAN_RECIPE,
    recipeUpdatedAtAtSave: '2026-08-01T09:00:00.000Z',
    prep: [{ id: 'prep-1', text: 'Dice the onion', container: 'bowl', ingredientIds: ['ing-1'] }],
    stepNotes: [],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  it('lets any signed-in user write, read and clear a plan', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(setDoc(doc(db, 'guidedPlans', PLAN_RECIPE), plan()));
    await assertSucceeds(getDoc(doc(db, 'guidedPlans', PLAN_RECIPE)));
    await assertSucceeds(deleteDoc(doc(db, 'guidedPlans', PLAN_RECIPE)));
  });

  // The load-bearing property: a plan is FAMILY-SHARED, like the recipe it
  // describes, and carries no ownerUid. Either member may re-run or hand-correct
  // the other's plan — this is deliberately NOT a fourth per-user collection.
  it('lets another member overwrite a plan someone else wrote', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'guidedPlans', PLAN_RECIPE), plan());
    });
    const db = userCtx('uid-b');
    await assertSucceeds(setDoc(doc(db, 'guidedPlans', PLAN_RECIPE), plan()));
    await assertSucceeds(getDoc(doc(db, 'guidedPlans', PLAN_RECIPE)));
  });

  // The deterministic id means the editor subscribes to the plan for a recipe that
  // has none. Unlike cookSessions this needs no `resource == null` clause — the
  // rule never dereferences resource.data — but the BEHAVIOUR is what matters, so
  // it is pinned here rather than assumed.
  it('lets a signed-in user read a plan id that does not exist yet', async () => {
    await assertSucceeds(getDoc(doc(userCtx('uid-a'), 'guidedPlans', 'recipe-never-planned')));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'guidedPlans', PLAN_RECIPE)));
    await assertFails(getDocs(collection(db, 'guidedPlans')));
    await assertFails(setDoc(doc(db, 'guidedPlans', PLAN_RECIPE), plan()));
    await assertFails(deleteDoc(doc(db, 'guidedPlans', PLAN_RECIPE)));
  });
});

describe.skipIf(!reachable)('firestore.rules — formulas (issue #806)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  const FORMULA_RECIPE = 'recipe-1';
  // The overnight white tin as baker's percentages against its flour.
  const formula = () => ({
    recipeId: FORMULA_RECIPE,
    schemaVersion: 1,
    components: [
      { ingredientId: 'ing-flour', percent: 100, inBasis: true },
      { ingredientId: 'ing-water', percent: 70, inBasis: false },
    ],
    referenceYield: {
      kind: 'target',
      shape: { count: 1, unitDoughGrams: 900 },
    },
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  it('lets any signed-in user write, read and clear a formula', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(setDoc(doc(db, 'formulas', FORMULA_RECIPE), formula()));
    await assertSucceeds(getDoc(doc(db, 'formulas', FORMULA_RECIPE)));
    await assertSucceeds(deleteDoc(doc(db, 'formulas', FORMULA_RECIPE)));
  });

  // The load-bearing property: a formula is FAMILY-SHARED, like the recipe it
  // describes, and carries no ownerUid. Either member may re-map or correct the
  // other's — this is deliberately NOT a per-user collection.
  it('lets another member overwrite a formula someone else wrote', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'formulas', FORMULA_RECIPE), formula());
    });
    const db = userCtx('uid-b');
    await assertSucceeds(setDoc(doc(db, 'formulas', FORMULA_RECIPE), formula()));
    await assertSucceeds(getDoc(doc(db, 'formulas', FORMULA_RECIPE)));
  });

  // The deterministic id means the screen subscribes to the formula for a recipe
  // that has none — on EVERY first visit, since deriving the guess is what the
  // page opens with. Unlike cookSessions this needs no `resource == null` clause,
  // because the rule never dereferences resource.data — but the BEHAVIOUR is what
  // matters, so it is pinned here rather than assumed.
  it('lets a signed-in user read a formula id that does not exist yet', async () => {
    await assertSucceeds(getDoc(doc(userCtx('uid-a'), 'formulas', 'recipe-never-mapped')));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'formulas', FORMULA_RECIPE)));
    await assertFails(getDocs(collection(db, 'formulas')));
    await assertFails(setDoc(doc(db, 'formulas', FORMULA_RECIPE), formula()));
    await assertFails(deleteDoc(doc(db, 'formulas', FORMULA_RECIPE)));
  });
});

describe.skipIf(!reachable)('firestore.rules — batches (issue #812)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  // A random UUID, not a recipe id: a recipe has many runs.
  const BATCH_ID = 'batch-8f21c0d4';
  // One run of the overnight white tin, scaled to twelve rolls and back-solved so
  // the bake ends at 07:30.
  const batch = () => ({
    id: BATCH_ID,
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    quantities: [
      { ingredientId: 'ing-flour', label: '500g strong white flour', percent: 100, grams: 841 },
    ],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages: [
      {
        id: 'bake',
        label: 'Bake',
        kind: 'active',
        environment: null,
        duration: { kind: 'fixed', minutes: 45 },
        until: null,
        stepId: null,
        plannedStartAt: '2026-08-15T06:45:00.000Z',
        plannedEndAt: '2026-08-15T07:30:00.000Z',
        actualStartAt: null,
        actualEndAt: null,
      },
    ],
    rationale: null,
    createdAt: '2026-08-14T21:00:00.000Z',
    updatedAt: '2026-08-14T21:00:00.000Z',
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  it('lets any signed-in user write, read and clear a batch', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(setDoc(doc(db, 'batches', BATCH_ID), batch()));
    await assertSucceeds(getDoc(doc(db, 'batches', BATCH_ID)));
    await assertSucceeds(deleteDoc(doc(db, 'batches', BATCH_ID)));
  });

  // The load-bearing property, and here it is a household behaviour rather than a
  // symmetry: either partner may glance at the crock, mark the prove done and take
  // the loaf out. A batch carries NO ownerUid and is not per-user state.
  it('lets another member advance a batch someone else started', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'batches', BATCH_ID), batch());
    });
    const db = userCtx('uid-b');
    await assertSucceeds(setDoc(doc(db, 'batches', BATCH_ID), batch()));
    await assertSucceeds(getDoc(doc(db, 'batches', BATCH_ID)));
    // And the whole collection, which is what the in-flight surface subscribes to.
    await assertSucceeds(getDocs(collection(db, 'batches')));
  });

  // Unlike guidedPlans and formulas the id is random, so nobody subscribes to a
  // batch that was never written — but this rule dereferences no `resource.data`
  // either way, and pinning the behaviour costs one line.
  it('lets a signed-in user read a batch id that does not exist yet', async () => {
    await assertSucceeds(getDoc(doc(userCtx('uid-a'), 'batches', 'batch-never-started')));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'batches', BATCH_ID)));
    await assertFails(getDocs(collection(db, 'batches')));
    await assertFails(setDoc(doc(db, 'batches', BATCH_ID), batch()));
    await assertFails(deleteDoc(doc(db, 'batches', BATCH_ID)));
  });
});

/**
 * The observation log (issue #812, phase 4 of epic #778).
 *
 * A SUBCOLLECTION under the run — `batches/{batchId}/observations/{id}` — because
 * the log is append-only over weeks and two people logging a weight on the same day
 * must not clobber each other under document-level LWW. A subcollection rule is not
 * inherited from its parent in Firestore, so the nesting has to be written out; this
 * block is what proves it was, and that it gates the child exactly as the parent is
 * gated (the shoppingLists/{listId}/items precedent).
 */
describe.skipIf(!reachable)('firestore.rules — batch observations (issue #812)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  const BATCH_ID = 'batch-8f21c0d4';
  const OBSERVATION_ID = 'obs-3c19';

  // Day nine of the coppa: 1,240 g, twelve degrees, and it smells right.
  const observation = (id = OBSERVATION_ID) => ({
    id,
    schemaVersion: 1,
    at: '2026-08-14T08:10:00.000Z',
    weightGrams: 1240,
    ph: null,
    temperatureC: 12,
    note: 'Bloom even, smells sweet.',
    image: null,
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  function observationsPath(db: ReturnType<typeof userCtx>) {
    return collection(db, 'batches', BATCH_ID, 'observations');
  }

  it('lets any signed-in user write, read and list an observation', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(
      setDoc(doc(db, 'batches', BATCH_ID, 'observations', OBSERVATION_ID), observation()),
    );
    await assertSucceeds(getDoc(doc(db, 'batches', BATCH_ID, 'observations', OBSERVATION_ID)));
    await assertSucceeds(getDocs(observationsPath(db)));
  });

  // The load-bearing property, and the whole reason this is a subcollection: two
  // people logging on the same day write two documents, so neither can clobber the
  // other's reading under LWW. Family-shared, no ownerUid, no pinning.
  it('lets another member log against a batch someone else started', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'batches', BATCH_ID, 'observations', OBSERVATION_ID),
        observation(),
      );
    });
    const db = userCtx('uid-b');
    await assertSucceeds(
      setDoc(doc(db, 'batches', BATCH_ID, 'observations', 'obs-second'), observation('obs-second')),
    );
    await assertSucceeds(getDoc(doc(db, 'batches', BATCH_ID, 'observations', OBSERVATION_ID)));
    await assertSucceeds(getDocs(observationsPath(db)));
  });

  // The log screen subscribes the moment a run is opened, which is usually before
  // anything has been logged. This rule dereferences no `resource.data`, so an empty
  // subcollection is read and allowed on `request.auth` alone.
  it('lets a signed-in user read a log that has nothing in it yet', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(getDocs(collection(db, 'batches', 'batch-never-started', 'observations')));
    await assertSucceeds(getDoc(doc(db, 'batches', BATCH_ID, 'observations', 'obs-never-written')));
  });

  // The log is append-only by design, but the rule does not enforce that — a
  // mis-typed weight is corrected by re-writing the same id, and a member may clear
  // an entry outright. Salt has no soft-delete: a delete is a real delete.
  it('lets a signed-in user correct and clear an entry', async () => {
    const db = userCtx('uid-a');
    const ref = doc(db, 'batches', BATCH_ID, 'observations', OBSERVATION_ID);
    await assertSucceeds(setDoc(ref, observation()));
    await assertSucceeds(setDoc(ref, { ...observation(), weightGrams: 1204 }));
    await assertSucceeds(deleteDoc(ref));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    const ref = doc(db, 'batches', BATCH_ID, 'observations', OBSERVATION_ID);
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(db, 'batches', BATCH_ID, 'observations')));
    await assertFails(setDoc(ref, observation()));
    await assertFails(deleteDoc(ref));
  });
});

describe.skipIf(!reachable)('firestore.rules — kitchenMemories (issue #816)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  const MEMORY_ID = 'memory-1';
  const memory = (author = 'Daniel') => ({
    id: MEMORY_ID,
    schemaVersion: 1,
    text: 'We hate coriander.',
    author,
    createdAt: '2026-08-15T09:00:00.000Z',
  });

  function userCtx(uid: string) {
    return testEnv.authenticatedContext(uid, { email: `${uid}@e.org` }).firestore();
  }

  it('lets any signed-in user write, read and clear a note', async () => {
    const db = userCtx('uid-a');
    await assertSucceeds(setDoc(doc(db, 'kitchenMemories', MEMORY_ID), memory()));
    await assertSucceeds(getDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
    await assertSucceeds(getDocs(collection(db, 'kitchenMemories')));
    await assertSucceeds(deleteDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
  });

  // THE load-bearing property. A note is family-shared and carries no ownerUid:
  // either member may correct or clear the other's, because a standing note about
  // how this household cooks belongs to the household, not to whoever typed it.
  it('lets another member overwrite and delete a note someone else wrote', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'kitchenMemories', MEMORY_ID), memory('Daniel'));
    });
    const db = userCtx('uid-b');
    await assertSucceeds(getDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
    await assertSucceeds(setDoc(doc(db, 'kitchenMemories', MEMORY_ID), memory('Ana')));
    await assertSucceeds(deleteDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
    await assertFails(getDocs(collection(db, 'kitchenMemories')));
    await assertFails(setDoc(doc(db, 'kitchenMemories', MEMORY_ID), memory()));
    await assertFails(deleteDoc(doc(db, 'kitchenMemories', MEMORY_ID)));
  });
});

// kitchenTimers is the FOURTH owner-scoped collection (issue #842), and its rule
// is the only owner-scoped one that keys on the PATH SEGMENT rather than on a
// stored field — the document id simply is the uid. These cover both halves of
// that: that the path is genuinely what enforces privacy, and that the stored
// `ownerUid` cannot be made to disagree with it (the delivery trigger reads that
// field to decide whose phone to ring).
//
// The absence of a `resource == null` clause is deliberate and is asserted here
// too, because the established pattern says otherwise and someone will otherwise
// "restore" it: reading and deleting one's own ABSENT document must succeed, and
// it does without the clause, because no rule below dereferences `resource.data`.
describe.skipIf(!reachable)('firestore.rules — kitchenTimers ownerUid (issue #842)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: HOST,
        port: PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  const timers = (ownerUid: string) => ({
    ownerUid,
    timers: [
      {
        id: 't1',
        label: 'Eggs',
        endsAt: '2026-08-16T18:10:00.000Z',
        durationMinutes: 10,
        notify: true,
      },
    ],
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'kitchenTimers', 'uid-a'), timers('uid-a'));
    });
  });

  function ownerDb() {
    return testEnv.authenticatedContext('uid-a', { email: 'a@e.org' }).firestore();
  }
  function otherDb() {
    return testEnv.authenticatedContext('uid-b', { email: 'b@e.org' }).firestore();
  }

  it('lets me read, rewrite and clear my own timers', async () => {
    const db = ownerDb();
    await assertSucceeds(getDoc(doc(db, 'kitchenTimers', 'uid-a')));
    await assertSucceeds(setDoc(doc(db, 'kitchenTimers', 'uid-a'), timers('uid-a')));
    await assertSucceeds(deleteDoc(doc(db, 'kitchenTimers', 'uid-a')));
  });

  // THE load-bearing property, and the reason this is a collection rather than a
  // field: my partner does not see my egg timer, and Firestore is what says so.
  it('denies another member reading, writing or deleting my timers', async () => {
    const db = otherDb();
    await assertFails(getDoc(doc(db, 'kitchenTimers', 'uid-a')));
    await assertFails(setDoc(doc(db, 'kitchenTimers', 'uid-a'), timers('uid-a')));
    await assertFails(updateDoc(doc(db, 'kitchenTimers', 'uid-a'), { timers: [] }));
    await assertFails(deleteDoc(doc(db, 'kitchenTimers', 'uid-a')));
  });

  // Claiming someone else's document by putting their uid in the FIELD buys
  // nothing — the path is checked first and independently.
  it('denies writing to another uid’s document even with a matching ownerUid field', async () => {
    await assertFails(setDoc(doc(otherDb(), 'kitchenTimers', 'uid-a'), timers('uid-a')));
  });

  // ...and the field cannot be made to disagree with the path either, because
  // onKitchenTimerDispatch reads it to decide whose devices to ring.
  it('denies writing my own document with somebody else’s ownerUid', async () => {
    await assertFails(setDoc(doc(ownerDb(), 'kitchenTimers', 'uid-a'), timers('uid-b')));
  });

  // No `resource == null` clause needed, and none present: the id is the uid, so
  // the rule never dereferences an absent document's data.
  it('lets me read and delete my own document before it exists', async () => {
    await testEnv.clearFirestore();
    const db = ownerDb();
    await assertSucceeds(getDoc(doc(db, 'kitchenTimers', 'uid-a')));
    await assertSucceeds(deleteDoc(doc(db, 'kitchenTimers', 'uid-a')));
  });

  it('lets me create my document for the very first time', async () => {
    await testEnv.clearFirestore();
    await assertSucceeds(setDoc(doc(ownerDb(), 'kitchenTimers', 'uid-a'), timers('uid-a')));
  });

  it('denies an unauthenticated caller entirely', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'kitchenTimers', 'uid-a')));
    await assertFails(setDoc(doc(db, 'kitchenTimers', 'uid-a'), timers('uid-a')));
    await assertFails(deleteDoc(doc(db, 'kitchenTimers', 'uid-a')));
  });
});
