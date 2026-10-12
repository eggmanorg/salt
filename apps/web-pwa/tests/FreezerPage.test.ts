import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { ErrorCode, failure, success } from '@salt/shared-types';
import type { FreezerConfig } from '@salt/domain';
import type { FreezerConfigState } from '../src/lib/freezerService.js';

// The freezer page and its setup sheet (issue #1682) — `/freezer`.
//
// The page shows the places before anything goes in them: each freezer and its
// shelves, all empty. The sheet is where they are set up, and every refusal it
// shows comes from the service's result — so these cases drive the sheet and
// assert which command it called with what, and what it says when refused.

const { mockState, mockInit, mockAdd, mockRename, mockSetShelves, mockRemove, mockGate } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockState: makeStore<FreezerConfigState>({ status: 'loading' }),
      mockInit: vi.fn(() => () => {}),
      mockAdd: vi.fn(),
      mockRename: vi.fn(),
      mockSetShelves: vi.fn(),
      mockRemove: vi.fn(),
      mockGate: makeStore<{ enabled: boolean; settled: boolean }>({
        enabled: true,
        settled: true,
      }),
    };
  });

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/freezerService.js', () => ({
  freezerConfigState: mockState,
  initFreezerSync: mockInit,
  addFreezer: mockAdd,
  renameFreezer: mockRename,
  setFreezerShelves: mockSetShelves,
  removeFreezer: mockRemove,
}));
vi.mock('../src/lib/featureGate.js', () => ({
  freezerGate: mockGate,
  featureGate: () => mockGate,
  isFeatureEnabled: () => true,
}));

import { push } from 'svelte-spa-router';
import FreezerPage from '../src/routes/freezer/FreezerPage.svelte';

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B', 'C', 'D'] };
const KITCHEN = { id: 'fz-kitchen', name: 'Kitchen', shelves: [] };

function loaded(freezers: FreezerConfig['freezers']): FreezerConfigState {
  return {
    status: 'loaded',
    config: { schemaVersion: 1, updatedAt: '2026-10-12T09:00:00.000Z', freezers },
  };
}

const OK = success(loaded([]));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.set({ status: 'loading' });
  mockGate.set({ enabled: true, settled: true });
  for (const fn of [mockAdd, mockRename, mockSetShelves, mockRemove]) fn.mockResolvedValue(OK);
});

async function openSheet(testId: string): Promise<HTMLElement> {
  await fireEvent.click(await screen.findByTestId(testId));
  return screen.findByRole('dialog');
}

describe('FreezerPage', () => {
  it('owns the subscription', () => {
    render(FreezerPage);
    expect(mockInit).toHaveBeenCalledOnce();
  });

  it('says nothing is set up when the document is absent, and offers setup', async () => {
    mockState.set({ status: 'loaded', config: null });
    render(FreezerPage);

    expect(await screen.findByTestId('freezer-empty')).toHaveTextContent('No freezers set up yet.');
    const sheet = await openSheet('freezer-setup');
    expect(within(sheet).getByText('Manage freezers')).toBeInTheDocument();
  });

  it('treats a config with no freezers the same as no config', async () => {
    mockState.set(loaded([]));
    render(FreezerPage);
    expect(await screen.findByTestId('freezer-empty')).toBeInTheDocument();
  });

  it('shows each freezer with its shelves, all empty, and says the freezer is empty', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    render(FreezerPage);

    const cards = await screen.findAllByTestId('freezer-card');
    expect(cards.map((c) => within(c).getByTestId('freezer-card-name').textContent)).toEqual([
      'Garage',
      'Kitchen',
    ]);
    const shelves = within(cards[0] as HTMLElement).getAllByTestId('freezer-shelf');
    expect(shelves.map((s) => s.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Shelf A Empty',
      'Shelf B Empty',
      'Shelf C Empty',
      'Shelf D Empty',
    ]);
    expect(within(cards[1] as HTMLElement).getByText('No shelves.')).toBeInTheDocument();
    expect(screen.getByTestId('freezer-contents-empty')).toHaveTextContent(
      'Nothing in the freezer yet.',
    );
  });

  it('says so when the freezers could not be loaded', async () => {
    mockState.set({ status: 'failed' });
    render(FreezerPage);
    expect(await screen.findByTestId('freezer-error')).toBeInTheDocument();
    expect(screen.queryByTestId('freezer-empty')).not.toBeInTheDocument();
  });

  it('renders nothing and goes home when the freezer flag is off', async () => {
    mockGate.set({ enabled: false, settled: true });
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(screen.queryByTestId('freezer-page')).not.toBeInTheDocument();
  });
});

describe('ManageFreezersSheet', () => {
  it('adds a freezer by name', async () => {
    mockState.set({ status: 'loaded', config: null });
    render(FreezerPage);
    const sheet = await openSheet('freezer-setup');

    const input = within(sheet).getByTestId('manage-new-freezer-name');
    await fireEvent.input(input, { target: { value: 'Garage' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('Garage'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('shows the refusal for a blank or duplicate name, and keeps what was typed', async () => {
    mockState.set(loaded([GARAGE]));
    mockAdd.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_FREEZER_NAME }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    const input = within(sheet).getByTestId('manage-new-freezer-name');
    await fireEvent.input(input, { target: { value: 'garage' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));

    expect(await within(sheet).findByTestId('manage-new-freezer-error')).toHaveTextContent(
      'There is already a freezer with that name.',
    );
    expect((input as HTMLInputElement).value).toBe('garage');

    mockAdd.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_NAME }),
    );
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));
    await waitFor(() =>
      expect(within(sheet).getByTestId('manage-new-freezer-error')).toHaveTextContent(
        'Give the freezer a name.',
      ),
    );
  });

  it('renames a freezer by its id once the name is changed', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    expect(within(sheet).queryByTestId('manage-freezer-rename')).not.toBeInTheDocument();
    await fireEvent.input(within(sheet).getByTestId('manage-freezer-name'), {
      target: { value: 'Shed' },
    });
    await fireEvent.click(await within(sheet).findByTestId('manage-freezer-rename'));

    await waitFor(() => expect(mockRename).toHaveBeenCalledWith('fz-garage', 'Shed'));
  });

  it('adds a shelf to the end of the freezer’s list', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.input(within(sheet).getByTestId('manage-shelf-input'), {
      target: { value: 'E' },
    });
    await fireEvent.click(within(sheet).getByTestId('manage-shelf-add'));

    await waitFor(() =>
      expect(mockSetShelves).toHaveBeenCalledWith('fz-garage', ['A', 'B', 'C', 'D', 'E']),
    );
  });

  it('shows the refusal for a repeated shelf label', async () => {
    mockState.set(loaded([GARAGE]));
    mockSetShelves.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_SHELF_LABEL }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.input(within(sheet).getByTestId('manage-shelf-input'), {
      target: { value: 'a' },
    });
    await fireEvent.click(within(sheet).getByTestId('manage-shelf-add'));

    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      'This freezer already has a shelf with that label.',
    );
  });

  it('removes a shelf, leaving the rest in order', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove shelf B' }));

    await waitFor(() => expect(mockSetShelves).toHaveBeenCalledWith('fz-garage', ['A', 'C', 'D']));
  });

  it('removes a freezer', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Garage' }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('fz-garage'));
  });
});
