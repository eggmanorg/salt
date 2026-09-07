import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { Member, ProductForm } from '@salt/domain';

const {
  mockProductForms,
  mockCanonItems,
  mockMembers,
  mockIsLoadingMembers,
  mockAuth,
  mockRouter,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockProductForms: makeStore<ProductForm[]>([]),
    mockCanonItems: makeStore<{ id: string; name: string; needs_approval?: boolean }[]>([]),
    mockMembers: makeStore<Member[]>([]),
    mockIsLoadingMembers: makeStore<boolean>(false),
    mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
    // svelte-spa-router's `router` is a rune-backed state object; the page reads
    // `router.querystring` to seed `?parent=` on the create path (#872).
    mockRouter: { querystring: '' as string | undefined },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: mockRouter }));
// Delete is deferred (#872) and only commits when the Undo toast LAPSES, via the
// toast's own `onDismiss`. A bare vi.fn() would strand the commit — lapse now.
vi.mock('../src/lib/toastStore.js', () => ({
  addToast: vi.fn((_msg: string, _variant?: string, opts?: { onDismiss?: () => void }) => {
    opts?.onDismiss?.();
  }),
}));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoadingMembers,
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
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  addProductForm: vi.fn().mockResolvedValue({ kind: 'ok', value: { id: 'form-new' } }),
}));

import ProductFormEditPage from '../src/routes/admin/ProductFormEditPage.svelte';
import { addProductForm } from '../src/lib/productFormService.js';

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

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.body.style.pointerEvents = '';
  mockProductForms._set([]);
  mockCanonItems._set([]);
  mockRouter.querystring = '';
  vi.clearAllMocks();
});

// Editing a form moved into the catalog (issue #872); this page CREATES and
// nothing else. Its edit coverage lives in CatalogPage.form.test.ts.
describe('ProductFormEditPage — create', () => {
  it('renders the add form when the router passes no params', async () => {
    // The /admin/product-forms/new route is STATIC, so svelte-spa-router mounts this
    // page with NO `params` prop at all. Dereferencing `params.id` here used to throw
    // on mount and hang the page on its route-loading spinner (add-form was dead).
    mockMembers._set([ADMIN]);
    mockCanonItems._set([{ id: 'canon-lime', name: 'Lime' }]);

    render(ProductFormEditPage);

    await waitFor(() => {
      expect(screen.getByText('Add product form')).toBeTruthy();
    });
    // The delete action only belongs to an existing form.
    expect(screen.queryByTestId('product-form-delete-button')).toBeNull();
  });

  // Creating is a consequence, so it keeps an explicit button — there is no
  // record to autosave into (#872, D2).
  it('keeps an explicit create action and writes only when it is pressed', async () => {
    mockMembers._set([ADMIN]);
    mockCanonItems._set([{ id: 'canon-lime', name: 'Lime' }]);

    render(ProductFormEditPage);

    const labelInput = await screen.findByTestId('product-form-label-input');
    await fireEvent.input(labelInput, { target: { value: 'Lime juice' } });
    await fireEvent.blur(labelInput);
    expect(vi.mocked(addProductForm)).not.toHaveBeenCalled();

    await fireEvent.input(screen.getByTestId('product-form-matchers-input'), {
      target: { value: 'lime juice' },
    });
    await fireEvent.input(screen.getByTestId('product-form-amount-input'), {
      target: { value: '30' },
    });
    await fireEvent.click(screen.getByTestId('product-form-save-button'));

    await waitFor(() => {
      expect(vi.mocked(addProductForm)).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Lime juice', matchers: ['lime juice'] }),
      );
    });
  });

  it('seeds the parent from ?parent= so "Add form" on a canon item lands pre-filled', async () => {
    mockMembers._set([ADMIN]);
    mockCanonItems._set([{ id: 'canon-lime', name: 'Lime' }]);
    mockRouter.querystring = 'parent=canon-lime';

    render(ProductFormEditPage);

    await fireEvent.input(await screen.findByTestId('product-form-label-input'), {
      target: { value: 'Lime juice' },
    });
    await fireEvent.input(screen.getByTestId('product-form-matchers-input'), {
      target: { value: 'lime juice' },
    });
    await fireEvent.input(screen.getByTestId('product-form-amount-input'), {
      target: { value: '30' },
    });
    await fireEvent.click(screen.getByTestId('product-form-save-button'));

    await waitFor(() => {
      expect(vi.mocked(addProductForm)).toHaveBeenCalledWith(
        expect.objectContaining({ parentCanonId: 'canon-lime' }),
      );
    });
  });
});
