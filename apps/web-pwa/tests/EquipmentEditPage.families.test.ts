import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';
import type { EquipmentIconDoc, EquipmentKind } from '@salt/domain/schemas';

// One record for a set of similar things (issue #1373). The list under a record
// is the SAME list whether the record is an appliance or a family of kit — so
// what this file pins is the handful of places where the flag is allowed to
// show: the wording, the owned tick, and what an added entry is written with.

const { mockEquipment, mockEquipmentIcons } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockEquipment: makeStore<EquipmentManifest | null>(null),
    mockEquipmentIcons: makeStore<Map<string, EquipmentIconDoc>>(new Map()),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  equipmentIcons: mockEquipmentIcons,
  equipmentIconFor: () => null,
  equipmentThumbnailFor: () => null,
  equipmentIconVersionFor: () => undefined,
  drawEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reviseEquipmentBrief: vi.fn(),
  restartEquipmentBrief: vi.fn(),
  describeEquipmentFromPhoto: vi.fn(),
  renameEquipmentItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addEquipmentAccessory: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentAccessory: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  toggleEquipmentAccessoryOwned: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editEquipmentAccessoryNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editEquipmentItemNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setEquipmentItemKind: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setEquipmentEnvironmentFor: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // The entry-picture dialog's own calls (issue #1465, Phase 2). It is lazily
  // imported by the row below, so its imports have to resolve here even though
  // what this file asserts is only that the row opens it.
  authorEntryIconBrief: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import EquipmentEditPage from '../src/routes/equipment/EquipmentEditPage.svelte';
import {
  addEquipmentAccessory,
  editEquipmentAccessoryNote,
  editEquipmentItemNote,
  setEquipmentItemKind,
} from '../src/lib/equipmentService.js';
import { addToast } from '../src/lib/toastStore.js';

const ITEM_ID = 'kit-1';
const NOW = '2026-09-14T00:00:00.000Z';

interface SeedEntry {
  id: string;
  name: string;
  owned: boolean;
  note?: string;
}

function seed(kind: EquipmentKind, entries: SeedEntry[] = [], note = ''): void {
  mockEquipment._set({
    schemaVersion: 1,
    updatedAt: NOW,
    items: [
      {
        id: ITEM_ID,
        schemaVersion: 1,
        name: kind === 'family' ? 'Frying pans' : 'Magimix Cook Expert',
        kind,
        accessories: entries.map((e) => ({
          id: e.id,
          name: e.name,
          owned: e.owned,
          included: false,
          note: e.note ?? '',
        })),
        rules: [],
        note,
        environment: null,
        updatedAt: NOW,
      },
    ],
  });
  mockEquipmentIcons._set(new Map());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEquipment._set(null);
});

afterEach(cleanup);

describe('EquipmentEditPage — a family of kit (issue #1373)', () => {
  it('calls the list "Contains" for a family and "Accessories" for equipment', async () => {
    seed('family', [{ id: 'a1', name: '28cm cast iron', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    expect(await screen.findByText(/Contains/)).toBeTruthy();
    expect(screen.queryByText(/^\s*Accessories/)).toBeNull();

    cleanup();
    seed('equipment', [{ id: 'a1', name: 'Thermo Bowl', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    expect(await screen.findByText(/Accessories/)).toBeTruthy();
  });

  // Decision 8, and the half of it that is visible: the tick is real information
  // about an APPLIANCE'S accessory and is kept; a family is a list of what the
  // household has, so the control has nothing to say and is not rendered. What
  // is stored is untouched either way — that half is pinned in the domain.
  it('hides the owned tick for a family and keeps it for equipment', async () => {
    seed('family', [{ id: 'a1', name: '28cm cast iron', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    await screen.findByTestId('equipment-accessory-row');
    expect(screen.queryByLabelText('Owned')).toBeNull();

    cleanup();
    seed('equipment', [{ id: 'a1', name: 'Thermo Bowl', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    await screen.findByTestId('equipment-accessory-row');
    expect(screen.getByLabelText('Owned')).toBeTruthy();
  });

  it("writes a family's entries as owned, and an appliance's as not", async () => {
    seed('family');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const input = await screen.findByTestId('equipment-add-accessory-input');
    await fireEvent.input(input, { target: { value: '32cm stainless' } });
    await fireEvent.click(screen.getByTestId('equipment-add-accessory-btn'));
    await waitFor(() =>
      expect(vi.mocked(addEquipmentAccessory)).toHaveBeenCalledWith(
        ITEM_ID,
        '32cm stainless',
        true,
        false,
      ),
    );

    cleanup();
    vi.clearAllMocks();
    seed('equipment');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const input2 = await screen.findByTestId('equipment-add-accessory-input');
    await fireEvent.input(input2, { target: { value: 'Juice Extractor Kit' } });
    await fireEvent.click(screen.getByTestId('equipment-add-accessory-btn'));
    await waitFor(() =>
      expect(vi.mocked(addEquipmentAccessory)).toHaveBeenCalledWith(
        ITEM_ID,
        'Juice Extractor Kit',
        false,
        false,
      ),
    );
  });
});

describe('EquipmentEditPage — notes (issue #1373)', () => {
  it('shows a note field on every entry, whatever the record is', async () => {
    seed('family', [
      { id: 'a1', name: '28cm cast iron', owned: true, note: 'the only one for the oven' },
    ]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const field = (await screen.findByTestId('equipment-accessory-note-input')) as HTMLInputElement;
    expect(field.value).toBe('the only one for the oven');
  });

  it('commits an entry note on blur, not on every keystroke', async () => {
    seed('equipment', [{ id: 'a1', name: 'Thermo Bowl', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const field = await screen.findByTestId('equipment-accessory-note-input');
    await fireEvent.input(field, { target: { value: 'seal is perished' } });
    expect(vi.mocked(editEquipmentAccessoryNote)).not.toHaveBeenCalled();
    await fireEvent.blur(field);
    await waitFor(() =>
      expect(vi.mocked(editEquipmentAccessoryNote)).toHaveBeenCalledWith(
        ITEM_ID,
        'a1',
        'seal is perished',
      ),
    );
  });

  it('commits the record note on blur', async () => {
    seed('equipment');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const field = await screen.findByTestId('equipment-item-note-input');
    await fireEvent.input(field, { target: { value: 'on a high shelf' } });
    expect(vi.mocked(editEquipmentItemNote)).not.toHaveBeenCalled();
    await fireEvent.blur(field);
    await waitFor(() =>
      expect(vi.mocked(editEquipmentItemNote)).toHaveBeenCalledWith(ITEM_ID, 'on a high shelf'),
    );
  });

  it('writes nothing when a blur leaves the note unchanged', async () => {
    seed('equipment', [{ id: 'a1', name: 'Thermo Bowl', owned: true, note: 'unchanged' }], 'same');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    await fireEvent.blur(await screen.findByTestId('equipment-accessory-note-input'));
    await fireEvent.blur(screen.getByTestId('equipment-item-note-input'));
    expect(vi.mocked(editEquipmentAccessoryNote)).not.toHaveBeenCalled();
    expect(vi.mocked(editEquipmentItemNote)).not.toHaveBeenCalled();
  });
});

describe('EquipmentEditPage — saying what a record is (issue #1373)', () => {
  it('marks an equipment record as a family through the picker', async () => {
    const user = userEvent.setup();
    seed('equipment');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    await user.click(await screen.findByTestId('equipment-kind-select'));
    await user.click(await screen.findByRole('option', { name: /family of kit/i }));
    await waitFor(() =>
      expect(vi.mocked(setEquipmentItemKind)).toHaveBeenCalledWith(ITEM_ID, 'family'),
    );
  });

  it('writes nothing when the picker lands on what the record already is', async () => {
    const user = userEvent.setup();
    seed('family');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    await user.click(await screen.findByTestId('equipment-kind-select'));
    await user.click(await screen.findByRole('option', { name: /family of kit/i }));
    expect(vi.mocked(setEquipmentItemKind)).not.toHaveBeenCalled();
  });

  it('says so when a write is refused, rather than failing quietly', async () => {
    vi.mocked(editEquipmentItemNote).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    seed('equipment');
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const field = await screen.findByTestId('equipment-item-note-input');
    await fireEvent.input(field, { target: { value: 'on a high shelf' } });
    await fireEvent.blur(field);
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Failed to save note.', 'destructive'),
    );
  });

  it('says so when an entry note is refused', async () => {
    vi.mocked(editEquipmentAccessoryNote).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    seed('equipment', [{ id: 'a1', name: 'Thermo Bowl', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
    const field = await screen.findByTestId('equipment-accessory-note-input');
    await fireEvent.input(field, { target: { value: 'seal is perished' } });
    await fireEvent.blur(field);
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Failed to save note.', 'destructive'),
    );
  });
});

describe('an entry can be given a picture of its own (issue #1465, Phase 2)', () => {
  it('opens the picture dialog from the row, for a family member and an accessory alike', async () => {
    seed('family', [{ id: 'acc-1', name: 'De Buyer 28cm', owned: true }]);
    render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });

    // The row's tile shows what THIS entry has, which is nothing — the record's
    // picture standing in here would answer the wrong question (kitIcons.ts owns
    // the fallback, and only on a recipe).
    await fireEvent.click(screen.getByTestId('equipment-accessory-icon-btn'));
    await waitFor(() => expect(screen.getByTestId('equipment-entry-icon-dialog')).toBeTruthy());
    // Nothing is described until it is asked for.
    expect(screen.getByTestId('equipment-entry-describe-btn')).toBeTruthy();
  });
});
