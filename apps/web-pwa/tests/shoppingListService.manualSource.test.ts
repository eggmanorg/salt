import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { Member, ShoppingListItem } from '@salt/domain';

// Adapter boundary: only saveShoppingListItem matters here; the rest are stubs
// so importing the service (and the real membersService it leans on) resolves.
vi.mock('@salt/firebase-sync', () => ({
  subscribeShoppingLists: vi.fn(),
  createShoppingList: vi.fn(),
  renameShoppingList: vi.fn(),
  deleteShoppingList: vi.fn(),
  subscribeShoppingListItems: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteShoppingListItem: vi.fn(),
  deleteShoppingListItems: vi.fn(),
  moveShoppingListItems: vi.fn(),
  subscribeShoppingListsConfig: vi.fn(),
  saveShoppingListsConfig: vi.fn(),
  subscribeMembers: vi.fn(),
  upsertMember: vi.fn(),
  deleteMember: vi.fn(),
  isAuthTransitioning: vi.fn(() => false),
}));

vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  // Usage events (issue #684) are inert here — this suite is about source
  // attribution, not telemetry.
  trackUsageEvent: vi.fn(),
  // Phase 5: addItemToList roots a browser action span. Inert no-op handle —
  // empty traceparent → saveShoppingListItem writes no traceContext field.
  startUserActionSpan: vi.fn(() => ({
    traceparent: '',
    child: vi.fn(() => ({ setError: vi.fn(), end: vi.fn() })),
    setError: vi.fn(),
    setAttribute: vi.fn(),
    end: vi.fn(),
  })),
}));

// Mutable auth stand-in: tests set `auth.user` to drive who's signed in.
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: null as { uid: string; email: string | null } | null },
}));

import * as firebaseSync from '@salt/firebase-sync';
import { auth } from '../src/lib/auth.svelte.js';
import { seedMembers, __resetMembersServiceForTest } from '../src/lib/membersService.js';
import { addItemToList } from '../src/lib/shoppingListService.svelte.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

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

function savedItem(): ShoppingListItem {
  return fs.saveShoppingListItem.mock.calls[0]![1] as ShoppingListItem;
}

beforeEach(() => {
  __resetMembersServiceForTest();
  vi.clearAllMocks();
  fs.saveShoppingListItem.mockResolvedValue({ kind: 'ok', value: undefined });
  auth.user = null;
});

describe('addItemToList — manual source attribution', () => {
  it("stamps the signed-in member's first name onto the manual source", async () => {
    seedMembers([member({ id: 'daniel@e.org', name: 'Daniel Pendery' })]);
    auth.user = { uid: 'u1', email: 'daniel@e.org' };

    await addItemToList('list-1', 'heinz beans');

    expect(savedItem().sources).toEqual([{ kind: 'manual', addedBy: 'Daniel' }]);
  });

  it('matches the member case-insensitively via the normalised email', async () => {
    seedMembers([member({ id: 'daniel@e.org', name: 'Daniel Pendery' })]);
    auth.user = { uid: 'u1', email: '  Daniel@E.ORG ' };

    await addItemToList('list-1', 'milk');

    expect(savedItem().sources).toEqual([{ kind: 'manual', addedBy: 'Daniel' }]);
  });

  it('falls back to a plain manual source when the roster has not synced yet', async () => {
    // Signed in, but the members subscription has not delivered the roster, so
    // the adder cannot be resolved — the cold-start race the guard handles.
    auth.user = { uid: 'u1', email: 'daniel@e.org' };

    await addItemToList('list-1', 'eggs');

    expect(savedItem().sources).toEqual([{ kind: 'manual' }]);
  });
});
