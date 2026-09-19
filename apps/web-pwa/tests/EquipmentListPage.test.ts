import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';
import type { EquipmentIconDoc, KitchenToolDoc } from '@salt/domain/schemas';

const { mockEquipment, mockIsLoading, mockEquipmentIcons, mockKitchenTools } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockEquipment: makeStore<EquipmentManifest | null>(null),
      mockIsLoading: makeStore<boolean>(false),
      // Pictograms (issue #877). Empty by default, which is the real "no art yet"
      // state — every row renders CanonIcon's pale placeholder tile, and these
      // cases go on testing the list rather than the icons.
      mockEquipmentIcons: makeStore<Map<string, EquipmentIconDoc>>(new Map()),
      mockKitchenTools: makeStore<readonly KitchenToolDoc[]>([]),
    };
  },
);

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  isLoadingEquipment: mockIsLoading,
  removeEquipmentItems: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  equipmentIcons: mockEquipmentIcons,
  // The real ones, not stand-ins: the "not drawn yet" marker AND the row's
  // picture (issue #1458 — a borrowed picture must render, not just be excused
  // from the count) are both decided by reading this map, so a stubbed lookup
  // would test the stub.
  equipmentThumbnailFor: (icons: Map<string, EquipmentIconDoc>, id: string) =>
    icons.get(id)?.thumbnail ?? null,
  equipmentIconVersionFor: () => undefined,
  equipmentIconFor: (icons: Map<string, EquipmentIconDoc>, id: string) => icons.get(id) ?? null,
}));
// Only the vocabulary store stands in; `toolPicture` — the tri-state fold and the
// cache-bust rule — stays the real one, same reason `KitPicturePicker.test.ts` does
// this: a stubbed `toolPicture` would test the stub, not the row's resolution.
vi.mock('../src/lib/kitchenToolService.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/kitchenToolService.js')>()),
  kitchenTools: mockKitchenTools,
}));

import EquipmentListPage from '../src/routes/equipment/EquipmentListPage.svelte';
import { push } from 'svelte-spa-router';
import { removeEquipmentItems } from '../src/lib/equipmentService.js';
import { addToast } from '../src/lib/toastStore.js';

function item(
  id: string,
  name: string,
  accessoryCount = 0,
  ruleCount = 0,
): EquipmentManifest['items'][number] {
  return {
    id,
    schemaVersion: 1,
    name,
    kind: 'equipment',
    accessories: Array.from({ length: accessoryCount }, (_, i) => ({
      id: `${id}-acc-${i}`,
      name: `Acc ${i}`,
      owned: false,
      borrowedPicture: null,
      included: false,
      note: '',
    })),
    rules: Array.from({ length: ruleCount }, (_, i) => `rule ${i}`),
    note: '',
    environment: null,
    borrowedPicture: null,
    updatedAt: '2026-05-13T00:00:00.000Z',
  };
}

function manifest(items: EquipmentManifest['items']): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: '2026-05-13T00:00:00.000Z', items };
}

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEquipment._set(null);
  mockIsLoading._set(false);
  mockEquipmentIcons._set(new Map());
  mockKitchenTools._set([]);
});

function tool(
  id: string,
  thumbnail: string | null = `https://example.test/${id}.webp`,
): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label: id,
    matchers: [],
    thumbnail,
    createdAt: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as KitchenToolDoc;
}

function iconDoc(overrides: Partial<EquipmentIconDoc> = {}): EquipmentIconDoc {
  return {
    subjectBrief: 'A plastic salad spinner with a crank lid.',
    briefSourceName: 'Salad Spinner',
    thumbnail: null,
    ...overrides,
  };
}

describe('EquipmentListPage', () => {
  it('renders empty state when manifest has no items', () => {
    mockEquipment._set(manifest([]));
    render(EquipmentListPage);
    expect(screen.queryByTestId('equipment-list-item')).not.toBeInTheDocument();
  });

  it('renders one row per item, sorted alphabetically by name', () => {
    mockEquipment._set(
      manifest([item('z', 'Zester'), item('a', 'Apple corer'), item('m', 'Mixer')]),
    );
    render(EquipmentListPage);
    const rows = screen.getAllByTestId('equipment-list-item');
    expect(rows.map((r) => r.textContent?.trim().split(/\s+/)[0])).toEqual([
      'Apple',
      'Mixer',
      'Zester',
    ]);
  });

  it('renders singular "1 accessory" when an item has exactly one accessory', () => {
    mockEquipment._set(manifest([item('a', 'Mixer', 1, 0)]));
    render(EquipmentListPage);
    expect(screen.getByText(/1 accessory\b/)).toBeInTheDocument();
    expect(screen.queryByText(/accessoryies/)).not.toBeInTheDocument();
  });

  it('renders plural "2 accessories" when an item has multiple accessories (no "accessoryies" typo)', () => {
    mockEquipment._set(manifest([item('a', 'Mixer', 2, 0)]));
    render(EquipmentListPage);
    expect(screen.getByText(/2 accessories\b/)).toBeInTheDocument();
    expect(screen.queryByText(/accessoryies/)).not.toBeInTheDocument();
  });

  it('navigates to the detail page when a row is clicked', async () => {
    mockEquipment._set(manifest([item('mixer-id', 'Mixer')]));
    render(EquipmentListPage);
    await userEvent.click(screen.getByTestId('equipment-list-item'));
    expect(vi.mocked(push)).toHaveBeenCalledWith('/equipment/mixer-id');
  });

  it('delete button is absent before any items are selected', () => {
    mockEquipment._set(manifest([item('a', 'Blender')]));
    render(EquipmentListPage);
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('select-all checkbox selects all items and shows count', async () => {
    mockEquipment._set(manifest([item('a', 'Blender'), item('b', 'Mixer')]));
    render(EquipmentListPage);
    await userEvent.click(screen.getByRole('button', { name: /^select$/i }));
    const selectAll = screen.getByRole('checkbox', { name: /select all/i });
    await userEvent.click(selectAll);
    await waitFor(() => expect(screen.getByText(/2 selected/i)).toBeInTheDocument());
  });

  it('toggling select-all off deselects all items and hides the bulk action bar', async () => {
    mockEquipment._set(manifest([item('a', 'Blender')]));
    render(EquipmentListPage);
    await userEvent.click(screen.getByRole('button', { name: /^select$/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument(),
    );
    // The select-all checkbox now reads "1 selected"; clicking it again clears the selection.
    await userEvent.click(screen.getByRole('checkbox', { name: /1 selected/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument(),
    );
  });

  it('multi-select delete hides the item immediately and commits on undo-toast dismiss', async () => {
    mockEquipment._set(manifest([item('to-delete', 'Old Blender')]));
    render(EquipmentListPage);

    await userEvent.click(screen.getByRole('button', { name: /^select$/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /select all/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    // Deferred-delete: the row is hidden immediately and an Undo toast is raised,
    // but the real delete has not run yet (no confirm dialog).
    await waitFor(() =>
      expect(screen.queryByTestId('equipment-list-item')).not.toBeInTheDocument(),
    );
    expect(vi.mocked(addToast)).toHaveBeenCalledTimes(1);
    const [message, , options] = vi.mocked(addToast).mock.calls[0]!;
    expect(message).toMatch(/deleted/i);
    expect(options?.action?.label).toBe('Undo');
    expect(vi.mocked(removeEquipmentItems)).not.toHaveBeenCalled();

    // Letting the toast lapse commits the delete.
    options?.onDismiss?.();
    await waitFor(() =>
      expect(vi.mocked(removeEquipmentItems)).toHaveBeenCalledWith(['to-delete']),
    );
  });

  it('undoing the delete keeps the item and never calls removeEquipmentItems', async () => {
    mockEquipment._set(manifest([item('keep', 'Old Blender')]));
    render(EquipmentListPage);

    await userEvent.click(screen.getByRole('button', { name: /^select$/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('equipment-list-item')).not.toBeInTheDocument(),
    );
    const [, , options] = vi.mocked(addToast).mock.calls[0]!;

    // Undo reveals the item; a subsequent dismiss must not commit the delete.
    options?.action?.onClick?.();
    await waitFor(() => expect(screen.getByTestId('equipment-list-item')).toBeInTheDocument());
    options?.onDismiss?.();
    expect(vi.mocked(removeEquipmentItems)).not.toHaveBeenCalled();
  });
});

// Issue #1458, Phase 1 — the gap said out loud, and closed from where it is seen.
describe('EquipmentListPage — undrawn records', () => {
  it('marks a record whose description was authored but never drawn', () => {
    mockEquipment._set(manifest([item('spin', 'Salad Spinner')]));
    mockEquipmentIcons._set(new Map([['spin', iconDoc()]]));
    render(EquipmentListPage);
    expect(screen.getByTestId('equipment-undrawn')).toHaveTextContent('Not drawn yet');
  });

  it('does not mark a record that has a drawing', () => {
    mockEquipment._set(manifest([item('spin', 'Salad Spinner')]));
    mockEquipmentIcons._set(
      new Map([['spin', iconDoc({ thumbnail: 'https://example.test/spin.webp' })]]),
    );
    render(EquipmentListPage);
    expect(screen.queryByTestId('equipment-undrawn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('equipment-draw')).not.toBeInTheDocument();
  });

  // "Hidden" is the user's answer for that row, not an omission — the whole
  // point of the marker is that it distinguishes the two states an empty tile
  // used to conflate.
  it('does not mark a record whose picture was deliberately hidden', () => {
    mockEquipment._set(manifest([item('spin', 'Salad Spinner')]));
    mockEquipmentIcons._set(new Map([['spin', iconDoc({ thumbnail: 'hidden' })]]));
    render(EquipmentListPage);
    expect(screen.queryByTestId('equipment-undrawn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('equipment-draw')).not.toBeInTheDocument();
  });

  it('does not mark a record pointed at a picture that already exists', () => {
    const borrower = item('spin', 'Salad Spinner');
    mockEquipment._set(
      manifest([{ ...borrower, borrowedPicture: { family: 'kitchenTool', id: 'salad-spinner' } }]),
    );
    mockEquipmentIcons._set(new Map([['spin', iconDoc()]]));
    render(EquipmentListPage);
    expect(screen.queryByTestId('equipment-undrawn')).not.toBeInTheDocument();
  });

  // Daniel's ruling on the reviewed first cut of this page: Draw from the list
  // is one press TO the record's page, never a second place that draws. This is
  // the regression test for the review's blocking finding — a version of this
  // button that called `drawEquipmentIcon` in place, from the list's own row,
  // could draw a stale stored description onto a renamed record with nobody
  // having read it (rename a never-drawn record while its brief re-author is in
  // flight, press Draw from the list, the callable's matching-name transaction
  // arm stamps `sourceName = briefSourceName` and `equipmentIconAwaitingApproval`
  // reads false under the new name). Routing every press through this page
  // instead removes that path entirely: nothing on `/equipment` can reach
  // `drawEquipmentIcon` any more, only the record's own page can, and that page
  // shows the current description before the button is live.
  it('does not draw in place — Draw is a one-press route to the record page, and #877s gate', async () => {
    mockEquipment._set(manifest([item('spin', 'Salad Spinner')]));
    mockEquipmentIcons._set(
      new Map([['spin', iconDoc({ subjectBrief: '  A crank-lid spinner. ' })]]),
    );
    render(EquipmentListPage);
    await userEvent.click(screen.getByTestId('equipment-draw'));
    // The gate this closes: nothing here ever calls the drawing callable, so a
    // stale or unread description can never be drawn from this row. Only
    // navigation happens.
    expect(vi.mocked(push)).toHaveBeenCalledWith('/equipment/spin');
    expect(vi.mocked(addToast)).not.toHaveBeenCalled();
  });

  it('Draw navigates to the record even when its description has just been renamed underneath it', async () => {
    // The exact reachable shape review found: a rename in flight, the row still
    // marked undrawn with a brief on file for the OLD name. Whatever the stored
    // brief says, this button must never send it anywhere — only navigate.
    mockEquipment._set(manifest([item('sage-oven', 'Sage the Smart Oven Pizzaiolo SPZ820')]));
    mockEquipmentIcons._set(
      new Map([
        [
          'sage-oven',
          iconDoc({ briefSourceName: 'Sage oven', subjectBrief: 'A compact countertop oven.' }),
        ],
      ]),
    );
    render(EquipmentListPage);
    await userEvent.click(screen.getByTestId('equipment-draw'));
    expect(vi.mocked(push)).toHaveBeenCalledWith('/equipment/sage-oven');
    expect(vi.mocked(addToast)).not.toHaveBeenCalled();
  });

  // A draw with no brief is not a request the callable should have to interpret,
  // and a record can be marked before the manifest trigger has authored one.
  it('marks a record with no description yet, but offers no Draw button', () => {
    mockEquipment._set(manifest([item('spin', 'Salad Spinner')]));
    render(EquipmentListPage);
    expect(screen.getByTestId('equipment-undrawn')).toBeInTheDocument();
    expect(screen.queryByTestId('equipment-draw')).not.toBeInTheDocument();
  });
});

// Issue #1458 should-fix: a borrowed record (#1465 Phase 3) is not a gap, but
// until now nothing on this page RESOLVED the reference, so it rendered as the
// same bare tile a real gap renders — on the one page the "Not drawn yet" marker
// lives, which made the marker's own justification false here.
describe('EquipmentListPage — borrowed pictures render', () => {
  it("renders a record's own picture over its borrowed one", () => {
    const spinner = item('spin', 'Salad Spinner');
    mockEquipment._set(
      manifest([{ ...spinner, borrowedPicture: { family: 'kitchenTool', id: 'other-tool' } }]),
    );
    mockEquipmentIcons._set(
      new Map([['spin', iconDoc({ thumbnail: 'https://example.test/spin-own.webp' })]]),
    );
    mockKitchenTools._set([tool('other-tool')]);
    render(EquipmentListPage);
    const img = screen.getByRole('img', { name: 'Salad Spinner' });
    expect(img).toHaveAttribute('src', expect.stringContaining('spin-own.webp'));
  });

  it('renders the borrowed kitchenTool picture when the record has none of its own', () => {
    const spinner = item('spin', 'Salad Spinner');
    mockEquipment._set(
      manifest([
        { ...spinner, borrowedPicture: { family: 'kitchenTool', id: 'salad-spinner-tool' } },
      ]),
    );
    mockKitchenTools._set([tool('salad-spinner-tool')]);
    render(EquipmentListPage);
    const img = screen.getByRole('img', { name: 'Salad Spinner' });
    expect(img).toHaveAttribute('src', expect.stringContaining('salad-spinner-tool.webp'));
  });

  it('renders the borrowed equipment record picture, read through the reference', () => {
    const borrower = item('spin', 'Salad Spinner');
    const source = item('source', 'Source spinner');
    mockEquipment._set(
      manifest([{ ...borrower, borrowedPicture: { family: 'equipment', id: 'source' } }, source]),
    );
    mockEquipmentIcons._set(
      new Map([['source', iconDoc({ thumbnail: 'https://example.test/source.webp' })]]),
    );
    render(EquipmentListPage);
    const img = screen.getByRole('img', { name: 'Salad Spinner' });
    expect(img).toHaveAttribute('src', expect.stringContaining('source.webp'));
  });

  // The boundary `undrawnEquipment.ts`'s header now names: a borrow pointed at a
  // HIDDEN source resolves to no picture (the reachable trigger), same as one
  // pointed at nothing at all. Not a gap, but not a picture either — the bare
  // tile is the honest answer here, never a stale/wrong one.
  it('renders no picture for a record borrowed from a now-hidden source', () => {
    const borrower = item('spin', 'Salad Spinner');
    mockEquipment._set(
      manifest([{ ...borrower, borrowedPicture: { family: 'equipment', id: 'source' } }]),
    );
    mockEquipmentIcons._set(new Map([['source', iconDoc({ thumbnail: 'hidden' })]]));
    render(EquipmentListPage);
    expect(screen.queryByRole('img', { name: 'Salad Spinner' })).not.toBeInTheDocument();
  });
});
