import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockSetDoc, mockDoc, mockGetFirestore } = vi.hoisted(
  () => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockSetDoc: vi.fn(),
    mockDoc: vi.fn(() => 'mock-doc-ref'),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }),
);

vi.mock('firebase/app', () => ({
  getApp: vi.fn(() => ({})),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  setDoc: mockSetDoc,
}));

import { subscribeFreezerConfig, saveFreezerConfig } from '../src/freezerConfigSubscription.js';

type SnapCallback = (snap: { id: string; exists: () => boolean; data: () => unknown }) => void;
type ErrorCallback = (err: Error & { code?: string }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  mockSetDoc.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { onLine: true });
});

function snapshotCallback(): SnapCallback {
  return mockOnSnapshot.mock.calls[0]![1] as SnapCallback;
}

describe('subscribeFreezerConfig', () => {
  it('targets freezerConfig/current and returns the listener unsubscribe', () => {
    const unsub = subscribeFreezerConfig(
      () => {},
      () => {},
    );
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'freezerConfig', 'current');
    expect(unsub).toBe(mockUnsubscribe);
  });

  it('delivers null when nobody has set up a freezer yet', () => {
    const onConfig = vi.fn();
    subscribeFreezerConfig(onConfig, () => {});

    snapshotCallback()({ id: 'current', exists: () => false, data: () => undefined });

    expect(onConfig).toHaveBeenCalledWith(null);
  });

  it('delivers the parsed config, defaulting no shelves and no suppliers to [] and no mark to 0', () => {
    const onConfig = vi.fn();
    subscribeFreezerConfig(onConfig, () => {});

    snapshotCallback()({
      id: 'current',
      exists: () => true,
      data: () => ({
        schemaVersion: 1,
        updatedAt: '2026-10-12T10:00:00.000Z',
        freezers: [
          { id: 'fz-1', name: 'Garage', shelves: ['A', 'B'] },
          { id: 'fz-2', name: 'Kitchen' },
        ],
      }),
    });

    expect(onConfig).toHaveBeenCalledWith({
      schemaVersion: 1,
      updatedAt: '2026-10-12T10:00:00.000Z',
      freezers: [
        { id: 'fz-1', name: 'Garage', shelves: ['A', 'B'] },
        { id: 'fz-2', name: 'Kitchen', shelves: [] },
      ],
      // Written before #1684 added the supplier list.
      suppliers: [],
      // Written before #1693 added the bag-number mark: the items set the count.
      highestNumber: 0,
    });
  });

  it('reports a document the schema refuses as corruption, never as null', () => {
    const onConfig = vi.fn();
    const onError = vi.fn();
    subscribeFreezerConfig(onConfig, onError);

    snapshotCallback()({
      id: 'current',
      exists: () => true,
      data: () => ({ schemaVersion: 2, updatedAt: '', freezers: [] }),
    });

    expect(onConfig).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ kind: 'StorageError', reason: 'corruption' });
  });

  it('forwards a stream error classified, with the raw error beside it', () => {
    const onError = vi.fn();
    subscribeFreezerConfig(() => {}, onError);

    const raw = Object.assign(new Error('Firestore error'), { code: 'permission-denied' });
    const errCb = mockOnSnapshot.mock.calls[0]![2] as ErrorCallback;
    errCb(raw);

    expect(onError).toHaveBeenCalledWith({ kind: 'AuthError', reason: 'forbidden' }, raw);
  });
});

describe('saveFreezerConfig', () => {
  it('stamps a fresh updatedAt over the config value', async () => {
    const before = Date.now();
    await saveFreezerConfig({
      schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
      freezers: [],
      suppliers: [],
      highestNumber: 0,
    });
    const after = Date.now();

    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'freezerConfig', 'current');
    const written = mockSetDoc.mock.calls[0]![1] as { updatedAt: string };
    const ts = new Date(written.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // The payload lists its fields by hand: a schema field missed there is dropped
  // on every save — for `highestNumber`, every freezer, shelf or supplier edit
  // would put the bag-number count back to the items' highest (issue #1693).
  it('writes every field of the config, the bag-number mark included', async () => {
    const config = {
      schemaVersion: 1 as const,
      updatedAt: '1970-01-01T00:00:00.000Z',
      freezers: [{ id: 'fz-1', name: 'Garage', shelves: ['A'] }],
      suppliers: ['Swaledale'],
      highestNumber: 120,
    };
    await saveFreezerConfig(config);

    const written = mockSetDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect({ ...written, updatedAt: config.updatedAt }).toEqual(config);
  });
});
