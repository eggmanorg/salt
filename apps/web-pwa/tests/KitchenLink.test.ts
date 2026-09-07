import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Member } from '@salt/domain';

// The header link into Kitchen (issue #828). It is the ONLY entry point to `/mine`
// — the personal view left both nav lists — so what this asserts is reachability
// as much as copy: the name it shows, where it points, the count it carries, and
// the accessible name that count has to be spelled out in.
//
// The name comes through the real `uid → normalised email → member` chain in
// membersService rather than a stubbed label, because the header and the page it
// opens read one derivation and the point of that derivation is that they agree.

vi.mock('@salt/firebase-sync', () => ({
  subscribeMembers: vi.fn(),
  upsertMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteMember: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

const mockAuth = vi.hoisted(() => ({ user: null as { email: string } | null }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));

// `mineOpenCount` composes app-wide cook-session and timer subscriptions. What it
// counts is settled and tested in personalViewService.test.ts; here it is just a
// number the link has to render or hide.
const { mockOpenCount } = vi.hoisted(() => {
  let value = 0;
  const subs = new Set<(v: number) => void>();
  return {
    mockOpenCount: {
      subscribe(fn: (v: number) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      _set(v: number) {
        value = v;
        subs.forEach((f) => f(v));
      },
    },
  };
});
vi.mock('../src/lib/personalViewService.js', () => ({ mineOpenCount: mockOpenCount }));

import KitchenLink from '../src/components/KitchenLink.svelte';
import { seedMembers, __resetMembersServiceForTest } from '../src/lib/membersService.js';

function member(overrides: Partial<Member> & { id: string }): Member {
  return {
    schemaVersion: 1,
    name: 'Someone',
    email: overrides.id,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  __resetMembersServiceForTest();
  mockOpenCount._set(0);
  mockAuth.user = { email: 'daniel@example.com' };
});

afterEach(() => cleanup());

describe('KitchenLink', () => {
  it("names the kitchen after the signed-in member's first name", () => {
    seedMembers([member({ id: 'daniel@example.com', name: 'Daniel Pendery' })]);
    const { getByTestId } = render(KitchenLink);
    expect(getByTestId('kitchen-link').textContent).toContain("Daniel's Kitchen");
  });

  it('points at /mine', () => {
    seedMembers([member({ id: 'daniel@example.com', name: 'Daniel Pendery' })]);
    const { getByTestId } = render(KitchenLink);
    expect(getByTestId('kitchen-link').getAttribute('href')).toBe('#/mine');
  });

  it('reads "My Kitchen" before the roster has synced, and still navigates', () => {
    // A real state on every cold launch, not a defensive branch: there is no
    // displayName on the auth user, so the name only exists once initMembersSync
    // has resolved.
    const { getByTestId } = render(KitchenLink);
    const link = getByTestId('kitchen-link');
    expect(link.textContent).toContain('My Kitchen');
    expect(link.getAttribute('href')).toBe('#/mine');
  });

  it('reads "My Kitchen" for a sign-in that is not on the roster', () => {
    seedMembers([member({ id: 'someone.else@example.com', name: 'Someone Else' })]);
    const { getByTestId } = render(KitchenLink);
    expect(getByTestId('kitchen-link').textContent).toContain('My Kitchen');
  });

  it('shows no badge when nothing is open', () => {
    seedMembers([member({ id: 'daniel@example.com', name: 'Daniel Pendery' })]);
    const { queryByTestId, getByTestId } = render(KitchenLink);
    expect(queryByTestId('kitchen-link-badge')).toBeNull();
    // ...and the accessible name is then just the name.
    expect(getByTestId('kitchen-link').getAttribute('aria-label')).toBe("Daniel's Kitchen");
  });

  it('carries the open-now count, and drops it again when it clears', async () => {
    seedMembers([member({ id: 'daniel@example.com', name: 'Daniel Pendery' })]);
    const { getByTestId, queryByTestId } = render(KitchenLink);

    mockOpenCount._set(2);
    await tick();
    expect(getByTestId('kitchen-link-badge').textContent?.trim()).toBe('2');

    mockOpenCount._set(0);
    await tick();
    expect(queryByTestId('kitchen-link-badge')).toBeNull();
  });

  it('spells the count out in the accessible name and hides the numeral', async () => {
    // The badge is a bare numeral beside a link, so it must not be the only
    // carrier of its own meaning.
    seedMembers([member({ id: 'daniel@example.com', name: 'Daniel Pendery' })]);
    const { getByTestId } = render(KitchenLink);

    mockOpenCount._set(2);
    await tick();
    expect(getByTestId('kitchen-link').getAttribute('aria-label')).toBe(
      "Daniel's Kitchen, 2 need attention",
    );
    expect(getByTestId('kitchen-link-badge').getAttribute('aria-hidden')).toBe('true');

    mockOpenCount._set(1);
    await tick();
    expect(getByTestId('kitchen-link').getAttribute('aria-label')).toBe(
      "Daniel's Kitchen, 1 needs attention",
    );
  });
});
