import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCode, failure, success } from '@salt/shared-types';
import type { FreezerConfig } from '@salt/domain';

// The freezer service (issue #1682) — the store over `freezerConfig/current` and
// the one write path for it.
//
// What is worth pinning is WHEN it will write. The document is the whole
// household's setup, written whole; a write issued before the first snapshot, or
// after the listener has died, would replace a real setup with whatever this
// device happens to hold.

const { mockSubscribe, mockSave, mockReport } = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockSave: vi.fn(),
  mockReport: vi.fn(),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeFreezerConfig: mockSubscribe,
  saveFreezerConfig: mockSave,
  isAuthTransitioning: () => false,
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: mockReport }),
}));

import { get } from 'svelte/store';
import {
  addFreezer,
  freezerConfigState,
  initFreezerSync,
  removeFreezer,
  renameFreezer,
  setFreezerShelves,
} from '../src/lib/freezerService.js';

type OnConfig = (config: FreezerConfig | null) => void;
type OnError = (err: unknown, raw?: unknown) => void;

let emit: OnConfig;
let fail: OnError;

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] };

function config(freezers: FreezerConfig['freezers']): FreezerConfig {
  return { schemaVersion: 1, updatedAt: '2026-10-12T09:00:00.000Z', freezers };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue(success(undefined));
  mockSubscribe.mockImplementation((onConfig: OnConfig, onError: OnError) => {
    emit = onConfig;
    fail = onError;
    return () => {};
  });
  initFreezerSync();
});

describe('freezer service — the state it may write from', () => {
  it('is loading until the first snapshot, and writes nothing then', async () => {
    expect(get(freezerConfigState)).toEqual({ status: 'loading' });

    const result = await addFreezer('Garage');

    expect(result).toEqual(failure({ kind: 'NetworkError', reason: 'transient' }));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('starts from an empty config when the document is absent', async () => {
    emit(null);
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: null });

    const result = await addFreezer(' Garage ', ['A', 'B']);

    expect(result.kind).toBe('ok');
    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toHaveLength(1);
    expect(saved.freezers[0]).toMatchObject({ name: 'Garage', shelves: ['A', 'B'] });
    // Minted, opaque — not the name.
    expect(saved.freezers[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: saved });
  });

  it('refuses to write once the listener has failed, and reports the failure', async () => {
    emit(config([GARAGE]));
    fail({ kind: 'StorageError', reason: 'corruption' });

    expect(get(freezerConfigState)).toEqual({ status: 'failed' });
    expect(mockReport).toHaveBeenCalledOnce();

    const result = await removeFreezer(GARAGE.id);

    expect(result.kind).toBe('err');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('freezer service — writes', () => {
  beforeEach(() => emit(config([GARAGE])));

  it('saves nothing and leaves the store alone when the domain refuses', async () => {
    const result = await addFreezer('garage');

    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_FREEZER_NAME }),
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: config([GARAGE]) });
  });

  it('renames in place, keeping the id', async () => {
    await renameFreezer(GARAGE.id, 'Shed');

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toEqual([{ ...GARAGE, name: 'Shed' }]);
  });

  it('replaces the shelf list', async () => {
    await setFreezerShelves(GARAGE.id, ['A', 'B', 'C']);

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers[0]?.shelves).toEqual(['A', 'B', 'C']);
  });

  it('removes a freezer', async () => {
    await removeFreezer(GARAGE.id);

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toEqual([]);
  });

  it('passes a refused save back to the caller and reports it', async () => {
    mockSave.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));

    const result = await renameFreezer(GARAGE.id, 'Shed');

    expect(result).toEqual(failure({ kind: 'StorageError', reason: 'unavailable' }));
    expect(mockReport).toHaveBeenCalledOnce();
  });
});
