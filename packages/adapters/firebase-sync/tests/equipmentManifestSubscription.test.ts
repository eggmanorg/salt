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

import {
  subscribeEquipmentManifest,
  saveEquipmentManifest,
} from '../src/equipmentManifestSubscription.js';

type SnapCallback = (snap: { exists: () => boolean; data: () => unknown }) => void;
type ErrorCallback = (err: Error & { code?: string }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  mockSetDoc.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { onLine: true });
});

describe('subscribeEquipmentManifest', () => {
  it('targets equipmentManifest/current', () => {
    subscribeEquipmentManifest(
      () => {},
      () => {},
    );
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'equipmentManifest', 'current');
  });

  it('returns the unsubscribe function from onSnapshot', () => {
    const unsub = subscribeEquipmentManifest(
      () => {},
      () => {},
    );
    expect(unsub).toBe(mockUnsubscribe);
  });

  it('calls onManifest(null) when document does not exist', () => {
    const onManifest = vi.fn();
    subscribeEquipmentManifest(onManifest, () => {});

    const snapCb = mockOnSnapshot.mock.calls[0]![1] as SnapCallback;
    snapCb({ exists: () => false, data: () => undefined });

    expect(onManifest).toHaveBeenCalledWith(null);
  });

  it('calls onManifest with mapped manifest when document exists', () => {
    const onManifest = vi.fn();
    subscribeEquipmentManifest(onManifest, () => {});

    const snapCb = mockOnSnapshot.mock.calls[0]![1] as SnapCallback;
    snapCb({
      exists: () => true,
      data: () => ({
        schemaVersion: 1,
        updatedAt: '2026-05-13T10:00:00.000Z',
        items: [
          {
            id: 'item-1',
            schemaVersion: 1,
            name: 'Stand Mixer',
            accessories: [{ id: 'acc-1', name: 'Dough Hook', owned: true, included: true }],
            rules: ['Use speed 2 for bread dough'],
            updatedAt: '2026-05-13T10:00:00.000Z',
          },
        ],
      }),
    });

    expect(onManifest).toHaveBeenCalledWith({
      schemaVersion: 1,
      updatedAt: '2026-05-13T10:00:00.000Z',
      items: [
        {
          id: 'item-1',
          schemaVersion: 1,
          name: 'Stand Mixer',
          accessories: [{ id: 'acc-1', name: 'Dough Hook', owned: true, included: true }],
          rules: ['Use speed 2 for bread dough'],
          // The snapshot above carries no `environment` key — every equipment
          // document in production was written before places existed (#1281) —
          // and the schema's `.default(null)` is what lands it here.
          environment: null,
          updatedAt: '2026-05-13T10:00:00.000Z',
        },
      ],
    });
  });

  it('normalises missing items to empty array', () => {
    const onManifest = vi.fn();
    subscribeEquipmentManifest(onManifest, () => {});

    const snapCb = mockOnSnapshot.mock.calls[0]![1] as SnapCallback;
    snapCb({ exists: () => true, data: () => ({ schemaVersion: 1, updatedAt: '' }) });

    expect(onManifest).toHaveBeenCalledWith({ schemaVersion: 1, updatedAt: '', items: [] });
  });

  it('normalises missing accessories and rules to empty arrays', () => {
    const onManifest = vi.fn();
    subscribeEquipmentManifest(onManifest, () => {});

    const snapCb = mockOnSnapshot.mock.calls[0]![1] as SnapCallback;
    snapCb({
      exists: () => true,
      data: () => ({
        schemaVersion: 1,
        updatedAt: '2026-05-13T10:00:00.000Z',
        items: [
          { id: 'x', schemaVersion: 1, name: 'Kettle', updatedAt: '2026-05-13T10:00:00.000Z' },
        ],
      }),
    });

    const manifest = onManifest.mock.calls[0]![0];
    expect(manifest.items[0].accessories).toEqual([]);
    expect(manifest.items[0].rules).toEqual([]);
  });

  // Both stream rows assert the RAW error alongside the classified one. This
  // subscription's `onError` took a single argument until #928 Phase 1 deleted
  // `forwardsRawError`; the second argument is the stack a reporting call site
  // sends to PostHog, so a regression to one argument must go red here.
  it('calls onError with classified DomainError on Firestore permission-denied', () => {
    const onError = vi.fn();
    subscribeEquipmentManifest(() => {}, onError);

    const raw = Object.assign(new Error('Firestore error'), { code: 'permission-denied' });
    const errCb = mockOnSnapshot.mock.calls[0]![2] as ErrorCallback;
    errCb(raw);

    expect(onError).toHaveBeenCalledWith({ kind: 'AuthError', reason: 'forbidden' }, raw);
  });

  it('calls onError with classified DomainError on Firestore unauthenticated', () => {
    const onError = vi.fn();
    subscribeEquipmentManifest(() => {}, onError);

    const raw = Object.assign(new Error('Firestore error'), { code: 'unauthenticated' });
    const errCb = mockOnSnapshot.mock.calls[0]![2] as ErrorCallback;
    errCb(raw);

    expect(onError).toHaveBeenCalledWith({ kind: 'AuthError', reason: 'unauthenticated' }, raw);
  });
});

describe('saveEquipmentManifest', () => {
  it('targets equipmentManifest/current', async () => {
    await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [] });
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'equipmentManifest', 'current');
  });

  it('writes schemaVersion 1', async () => {
    await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [] });
    const written = mockSetDoc.mock.calls[0]![1] as { schemaVersion: number };
    expect(written.schemaVersion).toBe(1);
  });

  it('stamps a fresh updatedAt, discarding the manifest value', async () => {
    const before = Date.now();
    await saveEquipmentManifest({
      schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
      items: [],
    });
    const after = Date.now();

    const written = mockSetDoc.mock.calls[0]![1] as { updatedAt: string };
    const ts = new Date(written.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('spreads items array into the written document', async () => {
    const item = {
      id: 'item-1',
      schemaVersion: 1 as const,
      name: 'Stand Mixer',
      accessories: [{ id: 'acc-1', name: 'Dough Hook', owned: true, included: true }],
      rules: ['Use speed 2'],
      environment: null,
      updatedAt: '2026-05-13T10:00:00.000Z',
    };
    await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [item] });

    const written = mockSetDoc.mock.calls[0]![1] as { items: unknown[] };
    expect(written.items).toHaveLength(1);
    expect(written.items[0]).toEqual(item);
  });

  it('writes an empty items array when manifest has no items', async () => {
    await saveEquipmentManifest({ schemaVersion: 1, updatedAt: '', items: [] });
    const written = mockSetDoc.mock.calls[0]![1] as { items: unknown[] };
    expect(written.items).toEqual([]);
  });
});
