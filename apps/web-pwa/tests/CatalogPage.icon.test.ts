import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { CanonItem, ProductForm } from '@salt/domain';

const { mockCanonItems, mockAisles, mockProductForms, mockMembers, mockIsLoading, mockAuth } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockAisles: makeStore<{ id: string; name: string; order: number }[]>([]),
      mockProductForms: makeStore<ProductForm[]>([]),
      // AdminGuard (canon now lives behind /admin, #157) reads these.
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
    };
  });

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { location: '/admin/canon/c1', querystring: '' },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
  // AdminGuard reads this since #1055 (Phase 5) instead of re-deriving admin
  // itself; derived here from the same members/auth stubs as the real
  // `currentMember` in membersService.ts.
  currentMember: {
    subscribe(fn: (v: { email: string; admin: boolean } | null) => void) {
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
  updateCanonItemName: vi.fn(),
  updateCanonItemAisle: vi.fn(),
  updateCanonItemSynonyms: vi.fn(),
  updateCanonItemShoppingBehavior: vi.fn(),
  updateCanonItemThreshold: vi.fn(),
  updateCanonItemUnit: vi.fn(),
  approveCanonItemWithOverrides: vi.fn(),
  deleteCanonItem: vi.fn(),
  splitMostRecentSynonym: vi.fn(),
  regenerateCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  unhideCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  isLoadingProductForms: mockIsLoading,
  deleteProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  confirmProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import CatalogPage from '../src/routes/admin/CatalogPage.svelte';
import { regenerateCanonIcon, hideCanonIcon, unhideCanonIcon } from '../src/lib/canonService.js';

const ITEM_ID = 'c1';

function canonItem(overrides: Partial<CanonItem> = {}): CanonItem {
  return {
    id: ITEM_ID,
    schemaVersion: 5,
    name: 'milk',
    synonyms: [],
    aisleId: null,
    thumbnail: 'https://example.com/milk.webp',
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  // bits-ui Dialog toggles body styles via rAF, which jsdom never fires.
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAisles._set([]);
  mockCanonItems._set([]);
  mockProductForms._set([]);
  // Pass AdminGuard: signed-in user is an admin member (#157).
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
});

describe('the catalog record editor — icon escape hatch', () => {
  it('renders the icon section with the current icon', () => {
    mockCanonItems._set([canonItem()]);
    const { getByTestId } = render(CatalogPage, { props: { params: { id: ITEM_ID } } });
    expect(getByTestId('canon-detail-icon-section')).toBeInTheDocument();
    expect(getByTestId('canon-icon-img')).toBeInTheDocument();
  });

  it('opens a dialog and regenerates with no hint on confirm', async () => {
    mockCanonItems._set([canonItem()]);
    const { getByTestId, findByTestId } = render(CatalogPage, {
      props: { params: { id: ITEM_ID } },
    });
    await fireEvent.click(getByTestId('canon-detail-icon-regenerate'));
    await fireEvent.click(await findByTestId('canon-detail-regenerate-confirm'));
    await waitFor(() => expect(regenerateCanonIcon).toHaveBeenCalledWith(ITEM_ID, undefined));
  });

  it('passes the typed hint to regenerate', async () => {
    mockCanonItems._set([canonItem()]);
    const { getByTestId, findByTestId } = render(CatalogPage, {
      props: { params: { id: ITEM_ID } },
    });
    await fireEvent.click(getByTestId('canon-detail-icon-regenerate'));
    const hintInput = await findByTestId('canon-detail-regenerate-hint');
    await fireEvent.input(hintInput, { target: { value: 'show it as a tin' } });
    await fireEvent.click(getByTestId('canon-detail-regenerate-confirm'));
    await waitFor(() =>
      expect(regenerateCanonIcon).toHaveBeenCalledWith(ITEM_ID, 'show it as a tin'),
    );
  });

  it('shows Hide for a visible icon and hides on click', async () => {
    mockCanonItems._set([canonItem({ thumbnail: 'https://example.com/milk.webp' })]);
    const { getByTestId, queryByTestId } = render(CatalogPage, {
      props: { params: { id: ITEM_ID } },
    });
    expect(queryByTestId('canon-detail-icon-unhide')).toBeNull();
    await fireEvent.click(getByTestId('canon-detail-icon-hide'));
    await waitFor(() => expect(hideCanonIcon).toHaveBeenCalledTimes(1));
  });

  it('shows Unhide for a hidden icon and unhides on click', async () => {
    mockCanonItems._set([canonItem({ thumbnail: 'hidden' })]);
    const { getByTestId, queryByTestId } = render(CatalogPage, {
      props: { params: { id: ITEM_ID } },
    });
    expect(queryByTestId('canon-detail-icon-hide')).toBeNull();
    // Hidden icon shows the bare tile (no img).
    expect(queryByTestId('canon-icon-img')).toBeNull();
    await fireEvent.click(getByTestId('canon-detail-icon-unhide'));
    await waitFor(() => expect(unhideCanonIcon).toHaveBeenCalledWith(ITEM_ID));
  });
});

// The dialog's own surface, characterized (issue #930, Phase 1). Phase 7 folds
// this dialog and `KitchenToolsPage`'s near-identical copy into one component;
// what differs between the two — placeholder wording, test-id prefix, busy
// source, open binding — must survive as per-site props rather than be
// harmonised away, and these are the assertions that say so. The matching pins
// for the other copy live in `KitchenToolsPage.test.ts`.
describe('the catalog record editor — the regenerate dialog’s own surface', () => {
  async function openDialog() {
    mockCanonItems._set([canonItem()]);
    const view = render(CatalogPage, { props: { params: { id: ITEM_ID } } });
    await fireEvent.click(view.getByTestId('canon-detail-icon-regenerate'));
    return { view, dialog: await view.findByTestId('canon-detail-regenerate-dialog') };
  }

  it('is titled and framed as an optional steer, not a confirmation', async () => {
    const { dialog } = await openDialog();
    const q = within(dialog);
    expect(q.getByText('Regenerate icon')).toBeInTheDocument();
    expect(
      q.getByText('Optionally add guidance for the new icon. Leave blank to just try again.'),
    ).toBeInTheDocument();
    expect(q.getByText('Extra guidance (optional)')).toBeInTheDocument();
    // No "are you sure?" — the commit contract drops the confirmation, not the input.
    expect(q.getByText('Regenerate')).toBeInTheDocument();
    expect(q.getByText('Cancel')).toBeInTheDocument();
  });

  it('carries the canon-side placeholder, which is not the kitchen-tool one', async () => {
    const { view } = await openDialog();
    expect(view.getByTestId('canon-detail-regenerate-hint')).toHaveAttribute(
      'placeholder',
      'e.g. show it as a tin, sliced, make it greener',
    );
  });

  it('prefixes all three of its test ids with the record’s own id', async () => {
    const { view } = await openDialog();
    for (const suffix of ['dialog', 'hint', 'confirm']) {
      expect(view.getByTestId(`canon-detail-regenerate-${suffix}`)).toBeInTheDocument();
    }
  });

  it('a hint typed and then abandoned does not ride along with the next attempt', async () => {
    // Both pages used to clear their own `regenerateHint` when opening the
    // dialog; #930 Phase 7 moved that into the shared component. Pinned because
    // the failure is silent and wrong in the worst direction — a steer meant for
    // one icon quietly steering the next.
    const { view } = await openDialog();
    await fireEvent.input(view.getByTestId('canon-detail-regenerate-hint'), {
      target: { value: 'make it purple' },
    });
    await fireEvent.click(view.getByText('Cancel'));

    await fireEvent.click(view.getByTestId('canon-detail-icon-regenerate'));
    await fireEvent.click(await view.findByTestId('canon-detail-regenerate-confirm'));
    await waitFor(() => expect(regenerateCanonIcon).toHaveBeenCalledWith(ITEM_ID, undefined));
  });

  it('Enter in the hint field regenerates without reaching the confirm button', async () => {
    const { view } = await openDialog();
    const hint = view.getByTestId('canon-detail-regenerate-hint');
    await fireEvent.input(hint, { target: { value: 'greener' } });
    await fireEvent.keyDown(hint, { key: 'Enter' });
    await waitFor(() => expect(regenerateCanonIcon).toHaveBeenCalledWith(ITEM_ID, 'greener'));
  });
});
