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

  it('delivers the parsed config, defaulting a freezer with no shelves to []', () => {
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
    });
    const after = Date.now();

    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'freezerConfig', 'current');
    const written = mockSetDoc.mock.calls[0]![1] as { updatedAt: string };
    const ts = new Date(written.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
