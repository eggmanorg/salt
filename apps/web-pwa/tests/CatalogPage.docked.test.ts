import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { CanonItem, Member, ProductForm } from '@salt/domain';

// Issue #933 characterisation net. `CatalogPage` carries a guarded `matchMedia`
// `$effect` (byte-identical to the one in `MealPlanWeekPage` and
// `RecipeViewPage`) that a later phase will extract into one shared helper. This
// file pins every failure path the extraction must preserve — today none of them
// is tested anywhere. Asserted through the page's own rendered output: whether
// choosing a record navigates away (phone) or docks it beside the list
// (`catalog-record-pane`, from `docked`).

const {
  mockCanonItems,
  mockProductForms,
  mockAisles,
  mockMembers,
  mockIsLoading,
  mockAuth,
  mockRouter,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCanonItems: makeStore<CanonItem[]>([]),
    mockProductForms: makeStore<ProductForm[]>([]),
    mockAisles: makeStore<{ id: string; name: string; position: number }[]>([]),
    mockMembers: makeStore<Member[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
    mockRouter: { location: '/admin/catalog', querystring: '' },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: mockRouter }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
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
vi.mock('../src/lib/aisleService.js', () => ({
  aisles: mockAisles,
  initAisles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: mockIsLoading,
  approveCanonItems: vi.fn().mockResolvedValue({ kind: 'ok' as const, value: undefined }),
  deleteCanonItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  regenerateCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemName: vi.fn(),
  updateCanonItemAisle: vi.fn(),
  updateCanonItemSynonyms: vi.fn(),
  updateCanonItemShoppingBehavior: vi.fn(),
  updateCanonItemThreshold: vi.fn(),
  approveCanonItemWithOverrides: vi.fn(),
  splitMostRecentSynonym: vi.fn(),
  hideCanonIcon: vi.fn(),
  unhideCanonIcon: vi.fn(),
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  isLoadingProductForms: mockIsLoading,
  confirmProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import CatalogPage from '../src/routes/admin/CatalogPage.svelte';
import { push } from 'svelte-spa-router';

const ADMIN: Member = {
  schemaVersion: 1,
  id: 'admin@e.org',
  name: 'Ada Admin',
  email: 'admin@e.org',
  admin: true,
  sortOrder: 0,
  icon: null,
  cookMode: 'standard',
  system: false,
  updatedAt: '2026-07-17T00:00:00.000Z',
};

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: 'produce',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

const LEMON = canonItem({ id: 'lemon', name: 'lemon' });
const BUTTER = canonItem({ id: 'butter', name: 'butter' });

function renderCatalog() {
  mockMembers._set([ADMIN]);
  mockAisles._set([{ id: 'produce', name: 'Produce', position: 0 }]);
  mockCanonItems._set([LEMON, BUTTER]);
  mockProductForms._set([]);
  return render(CatalogPage);
}

/** Choose "Lemon" — the second row, alphabetically after Butter. */
async function openLemon(): Promise<void> {
  await fireEvent.click((await screen.findAllByTestId('catalog-row-name-wide'))[1]!);
}

beforeEach(() => {
  mockRouter.location = '/admin/catalog';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  mockCanonItems._set([]);
  mockProductForms._set([]);
  mockAisles._set([]);
  vi.clearAllMocks();
});

describe('CatalogPage — the docked-pane media query, failure paths (#933)', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  /** A complete `MediaQueryList` stub — the shape the house pattern expects. */
  function fullStub(
    matches: boolean,
    addEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
    removeEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
  ): typeof window.matchMedia {
    return ((query: string) => ({
      media: query,
      matches,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // UT-D1/D2: these four differ only in the `matchMedia` stub, and each row names
  // the failure path it stands for.
  it.each([
    [
      'matches: true, full listener API — docks beside the list (the positive control every other row depends on)',
      () => {
        window.matchMedia = fullStub(true);
      },
      true,
    ],
    [
      'matchMedia missing entirely — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = undefined as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'matchMedia throws on call — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = (() => {
          throw new Error('matchMedia is not supported here');
        }) as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'MediaQueryList with no addEventListener, matches: true — the one-shot read still docks',
      () => {
        window.matchMedia = ((query: string) => ({
          media: query,
          matches: true,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
      },
      true,
    ],
  ] as const)('%s', async (_label, setUp, expectDocked) => {
    setUp();
    renderCatalog();

    await openLemon();

    if (expectDocked) {
      // Docked: no navigation, the record opens beside the list instead.
      await waitFor(() => {
        expect(screen.getByTestId('catalog-record-pane')).toBeInTheDocument();
      });
      expect(vi.mocked(push)).not.toHaveBeenCalled();
    } else {
      await waitFor(() => {
        expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/catalog/c:lemon');
      });
      expect(screen.queryByTestId('catalog-record-pane')).toBeNull();
    }
  });

  it('subscribes the query’s change listener, follows it live, and unsubscribes the SAME handler on unmount', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    // Starts undocked so the live flip (not just the initial read) is what proves
    // the listener works.
    window.matchMedia = fullStub(false, addEventListener, removeEventListener);

    const { unmount } = renderCatalog();

    await waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function)),
    );
    const onChange = addEventListener.mock.calls[0]![1] as (e: MediaQueryListEvent) => void;

    // Before the listener ever fires: still undocked, so opening a record
    // navigates rather than docking it.
    await openLemon();
    await waitFor(() => expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/catalog/c:lemon'));
    expect(screen.queryByTestId('catalog-record-pane')).toBeNull();
    vi.mocked(push).mockClear();

    // The listener fires — the observable fact is the rendering flips, with no
    // remount: choosing the SAME record now docks it instead.
    onChange({ matches: true } as MediaQueryListEvent);
    await openLemon();
    await waitFor(() => {
      expect(screen.getByTestId('catalog-record-pane')).toBeInTheDocument();
    });
    expect(vi.mocked(push)).not.toHaveBeenCalled();

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', onChange);
  });
});
