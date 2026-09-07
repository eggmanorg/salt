import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Aisle, CanonItem, Member } from '@salt/domain';

/**
 * The aisle manager (issue #193, #931).
 *
 * Its five commands all go through `aisleService`, and since #931 each of them
 * answers a `Failure<DomainError>` instead of throwing when Firestore refuses
 * the write. The page has to SAY so, and it says it in two different registers:
 * the three dialogs word the failure inline, beside the button that caused it,
 * while the two inline gestures — rename and drag-to-reorder — have no dialog to
 * hold a message and use the shared toast instead. Those are the behaviours
 * pinned here; a refusal that produced no message would leave a person believing
 * an edit landed when it never did.
 */

const { mockAisles, mockAisleUsage, mockCanonItems, mockMembers, mockIsLoading, mockAuth, toasts } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockAisles: makeStore<Aisle[]>([]),
      mockAisleUsage: makeStore<Map<string, number>>(new Map()),
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockMembers: makeStore<Member[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      toasts: [] as { message: string; variant?: string | undefined }[],
    };
  });

// Six seams rather than the five UT-B1 allows, and none of them is optional:
// three are what `AdminGuard` needs to admit the page at all (the router it
// bounces through, the signed-in user, the roster it reads admin off), and the
// other three are the page's own collaborators — the service under refusal, the
// canon list its two dialogs enumerate, and the toast sink the assertions read.
vi.mock('svelte-spa-router', () => ({ push: vi.fn(), pop: vi.fn() }));
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
vi.mock('../src/lib/toastStore.js', () => ({
  addToast: vi.fn((message: string, variant?: string) => {
    toasts.push({ message, variant });
  }),
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/aisleService.js', () => ({
  aisles: mockAisles,
  aisleUsage: mockAisleUsage,
  isLoadingAisles: mockIsLoading,
  addAisle: vi.fn(),
  addAislesBulk: vi.fn(),
  renameAisle: vi.fn(),
  reorderAisles: vi.fn(),
  deleteAisles: vi.fn(),
  mergeAisles: vi.fn(),
}));

import AisleManagementPage from '../src/routes/canon/AisleManagementPage.svelte';
import {
  addAisle,
  addAislesBulk,
  renameAisle,
  reorderAisles,
  deleteAisles,
  mergeAisles,
} from '../src/lib/aisleService.js';

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

const REFUSED = {
  kind: 'err' as const,
  error: { kind: 'StorageError' as const, reason: 'unavailable' as const },
};

function aisle(id: string, name: string, order: number): Aisle {
  return { id, name, order };
}

function canonItem(id: string, name: string, aisleId: string | null): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name,
    synonyms: [],
    aisleId,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function renderPage() {
  mockMembers._set([ADMIN]);
  mockAisles._set([aisle('produce', 'produce', 0), aisle('dairy', 'dairy', 1)]);
  mockAisleUsage._set(new Map([['produce', 2]]));
  mockCanonItems._set([canonItem('c1', 'carrot', 'produce'), canonItem('c2', 'lemon', 'produce')]);
  return render(AisleManagementPage);
}

/** Select both rows, which is what both bulk actions need. */
async function selectBothRows(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Select' }));
  const checkboxes = await screen.findAllByRole('checkbox');
  // The first is select-all; it takes every row currently in the filter.
  await user.click(checkboxes[0]!);
}

beforeEach(() => {
  toasts.length = 0;
  vi.mocked(addAisle).mockResolvedValue({ kind: 'ok', value: aisle('new', 'new', 2) });
  vi.mocked(addAislesBulk).mockResolvedValue({ kind: 'ok', value: [] });
  vi.mocked(renameAisle).mockResolvedValue({ kind: 'ok', value: aisle('produce', 'fruit', 0) });
  vi.mocked(reorderAisles).mockResolvedValue({ kind: 'ok', value: undefined });
  vi.mocked(deleteAisles).mockResolvedValue({ kind: 'ok', value: undefined });
  vi.mocked(mergeAisles).mockResolvedValue({ kind: 'ok', value: undefined });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  mockAisles._set([]);
  mockAisleUsage._set(new Map());
  mockCanonItems._set([]);
  mockMembers._set([]);
  vi.clearAllMocks();
});

describe('AisleManagementPage — the list', () => {
  it('lists the aisles in order, title-cased, with the count of what references them', async () => {
    renderPage();
    const row = await screen.findByTestId('aisle-row-produce');
    expect(row).toHaveTextContent('Produce');
    expect(row).toHaveTextContent('2');
    // An unreferenced aisle shows no count at all rather than a zero.
    expect(screen.getByTestId('aisle-row-dairy')).not.toHaveTextContent('0');
  });

  it('filters the list by name as it is typed', async () => {
    renderPage();
    await screen.findByTestId('aisle-row-produce');

    await fireEvent.input(screen.getByPlaceholderText('Filter aisles…'), {
      target: { value: 'dair' },
    });

    await waitFor(() => expect(screen.queryByTestId('aisle-row-produce')).toBeNull());
    expect(screen.getByTestId('aisle-row-dairy')).toBeInTheDocument();
  });
});

describe('AisleManagementPage — inline gestures answer for a refused write', () => {
  it('renames on Enter and says nothing when the write lands', async () => {
    renderPage();
    await fireEvent.click(await screen.findByRole('button', { name: 'Produce' }));

    const input = await screen.findByDisplayValue('produce');
    await fireEvent.input(input, { target: { value: 'fruit & veg' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(vi.mocked(renameAisle)).toHaveBeenCalledWith('produce', 'fruit & veg'),
    );
    expect(toasts).toEqual([]);
  });

  it('toasts when the rename is refused — there is no dialog to hold the message', async () => {
    vi.mocked(renameAisle).mockResolvedValue(REFUSED);
    renderPage();
    await fireEvent.click(await screen.findByRole('button', { name: 'Produce' }));

    const input = await screen.findByDisplayValue('produce');
    await fireEvent.input(input, { target: { value: 'fruit & veg' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toEqual({
      message: 'Failed to rename aisle. Try again.',
      variant: 'destructive',
    });
  });

  it('abandons the rename on Escape without writing anything', async () => {
    renderPage();
    await fireEvent.click(await screen.findByRole('button', { name: 'Produce' }));

    const input = await screen.findByDisplayValue('produce');
    await fireEvent.input(input, { target: { value: 'fruit & veg' } });
    await fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByDisplayValue('fruit & veg')).toBeNull());
    expect(vi.mocked(renameAisle)).not.toHaveBeenCalled();
  });

  it('toasts when the reorder is refused', async () => {
    vi.mocked(reorderAisles).mockResolvedValue(REFUSED);
    renderPage();
    await screen.findByTestId('aisle-row-produce');

    // The drop itself: `SortableList` reorders on svelte-dnd-action's `finalize`
    // event, which is the component's real contract with its parent — a
    // synthetic drag in jsdom is not.
    const list = screen.getByTestId('aisle-row-produce').closest('ul')!;
    list.dispatchEvent(
      new CustomEvent('finalize', {
        detail: {
          items: [
            { id: 'dairy', item: aisle('dairy', 'dairy', 1) },
            { id: 'produce', item: aisle('produce', 'produce', 0) },
          ],
        },
      }),
    );

    await waitFor(() =>
      expect(vi.mocked(reorderAisles)).toHaveBeenCalledWith(['dairy', 'produce']),
    );
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toEqual({
      message: 'Failed to reorder aisles. Try again.',
      variant: 'destructive',
    });
  });
});

describe('AisleManagementPage — the dialogs word their own failure', () => {
  it('adds one aisle and closes, or keeps the dialog open with the reason', async () => {
    renderPage();
    await fireEvent.click(await screen.findByTestId('aisle-add-button'));
    const textarea = await screen.findByTestId('aisle-add-textarea');

    await fireEvent.input(textarea, { target: { value: 'Bakery' } });
    await fireEvent.click(screen.getByTestId('aisle-add-submit'));

    await waitFor(() => expect(vi.mocked(addAisle)).toHaveBeenCalledWith('Bakery'));
    await waitFor(() => expect(screen.queryByTestId('aisle-add-dialog')).toBeNull());
  });

  it('adds several when several lines are typed', async () => {
    renderPage();
    await fireEvent.click(await screen.findByTestId('aisle-add-button'));

    await fireEvent.input(await screen.findByTestId('aisle-add-textarea'), {
      target: { value: 'Bakery\nFrozen' },
    });
    await fireEvent.click(screen.getByTestId('aisle-add-submit'));

    await waitFor(() =>
      expect(vi.mocked(addAislesBulk)).toHaveBeenCalledWith(['Bakery', 'Frozen']),
    );
  });

  it('separates the two reasons an add can fail — a bad name from a refused write', async () => {
    vi.mocked(addAisle).mockResolvedValue({
      kind: 'err',
      error: { kind: 'ValidationError', code: 'DUPLICATE_AISLE' },
    } as never);
    renderPage();
    await fireEvent.click(await screen.findByTestId('aisle-add-button'));
    await fireEvent.input(await screen.findByTestId('aisle-add-textarea'), {
      target: { value: 'Produce' },
    });
    await fireEvent.click(screen.getByTestId('aisle-add-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('aisle-add-dialog')).toHaveTextContent(
        'Name already exists or is invalid.',
      ),
    );

    vi.mocked(addAisle).mockResolvedValue(REFUSED);
    await fireEvent.click(screen.getByTestId('aisle-add-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('aisle-add-dialog')).toHaveTextContent(
        'Failed to save. Try again.',
      ),
    );
  });

  it('keeps the delete dialog open with its own message when the delete is refused', async () => {
    vi.mocked(deleteAisles).mockResolvedValue(REFUSED);
    renderPage();
    const user = userEvent.setup();
    await selectBothRows(user);

    await user.click(await screen.findByTestId('bulk-delete-button'));
    // The dialog names what a delete costs before it is confirmed.
    const dialog = await screen.findByTestId('bulk-delete-dialog');
    expect(dialog).toHaveTextContent('Carrot');
    expect(dialog).toHaveTextContent('Lemon');

    await user.click(screen.getByTestId('bulk-delete-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('bulk-delete-dialog')).toHaveTextContent(
        'Failed to delete aisles. Try again.',
      ),
    );
    // Still open, and the selection is intact, so the act can be retried.
    expect(screen.getByTestId('bulk-delete-confirm')).toBeInTheDocument();
  });

  it('closes the delete dialog when the delete lands', async () => {
    renderPage();
    const user = userEvent.setup();
    await selectBothRows(user);

    await user.click(await screen.findByTestId('bulk-delete-button'));
    await user.click(await screen.findByTestId('bulk-delete-confirm'));

    await waitFor(() =>
      expect(vi.mocked(deleteAisles)).toHaveBeenCalledWith(
        expect.arrayContaining(['produce', 'dairy']),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('bulk-delete-dialog')).toBeNull());
  });

  it('keeps the merge dialog open with its own message when the merge is refused', async () => {
    vi.mocked(mergeAisles).mockResolvedValue(REFUSED);
    renderPage();
    const user = userEvent.setup();
    await selectBothRows(user);

    await user.click(await screen.findByTestId('bulk-merge-button'));
    // Two buttons read "Merge" once the dialog is open — the action bar's, which
    // opened it, and the dialog's own confirm. The confirm is the later one.
    const confirms = await screen.findAllByRole('button', { name: 'Merge' });
    await user.click(confirms[confirms.length - 1]!);

    await waitFor(() => expect(vi.mocked(mergeAisles)).toHaveBeenCalled());
    // The target is the first selected aisle; the rest are the sources.
    const input = vi.mocked(mergeAisles).mock.calls[0]![0];
    expect(input.sourceIds).not.toContain(input.targetId);
    await waitFor(() =>
      expect(screen.getByText('Failed to merge aisles. Try again.')).toBeInTheDocument(),
    );
  });
});
