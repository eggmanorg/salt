/**
 * Emulator integration test for the beforeMemberCreated auth blocking function
 * (issue #301; refs #155, #291).
 *
 * WHY THIS EXISTS — the unit test (beforeMemberCreated.test.ts) mocks Firestore,
 * so it proves the lookup *key* and the throw/allow branches but never that a
 * real `members/{normalisedEmail}` doc is actually found by the real Admin SDK
 * query. #301 flags exactly that: the allowlist gate is security-adjacent and
 * its enforcement was only exercised incidentally as e2e setup. This test drives
 * the gate against the REAL Firestore emulator with a real seeded allowlist, so
 * allowlisted → allow and non-allowlisted → reject are asserted end-to-end,
 * including that email normalisation resolves to the seeded doc id.
 *
 * WHY DIRECT INVOCATION (not a real account-creation) — Firebase blocking
 * functions (beforeUserCreated) are identity middleware Firebase invokes
 * internally, and the isolated Vitest emulator stack runs Firestore + Auth only
 * (no Functions emulator; docker/test-emulators/docker-compose.vitest.yml). So,
 * as with every other *.emulator.test.ts, the handler is extracted from the
 * decorator and invoked directly while Firestore is REAL. Driving a genuine
 * Auth-emulator sign-in through the deployed blocking function is intentionally
 * out of scope — the costly/flaky path #291 kept Auth at smoke depth.
 *
 * Requires the Firestore emulator reachable on the port injected by
 * vitest.emulator.config.ts `test.env` (issue #84, Phase 3 — the isolated
 * Vitest stack); falls back to the dev port 8080 for an ad-hoc run.
 * Run via: pnpm test:emulator
 */

// Point the Admin SDK at the Firestore emulator before any imports. The port
// comes from the isolated Vitest stack (injected via test.env) so this no
// longer pins to the dev emulator (8080 stays only as the ad-hoc fallback).
process.env['FIRESTORE_EMULATOR_HOST'] =
  `127.0.0.1:${process.env['VITE_EMULATOR_FIRESTORE_PORT'] ?? '8080'}`;

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Member } from '@salt/domain';

// ─── Mocks (everything except firebase-admin/firestore + @salt/domain) ───────
// beforeUserCreated(opts, handler) returns the handler so we can invoke it
// directly. HttpsError is a minimal stand-in recording its code + message
// (matches the sibling unit test). Firestore and @salt/domain stay REAL so the
// allowlist read and normaliseMemberEmail run for real against the emulator.

class FakeHttpsError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock('firebase-functions/identity', () => ({
  beforeUserCreated: (_opts: unknown, handler: unknown) => handler,
  HttpsError: FakeHttpsError,
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks.
const { beforeMemberCreated } = await import('../../src/auth/beforeMemberCreated.js');
const handler = beforeMemberCreated as unknown as (event: {
  data?: { email?: string };
}) => Promise<void>;

// ─── Setup ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'demo-salt';
// Single source: the host resolved above for the Admin SDK is reused for the
// REST clear endpoint so both hit the same (Vitest stack) emulator.
const EMULATOR_HOST = process.env['FIRESTORE_EMULATOR_HOST'] as string;

let adminApp: App;

// Shaped like a real member doc (seed-admin-member.mjs / MemberSchema). The gate
// only checks existence, so `admin` never affects the outcome — asserted below.
function makeMember(email: string, admin = false): Member {
  return {
    id: email,
    schemaVersion: 1,
    name: 'Test Member',
    email,
    admin,
    cookMode: 'standard',
    system: false,
    sortOrder: 0,
    icon: null,
    updatedAt: new Date().toISOString(),
  };
}

async function seedMember(member: Member): Promise<void> {
  await getFirestore(adminApp).collection('members').doc(member.id).set(member);
}

async function clearEmulator(): Promise<void> {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Failed to clear emulator: HTTP ${resp.status}`);
  }
}

beforeAll(() => {
  // Default (unnamed) app: the handler acquires Firestore via getFirestore()
  // with no app argument, so the test must seed/assert through the same default
  // app or the handler throws "default Firebase app does not exist".
  adminApp = initializeApp({ projectId: PROJECT_ID });
});

afterAll(async () => {
  await deleteApp(adminApp);
});

beforeEach(async () => {
  await clearEmulator();
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('beforeMemberCreated — Firestore emulator (allowlist enforcement)', () => {
  it('allows an email whose member doc exists in the real allowlist', async () => {
    await seedMember(makeMember('daniel@pendery.org', true));
    await expect(handler({ data: { email: 'daniel@pendery.org' } })).resolves.toBeUndefined();
  });

  it('allows a non-admin member (the gate does not distinguish admin)', async () => {
    // Admin vs non-admin is irrelevant to sign-in enforcement (#301): presence
    // on the allowlist is the whole gate. A non-admin member is still allowed.
    await seedMember(makeMember('member@pendery.org', false));
    await expect(handler({ data: { email: 'member@pendery.org' } })).resolves.toBeUndefined();
  });

  it('resolves a casing/whitespace variant to the normalised member doc', async () => {
    // Seeded lowercase; the incoming email is mixed-case and padded. The real
    // doc-id lookup must still find it — proving normalisation closes the
    // casing/whitespace bypass end-to-end, not just at the mocked lookup key.
    await seedMember(makeMember('daniel@pendery.org', true));
    await expect(handler({ data: { email: '  Daniel@Pendery.ORG ' } })).resolves.toBeUndefined();
  });

  it('rejects an email with no matching member doc', async () => {
    // Allowlist holds a different member; the stranger is genuinely absent from
    // real Firestore, so the read returns !exists and the gate denies.
    await seedMember(makeMember('daniel@pendery.org', true));
    await expect(handler({ data: { email: 'stranger@evil.com' } })).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('not on the Salt member list'),
    });
  });

  it('rejects every email when the members collection is empty', async () => {
    await expect(handler({ data: { email: 'anyone@pendery.org' } })).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('not on the Salt member list'),
    });
  });

  it('rejects an account with no email (before any allowlist read)', async () => {
    await expect(handler({ data: {} })).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('email address is required'),
    });
  });
});
