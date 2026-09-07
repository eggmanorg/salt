import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Member } from '@salt/domain';

const { mockMembers, mockIsLoading, mockAuth } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockMembers: makeStore<Member[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
  createMemberEntry: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateMemberEntry: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteMemberEntry: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // AdminGuard reads this since #1055 (Phase 5) instead of re-deriving admin
  // itself; derived here from the same members/auth stubs as the real
  // `currentMember` in membersService.ts.
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

import AdminMembersPage from '../src/routes/admin/AdminMembersPage.svelte';
import { push } from 'svelte-spa-router';
import {
  createMemberEntry,
  updateMemberEntry,
  deleteMemberEntry,
} from '../src/lib/membersService.js';

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

const ADMIN = member({ id: 'admin@e.org', name: 'Ada Admin', admin: true, sortOrder: 0 });

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([ADMIN]);
});

describe('AdminMembersPage — admin access', () => {
  it('renders a row per member with name, email and admin badge', () => {
    mockMembers._set([ADMIN, member({ id: 'kid@e.org', name: 'Kid' })]);
    render(AdminMembersPage);
    const rows = screen.getAllByTestId('member-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Ada Admin')).toBeInTheDocument();
    expect(screen.getByText('kid@e.org')).toBeInTheDocument();
    expect(screen.getAllByTestId('member-admin-badge')).toHaveLength(1);
  });

  it('opens the editor and creates a member', async () => {
    render(AdminMembersPage);
    await userEvent.click(screen.getByTestId('member-add'));
    await waitFor(() => screen.getByTestId('member-editor'));

    await userEvent.type(screen.getByTestId('member-name-input'), 'New Person');
    await userEvent.type(screen.getByTestId('member-email-input'), 'new@e.org');
    await userEvent.click(screen.getByTestId('member-save'));

    await waitFor(() => {
      expect(vi.mocked(createMemberEntry)).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Person', email: 'new@e.org', admin: false }),
      );
    });
  });

  it('edits an existing member (email field disabled)', async () => {
    mockMembers._set([ADMIN, member({ id: 'kid@e.org', name: 'Kid', sortOrder: 1 })]);
    render(AdminMembersPage);

    const kidRow = screen.getByText('kid@e.org').closest('[data-testid="member-row"]')!;
    const editBtn = [...kidRow.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Edit'),
    )!;
    await userEvent.click(editBtn);

    await waitFor(() => screen.getByTestId('member-editor'));
    expect(screen.getByTestId('member-email-input')).toBeDisabled();

    await userEvent.click(screen.getByTestId('member-save'));
    await waitFor(() => {
      expect(vi.mocked(updateMemberEntry)).toHaveBeenCalledWith(
        'kid@e.org',
        expect.objectContaining({ name: 'Kid' }),
      );
    });
  });

  // ─── System accounts (issue #1300) ────────────────────────────────────────
  // This is the one screen that must keep seeing a system account: it is where
  // the flag is set, and where it can be unset again.

  it('badges a system account and still lists it', () => {
    mockMembers._set([ADMIN, member({ id: 'fridge@e.org', name: 'Fridge', system: true })]);
    render(AdminMembersPage);
    expect(screen.getAllByTestId('member-row')).toHaveLength(2);
    expect(screen.getAllByTestId('member-system-badge')).toHaveLength(1);
    expect(screen.getByText('fridge@e.org')).toBeInTheDocument();
  });

  it('flags an existing member as a system account', async () => {
    mockMembers._set([ADMIN, member({ id: 'kid@e.org', name: 'Kid', sortOrder: 1 })]);
    render(AdminMembersPage);

    const kidRow = screen.getByText('kid@e.org').closest('[data-testid="member-row"]')!;
    await userEvent.click(
      [...kidRow.querySelectorAll('button')].find((b) => b.textContent?.includes('Edit'))!,
    );
    await waitFor(() => screen.getByTestId('member-editor'));

    await userEvent.click(within(screen.getByTestId('member-system-input')).getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('member-save'));

    await waitFor(() => {
      expect(vi.mocked(updateMemberEntry)).toHaveBeenCalledWith(
        'kid@e.org',
        expect.objectContaining({ system: true, admin: false }),
      );
    });
  });

  it('unflags one again, leaving admin alone', async () => {
    // The two boxes are independent: a system account is not a permission level,
    // and moving one must never move the other.
    mockMembers._set([
      ADMIN,
      member({ id: 'fridge@e.org', name: 'Fridge', sortOrder: 1, system: true, admin: true }),
    ]);
    render(AdminMembersPage);

    const row = screen.getByText('fridge@e.org').closest('[data-testid="member-row"]')!;
    await userEvent.click(
      [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('Edit'))!,
    );
    await waitFor(() => screen.getByTestId('member-editor'));

    await userEvent.click(within(screen.getByTestId('member-system-input')).getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('member-save'));

    await waitFor(() => {
      expect(vi.mocked(updateMemberEntry)).toHaveBeenCalledWith(
        'fridge@e.org',
        expect.objectContaining({ system: false, admin: true }),
      );
    });
  });

  it('removes a member after confirmation', async () => {
    mockMembers._set([ADMIN, member({ id: 'kid@e.org', name: 'Kid', sortOrder: 1 })]);
    render(AdminMembersPage);

    const kidRow = screen.getByText('kid@e.org').closest('[data-testid="member-row"]')!;
    const removeBtn = [...kidRow.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Remove'),
    )!;
    await userEvent.click(removeBtn);

    await waitFor(() => screen.getByTestId('member-delete-dialog'));
    await userEvent.click(screen.getByTestId('member-delete-confirm'));

    await waitFor(() => {
      expect(vi.mocked(deleteMemberEntry)).toHaveBeenCalledWith('kid@e.org');
    });
  });
});

describe('AdminMembersPage — non-admin guard', () => {
  it('denies a non-admin and redirects home', async () => {
    mockAuth.user = { email: 'kid@e.org' };
    mockMembers._set([ADMIN, member({ id: 'kid@e.org', name: 'Kid' })]);
    render(AdminMembersPage);

    await waitFor(() => expect(vi.mocked(push)).toHaveBeenCalledWith('/'));
    expect(screen.queryByTestId('members-list')).not.toBeInTheDocument();
  });

  it('shows a spinner while the roster is still loading', () => {
    mockIsLoading._set(true);
    render(AdminMembersPage);
    expect(screen.getByTestId('admin-guard-loading')).toBeInTheDocument();
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });
});
