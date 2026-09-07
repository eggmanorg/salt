import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { CanonItem, Member, ProductForm } from '@salt/domain';

// The catalog (issue #872): ONE list holding canon items and the product forms
// that hang off them, replacing the two admin lists it was cut from.

const {
  mockCanonItems,
  mockProductForms,
  mockAisles,
  mockMembers,
  mockIsLoading,
  mockAuth,
  mockRouter,
  toasts,
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
    // Every deferred act (delete AND approve) rides an Undo toast that commits
    // only when it LAPSES. These tests drive the lapse and the undo by hand.
    toasts: [] as {
      message: string;
      // `| undefined` (not just `?`) under `exactOptionalPropertyTypes`: the spy
      // records what `addToast` was CALLED with, and both of these are called
      // absent as often as present.
      variant?: string | undefined;
      opts?:
        { action?: { onClick: () => void }; onDismiss?: () => void; duration?: number } | undefined;
    }[],
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: mockRouter }));
vi.mock('../src/lib/toastStore.js', () => ({
  addToast: vi.fn(
    (
      message: string,
      variant?: string,
      opts?: { action?: { onClick: () => void }; onDismiss?: () => void; duration?: number },
    ) => {
      toasts.push({ message, variant, opts });
    },
  ),
}));
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
import { approveCanonItems, deleteCanonItem } from '../src/lib/canonService.js';
import { confirmProductForm, deleteProductForm } from '../src/lib/productFormService.js';

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

function productForm(overrides: Partial<ProductForm> & { id: string; label: string }): ProductForm {
  return {
    schemaVersion: 1,
    matchers: ['lemon juice'],
    parentCanonId: 'lemon',
    thumbnail: null,
    yield: { formUnit: 'ml', amountPerParent: 30 },
    needs_approval: false,
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

const LEMON = canonItem({
  id: 'lemon',
  name: 'lemon',
  needs_approval: true,
  reasoning: 'Created from “2 lemons”.',
  pendingChanges: [{ kind: 'created', rawInput: '2 lemons' }],
});
const BUTTER = canonItem({ id: 'butter', name: 'butter', largeQuantityThreshold: 500, unit: 'g' });
const JUICE = productForm({ id: 'juice', label: 'Lemon juice', needs_approval: true });
const ZEST = productForm({ id: 'zest', label: 'Lemon zest', needs_approval: true });

function renderCatalog() {
  mockMembers._set([ADMIN]);
  mockAisles._set([{ id: 'produce', name: 'Produce', position: 0 }]);
  mockCanonItems._set([LEMON, BUTTER]);
  mockProductForms._set([JUICE, ZEST]);
  return render(CatalogPage);
}

function lastToast() {
  return toasts[toasts.length - 1]!;
}

// `EditableRow` renders BOTH its narrow and wide snippets into the DOM and hides
// one with CSS, so every row name is in the document twice. Read the wide copy.
// The name is the first line of the button; a pending row carries a summary
// under it, and a form row its matchers and yield.
const firstLine = (el: HTMLElement): string => el.firstElementChild!.textContent!.trim();

function rowNames(): string[] {
  return screen.queryAllByTestId('catalog-row-name-wide').map(firstLine);
}

function formLabels(): string[] {
  return screen.queryAllByTestId('catalog-form-row-wide').map(firstLine);
}

beforeEach(() => {
  toasts.length = 0;
  mockRouter.location = '/admin/catalog';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.body.style.pointerEvents = '';
  mockCanonItems._set([]);
  mockProductForms._set([]);
  mockAisles._set([]);
  vi.clearAllMocks();
});

describe('CatalogPage — one list, two record types', () => {
  it('groups items into their aisle sections', async () => {
    renderCatalog();
    const groups = await screen.findAllByTestId('catalog-aisle-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent('Produce');
    expect(rowNames()).toEqual(['Butter', 'Lemon']);
  });

  it('reveals an item’s product forms when the row is expanded', async () => {
    renderCatalog();
    expect(screen.queryByTestId('catalog-form-row-wide')).toBeNull();

    await fireEvent.click((await screen.findAllByTestId('catalog-row-disclosure-wide'))[0]!);

    expect(formLabels()).toEqual(['Lemon juice', 'Lemon zest']);
  });

  it('offers Add form from the item, seeded with it as the parent', async () => {
    renderCatalog();
    await fireEvent.click((await screen.findAllByTestId('catalog-row-disclosure-wide'))[0]!);
    await fireEvent.click(screen.getByTestId('catalog-row-add-form'));
    expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/product-forms/new?parent=lemon');
  });

  it('opens a record into the editor when its name is chosen', async () => {
    renderCatalog();
    // Below the two-pane breakpoint (jsdom reports no match), choosing a row
    // navigates to the full-page editor instead of docking it beside the list.
    await fireEvent.click((await screen.findAllByTestId('catalog-row-name-wide'))[1]!);
    expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/catalog/c:lemon');
  });
});

describe('CatalogPage — the filter chips', () => {
  it('shows only records awaiting review, opened, with the AI’s words and the text they came from', async () => {
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));

    // Butter is neither pending nor the parent of a pending form.
    expect(rowNames()).toEqual(['Lemon']);
    // The row arrives OPEN — no disclosure to press.
    expect(screen.queryByTestId('catalog-row-disclosure-wide')).toBeNull();
    expect(screen.getByTestId('catalog-row-reasoning')).toHaveTextContent(
      'Created from “2 lemons”',
    );
    expect(screen.getByTestId('catalog-row-source')).toHaveTextContent('2 lemons');
    // The three decisions are editable where they are read (ui-spec-v09 §8.27),
    // so they are controls showing the current answer rather than a line of
    // words. None of them is a toggle, so none carries `aria-pressed`.
    const decisions = screen.getByTestId('catalog-row-decisions');
    expect(decisions).toBeInTheDocument();
    expect(screen.getByTestId('catalog-row-aisle')).toHaveValue('Produce');
    expect(screen.getByTestId('catalog-row-behavior')).toHaveTextContent('Needed');
    expect(screen.getByTestId('catalog-row-threshold')).toHaveValue('');
    for (const id of ['catalog-row-aisle', 'catalog-row-behavior', 'catalog-row-threshold']) {
      expect(screen.getByTestId(id)).not.toHaveAttribute('aria-pressed');
    }
    expect(screen.getAllByTestId('catalog-form-row-wide')).toHaveLength(2);
  });

  it('narrows to items that have forms, and to items with no threshold', async () => {
    renderCatalog();

    await fireEvent.click(await screen.findByTestId('catalog-filter-has-forms'));
    expect(rowNames()).toEqual(['Lemon']);

    await fireEvent.click(screen.getByTestId('catalog-filter-no-threshold'));
    expect(rowNames()).toEqual(['Lemon']);

    await fireEvent.click(screen.getByTestId('catalog-filter-all'));
    expect(rowNames()).toEqual(['Butter', 'Lemon']);
  });

  it('is single-select — the chips are four views of one list, not composable facets', async () => {
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-has-forms'));
    expect(screen.getByTestId('catalog-filter-has-forms')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('catalog-filter-all')).toHaveAttribute('aria-pressed', 'false');
  });

  it('presets "has forms" when reached by the old product-forms bookmark', async () => {
    mockRouter.location = '/admin/product-forms';
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByTestId('catalog-filter-has-forms')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});

describe('CatalogPage — approving', () => {
  it('approves an item and its pending forms as one act, with one undo', async () => {
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));

    const approve = screen.getByTestId('catalog-row-approve');
    expect(approve).toHaveTextContent('Approve all 3');
    await fireEvent.click(approve);

    // Nothing is written yet — the undo window is open.
    expect(vi.mocked(approveCanonItems)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmProductForm)).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(lastToast().message).toBe('3 records approved');
    // An approve reads as a success, and its Undo window is shorter than the
    // Toast default — it is a confirmation, not something to deliberate over.
    expect(lastToast().variant).toBe('success');
    expect(lastToast().opts?.duration).toBe(3000);

    // Meanwhile the records read as approved: they have left this filter.
    await waitFor(() => expect(rowNames()).toEqual([]));

    lastToast().opts?.onDismiss?.();

    await waitFor(() => {
      expect(vi.mocked(confirmProductForm)).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(approveCanonItems)).toHaveBeenCalledWith(['lemon']);
    expect(vi.mocked(confirmProductForm)).toHaveBeenCalledWith(
      JUICE,
      expect.objectContaining({ label: 'Lemon juice', matchers: JUICE.matchers }),
    );
  });

  it('undo writes nothing at all and the records come back', async () => {
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));
    await fireEvent.click(screen.getByTestId('catalog-row-approve'));

    lastToast().opts?.action?.onClick();

    await waitFor(() => expect(rowNames()).toEqual(['Lemon']));
    expect(vi.mocked(approveCanonItems)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmProductForm)).not.toHaveBeenCalled();
  });

  it('bulk-approves a selection spanning both record types under one verb', async () => {
    renderCatalog();
    const user = userEvent.setup();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));

    await user.click(screen.getByRole('button', { name: 'Select' }));
    // Select-all is the first checkbox; it takes the item and both of its forms.
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]!);

    await user.click(screen.getByTestId('catalog-bulk-approve'));
    lastToast().opts?.onDismiss?.();

    await waitFor(() => {
      expect(vi.mocked(confirmProductForm)).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(approveCanonItems)).toHaveBeenCalledWith(['lemon']);
  });

  // Both halves of the act commit after the undo window lapses, and since #931
  // either half can come back as a `Failure` rather than throwing. The page owes
  // the person ONE message for the act they performed, whichever half refused —
  // which half it was is not a distinction they can act on.
  it('says the approval was not recorded when the canon write is refused', async () => {
    vi.mocked(approveCanonItems).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));
    await fireEvent.click(screen.getByTestId('catalog-row-approve'));

    lastToast().opts?.onDismiss?.();

    await waitFor(() => expect(lastToast().message).toBe('Failed to record some approvals.'));
    expect(lastToast().variant).toBe('destructive');
  });

  it('says the approval was not recorded when a form write is refused', async () => {
    vi.mocked(confirmProductForm).mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    renderCatalog();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));
    await fireEvent.click(screen.getByTestId('catalog-row-approve'));

    lastToast().opts?.onDismiss?.();

    await waitFor(() => expect(lastToast().message).toBe('Failed to record some approvals.'));
    expect(lastToast().variant).toBe('destructive');
  });
});

describe('CatalogPage — deleting', () => {
  it('deletes a mixed selection behind one undo, hiding the rows meanwhile', async () => {
    renderCatalog();
    const user = userEvent.setup();
    await fireEvent.click(await screen.findByTestId('catalog-filter-needs-review'));

    await user.click(screen.getByRole('button', { name: 'Select' }));
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[0]!);
    await user.click(screen.getByTestId('catalog-bulk-delete'));

    expect(lastToast().message).toBe('3 records deleted');
    expect(vi.mocked(deleteCanonItem)).not.toHaveBeenCalled();
    await waitFor(() => expect(rowNames()).toEqual([]));

    lastToast().opts?.onDismiss?.();

    await waitFor(() => {
      expect(vi.mocked(deleteProductForm)).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(deleteCanonItem)).toHaveBeenCalledWith('lemon');
  });
});

describe('CatalogPage — the two-pane breakpoint', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function dock() {
    // `vi.fn` cannot satisfy `matchMedia`'s overloads, so the assignment needs the
    // cast; the stub is complete for everything the code under test reads.
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: true,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  it('edits the chosen record beside the list, without navigating', async () => {
    dock();
    renderCatalog();

    await fireEvent.click((await screen.findAllByTestId('catalog-row-name-wide'))[1]!);

    // No navigation: the router remounts the page on a route change, which is
    // exactly how a list loses its scroll position.
    expect(vi.mocked(push)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('catalog-record-pane')).toBeInTheDocument();
    });
    // The list is still there beside it.
    expect(rowNames()).toEqual(['Butter', 'Lemon']);
    expect(screen.getByTestId('canon-detail-synonyms-input')).toBeInTheDocument();
  });
});
