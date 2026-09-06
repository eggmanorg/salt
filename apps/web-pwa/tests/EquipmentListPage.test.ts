import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';

const { mockEquipment, mockIsLoading, mockEquipmentIcons } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockEquipment: makeStore<EquipmentManifest | null>(null),
    mockIsLoading: makeStore<boolean>(false),
    // Pictograms (issue #877). Empty by default, which is the real "no art yet"
    // state — every row renders CanonIcon's pale placeholder tile, and these
    // cases go on testing the list rather than the icons.
    mockEquipmentIcons: makeStore<Map<string, unknown>>(new Map()),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  isLoadingEquipment: mockIsLoading,
  removeEquipmentItems: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  equipmentIcons: mockEquipmentIcons,
  equipmentThumbnailFor: () => null,
  equipmentIconVersionFor: () => undefined,
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
    accessories: Array.from({ length: accessoryCount }, (_, i) => ({
      id: `${id}-acc-${i}`,
      name: `Acc ${i}`,
      owned: false,
      included: false,
    })),
    rules: Array.from({ length: ruleCount }, (_, i) => `rule ${i}`),
    environment: null,
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
});

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
