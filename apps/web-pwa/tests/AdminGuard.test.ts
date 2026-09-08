import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { Member } from '@salt/domain';

// `AdminGuard` had no test of its own: every suite that reached it did so through
// a page that seeds an admin, so `admin-guard-denied`'s markup was asserted
// nowhere in the repo and a refactor that dropped the panel would have passed.
//
// This is issue #1055's characterisation net for the guard. It mounts the
// component directly so all three of its render branches are exercised, and it
// pins the ONE input on which the guard's own member resolution and
// `membersService`'s exported `currentMember` disagree today — see the
// "Exception 1" case at the bottom.

const { mockMembers, mockIsLoading, mockAuth } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockMembers: makeStore<Member[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
// `currentMember` is the real derivation's shape, built here from the same
// roster and auth stubs the guard used to read directly. Deriving it rather than
// stubbing an answer keeps these tests pointed at the guard's own behaviour
// while pinning the contract it now depends on (issue #1055 Phase 5).
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
  currentMember: {
    subscribe(fn: (v: Member | null) => void) {
      return mockMembers.subscribe((roster) => {
        const email = mockAuth.user?.email ?? '';
        if (!email) return fn(null);
        const normalised = normaliseMemberEmail(email);
        fn(roster.find((m) => m.email === normalised) ?? null);
      });
    },
  },
}));

import AdminGuard from '../src/routes/admin/AdminGuard.svelte';
import { push } from 'svelte-spa-router';

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
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

const ADMIN = member({ id: 'admin@e.org', name: 'Ada Admin', admin: true });
const KID = member({ id: 'kid@e.org', name: 'Kid' });

/** What the guard is protecting. Rendered only on the admit branch. */
const guarded = createRawSnippet(() => ({
  render: () => '<div data-testid="guarded-content">operator screen</div>',
}));

function renderGuard() {
  return render(AdminGuard, { props: { children: guarded } });
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([ADMIN, KID]);
});

describe('AdminGuard — the three render branches', () => {
  it('shows the spinner and judges nobody while the roster is still loading', () => {
    // Judging early would bounce a legitimate admin on first paint, before the
    // subscription has delivered the row that says they are one.
    mockIsLoading._set(true);
    mockAuth.user = { email: 'admin@e.org' };
    renderGuard();

    expect(screen.getByTestId('admin-guard-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-guard-denied')).not.toBeInTheDocument();
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });

  it('renders the denied panel AND redirects when a settled roster says non-admin', async () => {
    // Both halves matter and only one of them was covered anywhere: the redirect
    // is asserted by `AdminMembersPage.test.ts`, the panel's markup by nothing.
    mockAuth.user = { email: 'kid@e.org' };
    renderGuard();

    const denied = screen.getByTestId('admin-guard-denied');
    expect(denied).toHaveTextContent("You don't have access to this area.");
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(push)).toHaveBeenCalledWith('/'));
  });

  it('renders the children and redirects nowhere for a settled admin', () => {
    renderGuard();

    expect(screen.getByTestId('guarded-content')).toHaveTextContent('operator screen');
    expect(screen.queryByTestId('admin-guard-denied')).not.toBeInTheDocument();
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });
});

describe('AdminGuard — how it resolves the signed-in member', () => {
  it.each([
    ['an email that is on the roster, differently cased', 'ADMIN@E.ORG', true],
    ['an email padded with whitespace', '  admin@e.org  ', true],
    ['an email that is not on the roster at all', 'stranger@e.org', false],
  ])('admits=%s for %s', (_case, email, admits) => {
    mockAuth.user = { email };
    renderGuard();

    expect(screen.queryByTestId('guarded-content') !== null).toBe(admits);
  });

  // ── Exception 1 (issue #1055) — FLIPPED IN PHASE 5 ───────────────────────────
  // The guard used to re-derive the signed-in member itself rather than read
  // `membersService`'s exported `currentMember`, and the two answers differed on
  // exactly one input: a signed-out session.
  //
  //   `currentMember`  returns null when the email is falsy, before it looks.
  //   the old copy     normalised '' to '' and then matched any roster member
  //                    whose own `email` field was ''.
  //
  // So with a rogue `{ email: '', admin: true }` document on the roster, a
  // SIGNED-OUT session used to be ADMITTED. It is now denied — the safer of the
  // two answers, and the only observable behaviour change in this whole issue.
  //
  // No such document exists or can be created through the app: `createMember`
  // normalises before writing and Firestore rejects an empty doc id. But nothing
  // in `MemberSchema` (`email` is a bare `z.string()`) or in `firestore.rules`
  // pins the field to the doc key, so the input is representable — which is why
  // this is asserted rather than argued away. The guard is cosmetic regardless;
  // `firestore.rules` is the real gate (issue #155).
  it('Exception 1: DENIES a signed-out session against an empty-email admin row', () => {
    mockAuth.user = null;
    mockMembers._set([member({ id: 'ghost', email: '', name: 'Ghost', admin: true }), KID]);
    renderGuard();

    expect(screen.getByTestId('admin-guard-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
  });

  it('denies a signed-out session when no such row exists', () => {
    mockAuth.user = null;
    renderGuard();

    expect(screen.getByTestId('admin-guard-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
  });
});
