import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  ARBITRATION_FAILED_REASONING,
  ARBITRATION_NO_MATCH_REASONING,
  normaliseMemberEmail,
  type CanonItem,
  type ProductForm,
} from '@salt/domain';

// ─── Mock stores (hoisted so vi.mock factories can reference them) ─────────────

const { mockCanonItems, mockAisles, mockProductForms, mockMembers, mockIsLoading, mockAuth } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockAisles: makeStore<{ id: string; name: string; position: number }[]>([]),
      mockProductForms: makeStore<ProductForm[]>([]),
      // AdminGuard (canon now lives behind /admin, #157) reads these.
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
    };
  });

// ─── Module mocks ──────────────────────────────────────────────────────────────

// The catalog reads the path it was reached by (issue #872): `/admin/canon/:id`
// is an alias that namespaces its id as a canon record and returns you to
// `/admin/canon` when the record goes.
vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { location: '/admin/canon/oo1', querystring: '' },
}));
// Delete is deferred (#872): it only commits when the Undo toast LAPSES, via the
// toast's own `onDismiss`. A bare vi.fn() would strand the commit, so lapse now.
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
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: mockIsLoading,
  approveCanonItems: vi.fn().mockResolvedValue({ kind: 'ok' as const, value: undefined }),
  updateCanonItemName: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemAisle: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemSynonyms: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemShoppingBehavior: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemThreshold: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemUnit: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  updateCanonItemGramsPerItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  approveCanonItemWithOverrides: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteCanonItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  splitMostRecentSynonym: vi.fn(),
  regenerateCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  unhideCanonIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/aisleService.js', () => ({
  aisles: mockAisles,
  initAisles: vi.fn().mockResolvedValue(undefined),
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
  updateCanonItemName,
  updateCanonItemAisle,
  updateCanonItemSynonyms,
  updateCanonItemShoppingBehavior,
  updateCanonItemThreshold,
  updateCanonItemUnit,
  updateCanonItemGramsPerItem,
  approveCanonItemWithOverrides,
  deleteCanonItem,
} from '../src/lib/canonService.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

function productForm(overrides: Partial<ProductForm> & { id: string }): ProductForm {
  return {
    schemaVersion: 1,
    matchers: ['olive oil spray'],
    parentCanonId: ITEM_ID,
    thumbnail: null,
    label: 'Olive oil spray',
    yield: { formUnit: 'ml', amountPerParent: 5 },
    needs_approval: false,
    updatedAt: '',
    ...overrides,
  };
}

const ITEM_ID = 'oo1';

afterEach(() => {
  cleanup();
  // bits-ui Dialog sets body.style.pointerEvents="none" via afterTick and resets it via
  // requestAnimationFrame. jsdom never fires rAF automatically, so reset it here.
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockAisles._set([]);
  mockProductForms._set([]);
  // Pass AdminGuard: signed-in user is an admin member (#157).
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
});

// Helper: render with a known item in the store
function setupWithItem(item = canonItem({ id: ITEM_ID, name: 'Olive Oil' })) {
  mockCanonItems._set([item]);
  return render(CatalogPage, { params: { id: ITEM_ID } });
}

async function openNameEditor() {
  await fireEvent.click(screen.getByRole('button', { name: /edit name/i }));
  return screen.getByTestId('canon-detail-name-input');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('the catalog record editor', () => {
  describe('an id that no longer exists', () => {
    it('falls back to the list rather than a dead end — the bookmark still lands somewhere', () => {
      mockCanonItems._set([]);
      render(CatalogPage, { params: { id: 'missing' } });
      expect(screen.queryByTestId('canon-detail-synonyms-input')).toBeNull();
      expect(screen.getByRole('heading', { name: /catalog/i })).toBeInTheDocument();
    });
  });

  describe('renders item details', () => {
    it('pre-fills the name field with the item name', async () => {
      setupWithItem();
      const nameInput = await openNameEditor();
      expect(nameInput).toHaveValue('Olive Oil');
    });

    it('pre-fills the synonyms field with comma-joined synonyms', async () => {
      setupWithItem(
        canonItem({ id: ITEM_ID, name: 'Olive Oil', synonyms: ['EVOO', 'liquid gold'] }),
      );
      expect(screen.getByTestId('canon-detail-synonyms-input')).toHaveValue('EVOO, liquid gold');
    });

    it('shows empty synonyms field when item has no synonyms', async () => {
      setupWithItem();
      expect(screen.getByTestId('canon-detail-synonyms-input')).toHaveValue('');
    });
  });

  // The commit contract (#872): blur SAVES, Enter is a convenience, Escape reverts.
  describe('name editing — the commit contract', () => {
    it('saves the name on blur — clicking away must never discard the edit', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil' });
      setupWithItem(item);

      const nameInput = await openNameEditor();
      await fireEvent.input(nameInput, { target: { value: '  Extra Virgin Olive Oil  ' } });
      await fireEvent.blur(nameInput);

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemName)).toHaveBeenCalledWith(item, 'Extra Virgin Olive Oil');
      });
    });

    it('saves the name on Enter', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil' });
      setupWithItem(item);

      const nameInput = await openNameEditor();
      await fireEvent.input(nameInput, { target: { value: 'Extra Virgin Olive Oil' } });
      await fireEvent.keyDown(nameInput, { key: 'Enter' });

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemName)).toHaveBeenCalledWith(item, 'Extra Virgin Olive Oil');
      });
    });

    it('reverts the name on Escape and saves nothing — not even on the blur that follows', async () => {
      setupWithItem();

      const nameInput = await openNameEditor();
      await fireEvent.input(nameInput, { target: { value: 'Discard me' } });
      await fireEvent.keyDown(nameInput, { key: 'Escape' });
      await fireEvent.blur(nameInput);

      expect(vi.mocked(updateCanonItemName)).not.toHaveBeenCalled();
      // Re-opening starts from the stored value again.
      expect(await openNameEditor()).toHaveValue('Olive Oil');
    });

    it('shows a name error when updateCanonItemName returns an error', async () => {
      vi.mocked(updateCanonItemName).mockResolvedValueOnce({
        kind: 'err',
        error: { kind: 'ValidationError', code: 'INVALID_CANON_NAME' },
      });
      setupWithItem();

      const nameInput = await openNameEditor();
      await fireEvent.input(nameInput, { target: { value: 'Changed' } });
      await fireEvent.keyDown(nameInput, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByText(/Invalid name/i)).toBeInTheDocument();
      });
    });
  });

  describe('synonyms editing', () => {
    it('calls updateCanonItemSynonyms with the parsed synonyms array on blur', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil' });
      setupWithItem(item);

      const synonymsInput = screen.getByTestId('canon-detail-synonyms-input');
      await fireEvent.input(synonymsInput, { target: { value: ' EVOO ,  liquid gold ' } });
      await fireEvent.blur(synonymsInput);

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemSynonyms)).toHaveBeenCalledWith(item, [
          'EVOO',
          'liquid gold',
        ]);
      });
    });
  });

  describe('aisle editing', () => {
    it('calls updateCanonItemAisle when a different aisle is selected', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil', aisleId: null });
      mockAisles._set([{ id: 'oils', name: 'Oils & Vinegars', position: 0 }]);
      setupWithItem(item);

      // Open the aisle combobox by clicking its input (role="combobox")
      await userEvent.click(screen.getByRole('combobox'));
      await waitFor(() =>
        expect(screen.getByRole('option', { name: 'Oils & Vinegars' })).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByRole('option', { name: 'Oils & Vinegars' }));

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemAisle)).toHaveBeenCalledWith(item, 'oils');
      });
    });
  });

  describe('quantity threshold — no Save button', () => {
    it('has no mid-page Save button at all', () => {
      setupWithItem();
      expect(screen.queryByTestId('canon-detail-threshold-save')).toBeNull();
    });

    it('saves the threshold on blur, storing the unit it was shown in on an item with none', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil' });
      setupWithItem(item);

      const input = screen.getByTestId('canon-detail-threshold-input');
      await fireEvent.input(input, { target: { value: '500' } });
      await fireEvent.blur(input);

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemThreshold)).toHaveBeenCalledWith(
          { ...item, unit: 'g' },
          500,
        );
      });
      expect(vi.mocked(updateCanonItemUnit)).not.toHaveBeenCalled();
    });

    it('writes nothing when tabbing through an untouched field', async () => {
      // No threshold and no stored unit: the field is blank and the unit shows
      // the default, and neither reads as a change.
      setupWithItem(canonItem({ id: ITEM_ID, name: 'Salt' }));
      await fireEvent.blur(screen.getByTestId('canon-detail-threshold-input'));
      expect(vi.mocked(updateCanonItemThreshold)).not.toHaveBeenCalled();
      expect(vi.mocked(updateCanonItemUnit)).not.toHaveBeenCalled();
    });

    // Issue #1651: clearing the threshold used to delete the unit with it, so a
    // counted item silently went back to being weighed.
    it("clearing a counted item's threshold leaves it counted", async () => {
      const item = canonItem({
        id: ITEM_ID,
        name: 'Red Onion',
        largeQuantityThreshold: 3,
        unit: 'count',
        gramsPerItem: 150,
      });
      setupWithItem(item);

      const input = screen.getByTestId('canon-detail-threshold-input');
      await fireEvent.input(input, { target: { value: '' } });
      await fireEvent.blur(input);

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemThreshold)).toHaveBeenCalledWith(item, undefined);
      });
      expect(vi.mocked(updateCanonItemUnit)).not.toHaveBeenCalled();
      expect(screen.getByTestId('canon-detail-grams-input')).toBeInTheDocument();
    });

    it('reverts the threshold on Escape and writes nothing', async () => {
      setupWithItem(canonItem({ id: ITEM_ID, name: 'Olive Oil', largeQuantityThreshold: 200 }));

      const input = screen.getByTestId('canon-detail-threshold-input');
      await fireEvent.input(input, { target: { value: '999' } });
      await fireEvent.keyDown(input, { key: 'Escape' });

      expect(input).toHaveValue('200');
      await fireEvent.blur(input);
      expect(vi.mocked(updateCanonItemThreshold)).not.toHaveBeenCalled();
    });
  });

  // Issue #1651: the unit is its own decision, saved on its own.
  describe('bought by', () => {
    it('marks an item with no threshold as counted', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Red Onion' });
      setupWithItem(item);

      await userEvent.click(screen.getByTestId('canon-detail-unit-select'));
      await waitFor(() => screen.getByRole('option', { name: 'count' }));
      await userEvent.click(screen.getByRole('option', { name: 'count' }));

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemUnit)).toHaveBeenCalledWith(item, 'count');
      });
      expect(vi.mocked(updateCanonItemThreshold)).not.toHaveBeenCalled();
    });
  });

  // The weight of one (issue #1643): offered only for an item bought by the count.
  describe('weight of one', () => {
    it('is not offered for an item bought by weight', () => {
      setupWithItem(canonItem({ id: ITEM_ID, name: 'Olive Oil', unit: 'ml' }));
      expect(screen.queryByTestId('canon-detail-grams-input')).toBeNull();
    });

    it('saves the weight of one on blur', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Red Onion', unit: 'count' });
      setupWithItem(item);
      const input = screen.getByTestId('canon-detail-grams-input');
      await fireEvent.input(input, { target: { value: '150' } });
      await fireEvent.blur(input);
      await waitFor(() => {
        expect(vi.mocked(updateCanonItemGramsPerItem)).toHaveBeenCalledWith(item, 150);
      });
    });

    it('clears it when emptied, and saves nothing for text that is not a weight', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Red Onion', unit: 'count', gramsPerItem: 150 });
      setupWithItem(item);
      const input = screen.getByTestId('canon-detail-grams-input');
      await fireEvent.input(input, { target: { value: 'lots' } });
      await fireEvent.blur(input);
      expect(vi.mocked(updateCanonItemGramsPerItem)).not.toHaveBeenCalled();
      await fireEvent.input(input, { target: { value: '150' } });
      await fireEvent.blur(input);
      expect(vi.mocked(updateCanonItemGramsPerItem)).not.toHaveBeenCalled();
      await fireEvent.input(input, { target: { value: '' } });
      await fireEvent.blur(input);
      await waitFor(() => {
        expect(vi.mocked(updateCanonItemGramsPerItem)).toHaveBeenCalledWith(item, undefined);
      });
    });

    it('reverts on Escape and writes nothing', async () => {
      setupWithItem(
        canonItem({ id: ITEM_ID, name: 'Red Onion', unit: 'count', gramsPerItem: 150 }),
      );
      const input = screen.getByTestId('canon-detail-grams-input');
      await fireEvent.input(input, { target: { value: '99' } });
      await fireEvent.keyDown(input, { key: 'Escape' });
      expect(input).toHaveValue('150');
    });

    it('saves on Enter', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Red Onion', unit: 'count' });
      setupWithItem(item);
      const input = screen.getByTestId('canon-detail-grams-input');
      await fireEvent.input(input, { target: { value: '160' } });
      await fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(vi.mocked(updateCanonItemGramsPerItem)).toHaveBeenCalledWith(item, 160);
      });
    });
  });

  // The whole point of the rewrite: `needs_approval` contributes a strip and an
  // action, never a second copy of the fields.
  describe('one field stack, pending or not', () => {
    for (const needsApproval of [false, true]) {
      it(`renders exactly one of each field when needs_approval is ${needsApproval}`, () => {
        setupWithItem(canonItem({ id: ITEM_ID, name: 'Olive Oil', needs_approval: needsApproval }));

        expect(screen.getAllByTestId('canon-detail-synonyms-input')).toHaveLength(1);
        expect(screen.getAllByTestId('canon-detail-aisle-select')).toHaveLength(1);
        expect(screen.getAllByTestId('canon-detail-threshold-input')).toHaveLength(1);
        expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
      });
    }

    it('shows the review strip and Approve only when pending', () => {
      setupWithItem(canonItem({ id: ITEM_ID, name: 'Olive Oil', needs_approval: false }));
      expect(screen.queryByTestId('canon-detail-approval-section')).toBeNull();
      expect(screen.queryByTestId('canon-detail-approve-button')).toBeNull();
    });

    it('writes shopping behaviour straight through for a PENDING item', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil', needs_approval: true });
      setupWithItem(item);

      await userEvent.click(screen.getByRole('radio', { name: 'Stocked' }));

      await waitFor(() => {
        expect(vi.mocked(updateCanonItemShoppingBehavior)).toHaveBeenCalledWith(item, 'stocked');
      });
    });
  });

  describe('approving', () => {
    it('approves with no overrides — the edits already landed', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil', needs_approval: true });
      setupWithItem(item);

      await fireEvent.click(screen.getByTestId('canon-detail-approve-button'));

      await waitFor(() => {
        expect(vi.mocked(approveCanonItemWithOverrides)).toHaveBeenCalledWith(item);
      });
    });

    it('keeps the fields on screen and does not navigate away', async () => {
      const item = canonItem({ id: ITEM_ID, name: 'Olive Oil', needs_approval: true });
      setupWithItem(item);

      await fireEvent.click(screen.getByTestId('canon-detail-approve-button'));
      await waitFor(() => expect(vi.mocked(approveCanonItemWithOverrides)).toHaveBeenCalled());

      // The live store echoes the approved item back.
      mockCanonItems._set([{ ...item, needs_approval: false }]);

      await waitFor(() => {
        expect(screen.queryByTestId('canon-detail-approval-section')).toBeNull();
      });
      expect(screen.getAllByTestId('canon-detail-synonyms-input')).toHaveLength(1);
      expect(vi.mocked(push)).not.toHaveBeenCalled();
    });
  });

  // The domain writes two sentinel strings into `reasoning` when arbitration
  // could not name the item. Those are queue markers, not words for a reader.
  describe('arbitration sentinels read as sentences', () => {
    it('explains a failed arbitration call', () => {
      setupWithItem(
        canonItem({
          id: ITEM_ID,
          name: 'Olive Oil',
          needs_approval: true,
          reasoning: ARBITRATION_FAILED_REASONING,
        }),
      );
      expect(screen.getByTestId('canon-detail-reasoning')).toHaveTextContent(
        /The AI couldn't be reached, so this was kept exactly as it was typed/i,
      );
    });

    it('explains arbitration returning no match', () => {
      setupWithItem(
        canonItem({
          id: ITEM_ID,
          name: 'Olive Oil',
          needs_approval: true,
          reasoning: ARBITRATION_NO_MATCH_REASONING,
        }),
      );
      expect(screen.getByTestId('canon-detail-reasoning')).toHaveTextContent(
        /The AI didn't recognise this as an existing item/i,
      );
    });

    it('renders any other reasoning verbatim', () => {
      setupWithItem(
        canonItem({
          id: ITEM_ID,
          name: 'Olive Oil',
          needs_approval: true,
          reasoning: 'Matched to the existing olive oil entry.',
        }),
      );
      expect(screen.getByTestId('canon-detail-reasoning')).toHaveTextContent(
        'Matched to the existing olive oil entry.',
      );
    });
  });

  describe('product forms section', () => {
    it('lists the item’s own forms and offers to add one seeded with this parent', () => {
      mockProductForms._set([
        productForm({ id: 'f1', label: 'Olive oil spray' }),
        productForm({ id: 'f2', label: 'Somebody else’s', parentCanonId: 'other' }),
      ]);
      setupWithItem();

      const rows = screen.getAllByTestId('canon-detail-form-row');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent('Olive oil spray');
      expect(screen.getByTestId('canon-detail-add-form')).toBeInTheDocument();
    });

    it('still offers Add form when the item has no forms', async () => {
      setupWithItem();
      expect(screen.queryByTestId('canon-detail-form-row')).toBeNull();

      await fireEvent.click(screen.getByTestId('canon-detail-add-form'));
      expect(vi.mocked(push)).toHaveBeenCalledWith(`/admin/product-forms/new?parent=${ITEM_ID}`);
    });
  });

  describe('delete', () => {
    it('shows an undo toast instead of a confirm dialog', async () => {
      setupWithItem();
      await fireEvent.click(screen.getByTestId('canon-detail-delete-button'));

      expect(screen.queryByTestId('canon-detail-delete-dialog')).toBeNull();
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        '"Olive Oil" deleted',
        'default',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      );
    });

    it('commits the delete when the toast lapses and returns to the list', async () => {
      setupWithItem();
      await fireEvent.click(screen.getByTestId('canon-detail-delete-button'));

      await waitFor(() => {
        expect(vi.mocked(deleteCanonItem)).toHaveBeenCalledWith(ITEM_ID);
      });
      expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/canon');
    });
  });
});
