import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { CanonItem, Member, ProductForm } from '@salt/domain';

// Editing a product form moved out of its own page and into the catalog (issue
// #872): `/admin/product-forms/:id` is now an ALIAS that opens the same record
// editor, and returns to `/admin/product-forms` when the form goes.

const { mockProductForms, mockCanonItems, mockAisles, mockMembers, mockIsLoading, mockAuth } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockProductForms: makeStore<ProductForm[]>([]),
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockAisles: makeStore<{ id: string; name: string; position: number }[]>([]),
      mockMembers: makeStore<Member[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
    };
  });

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { location: '/admin/product-forms/form-1', querystring: '' },
}));
// Deferred delete only commits when the Undo toast LAPSES, via the toast's own
// `onDismiss`. A bare vi.fn() would strand the commit — lapse now.
vi.mock('../src/lib/toastStore.js', () => ({
  addToast: vi.fn((_msg: string, _variant?: string, opts?: { onDismiss?: () => void }) => {
    opts?.onDismiss?.();
  }),
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
  updateCanonItemName: vi.fn(),
  updateCanonItemAisle: vi.fn(),
  updateCanonItemSynonyms: vi.fn(),
  updateCanonItemShoppingBehavior: vi.fn(),
  updateCanonItemThreshold: vi.fn(),
  approveCanonItemWithOverrides: vi.fn(),
  approveCanonItems: vi.fn().mockResolvedValue({ kind: 'ok' as const, value: undefined }),
  deleteCanonItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  splitMostRecentSynonym: vi.fn(),
  regenerateCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideCanonIcon: vi.fn(),
  unhideCanonIcon: vi.fn(),
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  isLoadingProductForms: mockIsLoading,
  editProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  confirmProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import CatalogPage from '../src/routes/admin/CatalogPage.svelte';
import { push } from 'svelte-spa-router';
import { addToast } from '../src/lib/toastStore.js';
import {
  editProductForm,
  confirmProductForm,
  deleteProductForm,
} from '../src/lib/productFormService.js';

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

const LIME: CanonItem = {
  schemaVersion: 5,
  id: 'canon-lime',
  name: 'lime',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  embedding: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

const LIME_ZEST: ProductForm = {
  schemaVersion: 1,
  id: 'form-1',
  matchers: ['lime zest'],
  parentCanonId: 'canon-lime',
  thumbnail: null,
  label: 'Lime zest',
  yield: { formUnit: 'g', amountPerParent: 5 },
  needs_approval: false,
  updatedAt: '2026-07-17T00:00:00.000Z',
};

function renderForm(form: ProductForm = LIME_ZEST) {
  mockMembers._set([ADMIN]);
  mockCanonItems._set([LIME]);
  mockProductForms._set([form]);
  return render(CatalogPage, { props: { params: { id: form.id } } });
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.body.style.pointerEvents = '';
  mockProductForms._set([]);
  mockCanonItems._set([]);
  vi.clearAllMocks();
});

describe('the catalog record editor — a product form', () => {
  it('opens the form the alias names', async () => {
    renderForm();
    await waitFor(() => {
      expect(screen.getByTestId('product-form-delete-button')).toBeTruthy();
    });
  });

  it('falls back to the list on an unknown id rather than a dead end', async () => {
    mockMembers._set([ADMIN]);
    mockCanonItems._set([LIME]);

    render(CatalogPage, { props: { params: { id: 'nope' } } });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /catalog/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('product-form-matchers-input')).toBeNull();
  });

  it('has no Save or Cancel — every field autosaves', async () => {
    renderForm();
    await screen.findByTestId('product-form-matchers-input');
    expect(screen.queryByTestId('product-form-save-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('saves the label on blur from the title editor', async () => {
    renderForm();

    await fireEvent.click(await screen.findByRole('button', { name: /edit label/i }));
    const labelInput = screen.getByTestId('product-form-label-input');
    await fireEvent.input(labelInput, { target: { value: 'Lime peel' } });
    await fireEvent.blur(labelInput);

    await waitFor(() => {
      expect(vi.mocked(editProductForm)).toHaveBeenCalledWith(
        LIME_ZEST,
        expect.objectContaining({ label: 'Lime peel' }),
      );
    });
  });

  it('saves the matchers on blur', async () => {
    renderForm();

    const matchers = await screen.findByTestId('product-form-matchers-input');
    await fireEvent.input(matchers, { target: { value: 'lime zest, zest of lime' } });
    await fireEvent.blur(matchers);

    await waitFor(() => {
      expect(vi.mocked(editProductForm)).toHaveBeenCalledWith(
        LIME_ZEST,
        expect.objectContaining({ matchers: ['lime zest', 'zest of lime'] }),
      );
    });
  });

  it('reverts the matchers on Escape and writes nothing', async () => {
    renderForm();

    const matchers = await screen.findByTestId('product-form-matchers-input');
    await fireEvent.input(matchers, { target: { value: 'nonsense' } });
    await fireEvent.keyDown(matchers, { key: 'Escape' });

    expect(matchers).toHaveValue('lime zest');
    await fireEvent.blur(matchers);
    expect(vi.mocked(editProductForm)).not.toHaveBeenCalled();
  });
});

describe('the catalog record editor — a form awaiting review', () => {
  const PENDING: ProductForm = { ...LIME_ZEST, needs_approval: true };

  it('shows the review strip above ONE field stack, and Confirm below it', async () => {
    renderForm(PENDING);

    await screen.findByTestId('product-form-review-banner');
    expect(screen.getAllByTestId('product-form-matchers-input')).toHaveLength(1);
    expect(screen.getAllByTestId('product-form-amount-input')).toHaveLength(1);
    expect(screen.getByTestId('product-form-confirm-button')).toBeTruthy();
  });

  it('confirms in place — the fields stay put and the page does not navigate', async () => {
    renderForm(PENDING);

    await fireEvent.click(await screen.findByTestId('product-form-confirm-button'));

    await waitFor(() => {
      expect(vi.mocked(confirmProductForm)).toHaveBeenCalledWith(
        PENDING,
        expect.objectContaining({ label: 'Lime zest', matchers: ['lime zest'] }),
      );
    });
    expect(vi.mocked(push)).not.toHaveBeenCalled();

    // The live subscription echoes the confirmed form back: the strip and the
    // button go, the fields do not move.
    mockProductForms._set([{ ...PENDING, needs_approval: false }]);
    await waitFor(() => {
      expect(screen.queryByTestId('product-form-review-banner')).toBeNull();
    });
    expect(screen.getAllByTestId('product-form-matchers-input')).toHaveLength(1);
  });
});

describe('the catalog record editor — deleting a form', () => {
  it('offers an undo toast instead of a confirm dialog, and returns to the list', async () => {
    renderForm();

    await fireEvent.click(await screen.findByTestId('product-form-delete-button'));

    expect(screen.queryByTestId('product-form-delete-dialog')).toBeNull();
    expect(vi.mocked(addToast)).toHaveBeenCalledWith(
      '"Lime zest" deleted',
      'default',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    // Back through the door it came in by (issue #872) — the alias, not /admin/catalog.
    expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/product-forms');
  });

  it('commits the delete once the toast lapses, even though the form leaves the store first', async () => {
    // The live subscription drops the deleted doc as the delete resolves, so the
    // record derives to null mid-flight. The id and label are therefore read
    // before the deferral, not after it.
    renderForm();
    vi.mocked(deleteProductForm).mockImplementation(async () => {
      mockProductForms._set([]);
      return { kind: 'ok', value: undefined };
    });

    await fireEvent.click(await screen.findByTestId('product-form-delete-button'));

    await waitFor(() => {
      expect(vi.mocked(deleteProductForm)).toHaveBeenCalledWith('form-1');
    });
  });
});
