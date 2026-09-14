import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';

const { mockIsLoadingEquipment } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return { mockIsLoadingEquipment: makeStore<boolean>(false) };
});

// One browser-rooted action span across the add-equipment action (issue #361):
// startUserActionSpan returns a handle whose `.traceparent` is handed to BOTH AI
// calls. The mock exposes a fixed traceparent + spies so the tests can assert the
// SAME id reaches both calls and the span is closed on terminal outcomes.
const ACTION_TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
const { mockActionSpan, mockStartUserActionSpan } = vi.hoisted(() => {
  const tp = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  const span = {
    traceparent: tp,
    child: vi.fn(() => ({ setError: vi.fn(), end: vi.fn() })),
    setError: vi.fn(),
    setAttribute: vi.fn(),
    end: vi.fn(),
  };
  return { mockActionSpan: span, mockStartUserActionSpan: vi.fn(() => span) };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('@salt/observability', () => ({ startUserActionSpan: mockStartUserActionSpan }));
vi.mock('../src/lib/equipmentService.js', () => ({
  isLoadingEquipment: mockIsLoadingEquipment,
  callIdentifyEquipment: vi.fn(),
  callPopulateEquipmentEntry: vi.fn(),
  captureEquipmentItem: vi.fn(),
}));

import EquipmentCapturePage from '../src/routes/equipment/EquipmentCapturePage.svelte';
import { push } from 'svelte-spa-router';
import { addToast } from '../src/lib/toastStore.js';
import {
  callIdentifyEquipment,
  callPopulateEquipmentEntry,
  captureEquipmentItem,
} from '../src/lib/equipmentService.js';

function makeManifest(): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: '2026-05-13T00:00:00.000Z', items: [] };
}

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingEquipment._set(false);
});

async function walkThroughCapture(name: string) {
  vi.mocked(callIdentifyEquipment).mockResolvedValueOnce({
    kind: 'ok',
    value: { candidates: [] },
  });
  vi.mocked(callPopulateEquipmentEntry).mockResolvedValueOnce({
    kind: 'ok',
    value: { name, accessories: [] },
  });

  await userEvent.type(screen.getByTestId('equipment-raw-name-input'), name);
  await userEvent.click(screen.getByRole('button', { name: /identify/i }));

  await waitFor(() => screen.getByTestId('equipment-confirmed-name-input'));
  await userEvent.click(screen.getByTestId('equipment-confirm-name-btn'));

  await waitFor(() => screen.getByTestId('equipment-save-btn'));
}

describe('EquipmentCapturePage', () => {
  it('renders step 1 (raw name entry)', () => {
    render(EquipmentCapturePage);
    expect(screen.getByTestId('equipment-raw-name-input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /identify/i })).toBeInTheDocument();
  });

  it('Save calls captureEquipmentItem exactly once with all draft accessories', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'new-id', manifest: makeManifest() },
    });

    render(EquipmentCapturePage);
    await walkThroughCapture('KitchenAid');

    // Add two manual accessories before saving
    const accInput = screen.getByTestId('equipment-new-accessory-input');
    await userEvent.type(accInput, 'Dough hook');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await userEvent.type(accInput, 'Whisk');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await userEvent.click(screen.getByTestId('equipment-save-btn'));

    await waitFor(() => {
      expect(vi.mocked(captureEquipmentItem)).toHaveBeenCalledTimes(1);
    });
    const [name, accessories] = vi.mocked(captureEquipmentItem).mock.calls[0]!;
    expect(name).toBe('KitchenAid');
    expect(accessories.map((a) => a.name)).toEqual(['Dough hook', 'Whisk']);
  });

  it('on successful save, navigates to the new item by id returned from the service', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'returned-id-xyz', manifest: makeManifest() },
    });

    render(EquipmentCapturePage);
    await walkThroughCapture('Mixer');
    await userEvent.click(screen.getByTestId('equipment-save-btn'));

    await waitFor(() => {
      expect(vi.mocked(push)).toHaveBeenCalledWith('/equipment/returned-id-xyz');
    });
  });

  it('disables Save while the manifest is still loading', async () => {
    mockIsLoadingEquipment._set(true);
    render(EquipmentCapturePage);
    await walkThroughCapture('Mixer');

    const saveBtn = screen.getByTestId('equipment-save-btn');
    expect(saveBtn).toBeDisabled();
  });

  it('on save failure, shows an error toast and does not navigate', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    render(EquipmentCapturePage);
    await walkThroughCapture('Mixer');
    await userEvent.click(screen.getByTestId('equipment-save-btn'));

    await waitFor(() => {
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        expect.stringMatching(/failed/i),
        'destructive',
      );
    });
    expect(vi.mocked(push)).not.toHaveBeenCalledWith(expect.stringContaining('/equipment/'));
  });

  // ─── One trace across both AI calls (issue #361) ────────────────────────────

  it('mints ONE action span and hands the SAME traceparent to both AI calls', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'new-id', manifest: makeManifest() },
    });

    render(EquipmentCapturePage);
    await walkThroughCapture('KitchenAid');

    // Exactly one root span, named for the action (the descriptive trace name).
    expect(mockStartUserActionSpan).toHaveBeenCalledTimes(1);
    expect(mockStartUserActionSpan).toHaveBeenCalledWith('Add equipment: KitchenAid');

    // BOTH callables received the SAME browser-minted traceparent → one trace.
    const idTp = vi.mocked(callIdentifyEquipment).mock.calls[0]![1];
    const popTp = vi.mocked(callPopulateEquipmentEntry).mock.calls[0]![1];
    expect(idTp).toBe(ACTION_TRACEPARENT);
    expect(popTp).toBe(ACTION_TRACEPARENT);
    expect(idTp).toBe(popTp);
  });

  it('closes the action span after a successful save', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'new-id', manifest: makeManifest() },
    });

    render(EquipmentCapturePage);
    await walkThroughCapture('Mixer');
    await userEvent.click(screen.getByTestId('equipment-save-btn'));

    await waitFor(() => expect(mockActionSpan.end).toHaveBeenCalled());
  });
});

// ─── A family of kit (issue #1373) ───────────────────────────────────────────
// Steps 2 and 3 are PRODUCT IDENTIFICATION — which Magimix is this, what ships
// in its box. A family is the household's own list of things it already owns, so
// there is no product to identify: the two AI legs are skipped, not merely
// ignored, and that is what these pin.

describe('EquipmentCapturePage — a family of kit', () => {
  async function startFamily(name: string): Promise<void> {
    const user = userEvent.setup();
    render(EquipmentCapturePage);
    await user.click(screen.getByTestId('equipment-kind-select'));
    await user.click(await screen.findByRole('option', { name: /family of kit/i }));
    await user.type(screen.getByTestId('equipment-raw-name-input'), name);
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => screen.getByTestId('equipment-save-btn'));
  }

  it('goes straight to the list, spending nothing on AI', async () => {
    await startFamily('Frying pans');
    expect(vi.mocked(callIdentifyEquipment)).not.toHaveBeenCalled();
    expect(vi.mocked(callPopulateEquipmentEntry)).not.toHaveBeenCalled();
  });

  it('saves the record as a family, with its entries owned', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'pans-1', manifest: makeManifest() },
    });
    const user = userEvent.setup();
    await startFamily('Frying pans');

    await user.type(screen.getByTestId('equipment-new-accessory-input'), '28cm cast iron');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    await user.click(screen.getByTestId('equipment-save-btn'));

    await waitFor(() => expect(vi.mocked(captureEquipmentItem)).toHaveBeenCalledTimes(1));
    const [name, accessories, kind] = vi.mocked(captureEquipmentItem).mock.calls[0]!;
    expect(name).toBe('Frying pans');
    expect(kind).toBe('family');
    expect(accessories).toEqual([{ name: '28cm cast iron', owned: true, included: false }]);
  });

  it('shows no owned tick for a family entry', async () => {
    const user = userEvent.setup();
    await startFamily('Weck jars');
    await user.type(screen.getByTestId('equipment-new-accessory-input'), '1/2 litre Mold jar');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    await screen.findByTestId('equipment-draft-accessory');
    expect(screen.queryByLabelText('Owned')).toBeNull();
  });

  it('saves an ordinary record as equipment', async () => {
    vi.mocked(captureEquipmentItem).mockResolvedValueOnce({
      kind: 'ok',
      value: { itemId: 'new-id', manifest: makeManifest() },
    });
    render(EquipmentCapturePage);
    await walkThroughCapture('KitchenAid');
    await userEvent.click(screen.getByTestId('equipment-save-btn'));
    await waitFor(() => expect(vi.mocked(captureEquipmentItem)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(captureEquipmentItem).mock.calls[0]![2]).toBe('equipment');
  });
});
