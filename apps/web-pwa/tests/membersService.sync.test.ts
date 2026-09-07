import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import { memberFirstName, type Member } from '@salt/domain';

vi.mock('@salt/firebase-sync', () => ({
  subscribeMembers: vi.fn(),
  upsertMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // Reached via the service's onError → reportSubscriptionError, which consults
  // it on the AuthError branch only (issue #1053). The stream-error case below
  // fires an AuthError, so the mock must carry it or the module namespace throws.
  isAuthTransitioning: vi.fn(() => false),
}));

// The service resolves the signed-in member itself now (issue #634), so it reads
// the auth store. Mock it rather than booting Firebase.
const mockAuth = vi.hoisted(() => ({ user: null as { email: string } | null }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));

import * as firebaseSync from '@salt/firebase-sync';
import {
  members,
  people,
  systemAccountNames,
  currentMember,
  kitchenLabel,
  isLoadingMembers,
  initMembersSync,
  createMemberEntry,
  updateMemberEntry,
  deleteMemberEntry,
  findMemberByEmail,
  isEmailAdmin,
  seedMembers,
  __resetMembersServiceForTest,
} from '../src/lib/membersService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

type MembersCb = (members: Member[]) => void;

function wireSubscription(): { emit: (m: Member[]) => void; unsub: ReturnType<typeof vi.fn> } {
  const unsub = vi.fn();
  let cb: MembersCb | null = null;
  fs.subscribeMembers.mockImplementation((onMembers) => {
    cb = onMembers as MembersCb;
    return unsub;
  });
  return { emit: (m) => cb!(m), unsub };
}

function member(overrides: Partial<Member> & { id: string }): Member {
  return {
    schemaVersion: 1,
    name: 'Person',
    email: overrides.id,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  __resetMembersServiceForTest();
  vi.clearAllMocks();
  fs.upsertMember.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.deleteMember.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('membersService — subscription-fed store', () => {
  it('exposes members in sorted order and clears loading on first snapshot', () => {
    const { emit } = wireSubscription();
    initMembersSync();
    expect(get(isLoadingMembers)).toBe(true);

    emit([
      member({ id: 'b@e.org', name: 'Bob', sortOrder: 2 }),
      member({ id: 'a@e.org', name: 'Ann', sortOrder: 1 }),
    ]);

    expect(get(isLoadingMembers)).toBe(false);
    expect(get(members).map((m) => m.name)).toEqual(['Ann', 'Bob']);
  });

  it('stops loading when the stream errors', () => {
    const unsub = vi.fn();
    let errCb: ((e: unknown) => void) | null = null;
    fs.subscribeMembers.mockImplementation((_on, onError) => {
      errCb = onError as (e: unknown) => void;
      return unsub;
    });
    initMembersSync();
    errCb!({ kind: 'AuthError', reason: 'forbidden' });
    expect(get(isLoadingMembers)).toBe(false);
  });
});

describe('membersService — admin resolution', () => {
  beforeEach(() => {
    seedMembers([
      member({ id: 'admin@e.org', name: 'Admin', admin: true }),
      member({ id: 'plain@e.org', name: 'Plain', admin: false }),
    ]);
  });

  it('findMemberByEmail matches case-insensitively', () => {
    expect(findMemberByEmail('  Admin@E.ORG ')?.id).toBe('admin@e.org');
  });

  it('isEmailAdmin true for admin, false for non-admin and unknown', () => {
    expect(isEmailAdmin('admin@e.org')).toBe(true);
    expect(isEmailAdmin('plain@e.org')).toBe(false);
    expect(isEmailAdmin('ghost@e.org')).toBe(false);
    expect(isEmailAdmin(null)).toBe(false);
  });
});

// uid → normalised email → member id is the WHOLE of personalisation in Salt
// (issue #634): every collection is family-shared, so "mine" is a filter over
// shared documents, never a per-user store.
describe('membersService — currentMember', () => {
  beforeEach(() => {
    seedMembers([
      member({ id: 'admin@e.org', name: 'Admin', admin: true }),
      member({ id: 'plain@e.org', name: 'Plain' }),
    ]);
  });

  // One test, walked forwards: the email side of `currentMember` is bridged out
  // of the RUNE-based auth store, and the mock here is a plain object, so the
  // bridge only notices a value it has not seen before. In the app `auth.user` is
  // `$state` and every transition propagates — including back to signed out.
  it('resolves the signed-in user to their member record, and to null otherwise', () => {
    mockAuth.user = null;
    expect(get(currentMember)).toBeNull();

    mockAuth.user = { email: '  Plain@E.ORG ' };
    expect(get(currentMember)?.id).toBe('plain@e.org'); // normalised before matching

    mockAuth.user = { email: 'ghost@e.org' };
    expect(get(currentMember)).toBeNull(); // signed in, but not on the roster
  });
});

// How a member is NAMED on screen, anywhere a full name would be noise — the
// kitchen label here, and recipe attribution (issue #845).
//
// This service used to own its own `firstName` (`name.split(' ')[0]`) beside
// `@salt/domain`'s `memberFirstName`, and the two DISAGREED. Issue #933 Phase 7
// deleted the local copy; the domain's answer is what these screens render now.
// The rows marked EXCEPTION 2 are the ones that changed, and they carry the old
// answer so the delta stays on the record rather than only in a commit message.
//
// `memberFirstName` is also what Pushover device-prefix matching depends on
// (`apps/cloud-functions/src/adapters/pushoverRecipient.ts`), so this converged
// display onto the delivery-load-bearing definition rather than the other way
// round.
describe('membersService — how a member is named on screen', () => {
  const cases = [
    { name: 'a plain two-word name', input: 'Kate Pendery', rendered: 'Kate' },
    { name: 'a single word', input: 'Daniel', rendered: 'Daniel' },
    { name: 'three words', input: 'Mary Jane Pendery', rendered: 'Mary' },
    { name: 'a doubled separator', input: 'Mary  Jane', rendered: 'Mary' },
    { name: 'a trailing space', input: 'Kate ', rendered: 'Kate' },
    // `''` is a real state, not a bug: an unattributed recipe has no name to
    // shorten, and the caller decides what to render instead.
    { name: 'the empty name', input: '', rendered: '' },
    { name: 'whitespace only', input: '   ', rendered: '' },
    // EXCEPTION 2 — the two rows that flipped in Phase 7. The retired copy
    // rendered `''` for the first (a BLANK chef label) and the whole undivided
    // string for the second, because `split(' ')` takes the empty leading field
    // and never sees a tab or a newline as a separator.
    { name: 'a LEADING space (EXCEPTION 2, was "")', input: '  Kate Pendery', rendered: 'Kate' },
    {
      name: 'tab and newline separators (EXCEPTION 2, was the whole string)',
      input: '\tDaniel\nPendery',
      rendered: 'Daniel',
    },
  ];

  it.each(cases)('$name → $rendered', ({ input, rendered }) => {
    expect(memberFirstName(input)).toBe(rendered);
  });

  it('is what kitchenLabel shortens with', () => {
    seedMembers([member({ id: 'kate@e.org', name: 'Kate Pendery' })]);
    mockAuth.user = { email: 'kate@e.org' };
    expect(get(kitchenLabel)).toBe("Kate's Kitchen");
  });

  it('shortens a leading-whitespace name in the kitchen label too', () => {
    // The user-visible half of Exception 2: this rendered "'s Kitchen" before.
    seedMembers([member({ id: 'kate@e.org', name: '  Kate Pendery' })]);
    mockAuth.user = { email: 'kate@e.org' };
    expect(get(kitchenLabel)).toBe("Kate's Kitchen");
  });

  it('leaves the service with no second implementation to drift from', async () => {
    // UT-E2 in spirit: the point of Phase 7 was ONE importable name. A
    // re-exported alias would satisfy every assertion above while restoring the
    // fork, so the absence is asserted rather than assumed.
    const service = await import('../src/lib/membersService.js');
    expect(Object.keys(service)).not.toContain('firstName');
  });
});

describe('membersService — mutations', () => {
  it('createMemberEntry upserts a normalised member appended after the max sortOrder', async () => {
    seedMembers([member({ id: 'a@e.org', sortOrder: 5 })]);
    await createMemberEntry({ name: 'New', email: '  New@E.ORG ', admin: true });

    expect(fs.upsertMember).toHaveBeenCalledTimes(1);
    const written = fs.upsertMember.mock.calls[0]![0];
    expect(written.id).toBe('new@e.org');
    expect(written.email).toBe('new@e.org');
    expect(written.admin).toBe(true);
    expect(written.sortOrder).toBe(6);
  });

  it('createMemberEntry honours an explicit sortOrder', async () => {
    seedMembers([]);
    await createMemberEntry({ name: 'New', email: 'n@e.org', admin: false, sortOrder: 3 });
    expect(fs.upsertMember.mock.calls[0]![0].sortOrder).toBe(3);
  });

  it('updateMemberEntry patches the existing member and keeps the id', async () => {
    seedMembers([member({ id: 'a@e.org', name: 'Old', admin: false, sortOrder: 0 })]);
    await updateMemberEntry('a@e.org', { name: 'New', admin: true });

    const written = fs.upsertMember.mock.calls[0]![0];
    expect(written.id).toBe('a@e.org');
    expect(written.name).toBe('New');
    expect(written.admin).toBe(true);
  });

  it('updateMemberEntry returns a Failure when the member is unknown', async () => {
    seedMembers([]);
    const result = await updateMemberEntry('ghost@e.org', { name: 'X' });
    expect(result.kind).toBe('err');
    expect(fs.upsertMember).not.toHaveBeenCalled();
  });

  it('deleteMemberEntry delegates to the adapter', async () => {
    await deleteMemberEntry('a@e.org');
    expect(fs.deleteMember).toHaveBeenCalledWith('a@e.org');
  });
});

// ─── System accounts (issue #1300) ──────────────────────────────────────────

describe('membersService — people vs the whole roster', () => {
  const ANN = { id: 'ann@e.org', name: 'Ann', sortOrder: 1 };
  const FRIDGE = { id: 'fridge@e.org', name: 'Fridge', sortOrder: 2, system: true };

  it('drops system accounts from `people` and keeps them in `members`', () => {
    seedMembers([member(ANN), member(FRIDGE)]);
    expect(get(members).map((m) => m.name)).toEqual(['Ann', 'Fridge']);
    expect(get(people).map((m) => m.name)).toEqual(['Ann']);
  });

  it('keeps `currentMember` resolving a system account', () => {
    // The whole reason `members` stays whole: the kitchen screen has to be able
    // to sign in and be recognised, or the account cannot use the app at all.
    mockAuth.user = { email: 'fridge@e.org' };
    seedMembers([member(ANN), member(FRIDGE)]);
    expect(get(currentMember)?.name).toBe('Fridge');
    expect(get(kitchenLabel)).toBe("Fridge's Kitchen");
    expect(isEmailAdmin('fridge@e.org')).toBe(false);
    expect(findMemberByEmail('fridge@e.org')?.id).toBe('fridge@e.org');
    mockAuth.user = null;
  });

  it('names the system accounts, and only those', () => {
    seedMembers([member(ANN), member(FRIDGE)]);
    expect([...get(systemAccountNames)]).toEqual(['Fridge']);
  });

  it('creates a person by default and a system account when asked', async () => {
    seedMembers([]);
    await createMemberEntry({ name: 'New', email: 'new@e.org', admin: false });
    expect(fs.upsertMember.mock.calls[0]![0]).toMatchObject({ system: false });
    await createMemberEntry({ name: 'Fridge', email: 'f@e.org', admin: false, system: true });
    expect(fs.upsertMember.mock.calls[1]![0]).toMatchObject({ system: true });
  });

  it('patches the flag through updateMemberEntry', async () => {
    seedMembers([member(ANN)]);
    await updateMemberEntry('ann@e.org', { system: true });
    expect(fs.upsertMember.mock.calls[0]![0]).toMatchObject({ id: 'ann@e.org', system: true });
  });
});
