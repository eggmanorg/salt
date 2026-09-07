import { describe, it, expect, vi, beforeEach } from 'vitest';

// The wiring of the nested `batch-images/` pass (issue #968).
//
// sweepOrphanedStorage.test.ts owns the DECISIONS — which keys are live
// (`liveNestedKeys`), which candidates are doomed (`selectOrphanedObjects`),
// how a path becomes a key (`nestedKeyFromObjectPath`) — all pure, no mocks.
// This file owns the part those cannot see: that the pass actually reads the
// three sources it claims to, feeds them into those decisions the right way
// round, and deletes exactly what comes back.
//
// That distinction matters more here than in most places. Every pure guard in
// the sibling file would stay green if the pass passed the parent ids in as the
// live KEYS, or projected the wrong field, or listed the bucket without its
// prefix — and each of those deletes photographs a person took.
//
// Mocking follows setObservationImageUpload.test.ts: `firebase-admin/*` stubbed
// down to the calls actually made, dynamic import after the mocks.

const mockDelete = vi.fn(async () => undefined);
const mockBucketFile = vi.fn((_path: string) => ({ delete: mockDelete }));
const mockGetFiles = vi.fn(async () => [[]] as unknown);

vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({ name: 'demo-salt.appspot.com', getFiles: mockGetFiles, file: mockBucketFile }),
  }),
}));

const mockGroupSelect = vi.fn();
const mockCollectionGroup = vi.fn(() => ({ select: mockGroupSelect }));
const mockCollectionSelect = vi.fn();
const mockCollection = vi.fn(() => ({ select: mockCollectionSelect }));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collectionGroup: mockCollectionGroup, collection: mockCollection }),
}));

const mockInfo = vi.fn();
vi.mock('firebase-functions', () => ({ logger: { info: mockInfo, error: vi.fn() } }));

// Only the four seams this pass actually touches are stubbed. The module's other
// import-time work — `onSchedule`, `defineSecret` — is inert without an emulator
// and needs no mock, which keeps this file inside the unit-test spec's ceiling on
// mocks per file (UT-B1).

const TARGET = {
  prefix: 'batch-images/',
  collectionGroup: 'observations',
  parentCollection: 'batches',
  claimField: 'image',
} as const;

const NOW = Date.UTC(2026, 6, 28);
const OLD = new Date(NOW - 30 * 86_400_000).toISOString();

/** A bucket object, as `getFiles` hands it over. */
interface BucketObject {
  name: string;
  metadata: { timeCreated?: string };
}

function object(path: string, timeCreated = OLD): BucketObject {
  return { name: path, metadata: { timeCreated } };
}

/**
 * An observation document, shaped as the pass reads it: `.id`, the two levels of
 * `.ref.parent.parent` it walks to find the batch, and `.get(field)`.
 */
function observation(batchId: string, id: string, image: unknown) {
  return {
    id,
    ref: { parent: { parent: { id: batchId, parent: { id: 'batches' } } } },
    get: (field: string) => (field === 'image' ? image : undefined),
  };
}

function given({
  objects = [] as BucketObject[],
  observations = [] as ReturnType<typeof observation>[],
  batches = [] as string[],
} = {}) {
  mockGetFiles.mockResolvedValue([objects] as unknown as [][]);
  mockGroupSelect.mockReturnValue({ get: async () => ({ docs: observations }) });
  mockCollectionSelect.mockReturnValue({
    get: async () => ({ docs: batches.map((id) => ({ id })) }),
  });
}

async function run() {
  const { sweepNestedPrefix } = await import('../../src/maintenance/sweepOrphanedStorage.js');
  await sweepNestedPrefix(TARGET, NOW);
}

const deletedPaths = () => mockBucketFile.mock.calls.map(([p]) => p);

describe('sweepNestedPrefix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the photo of an observation that no longer claims one', async () => {
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [observation('b1', 'obs1', null)],
      batches: ['b1'],
    });
    await run();
    expect(deletedPaths()).toEqual(['batch-images/b1/obs1.webp']);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps the photo of an observation that claims one', async () => {
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [
        observation('b1', 'obs1', { url: 'https://example/o/x.webp', source: 'upload' }),
      ],
      batches: ['b1'],
    });
    await run();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes the photo when the parent batch is gone but its observation survives', async () => {
    // A future non-cascading deleteBatch. The observation still claims the photo;
    // the batch it belongs to does not exist.
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [observation('b1', 'obs1', { url: 'u' })],
      batches: [],
    });
    await run();
    expect(deletedPaths()).toEqual(['batch-images/b1/obs1.webp']);
  });

  it('leaves a young orphan alone', async () => {
    given({
      objects: [object('batch-images/b1/obs1.webp', new Date(NOW - 2 * 86_400_000).toISOString())],
      observations: [],
      batches: ['b1'],
    });
    await run();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('leaves an object with an unreadable timeCreated alone rather than guessing its age', async () => {
    given({
      objects: [object('batch-images/b1/obs1.webp', 'not-a-date')],
      observations: [],
      batches: ['b1'],
    });
    await run();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('reads the bucket under the prefix, the right collection group, and the right parent collection', async () => {
    // Each of these being wrong is silent: an unprefixed listing sweeps other
    // families' icons, the wrong group or field makes every key look unclaimed.
    given({ objects: [], observations: [], batches: [] });
    await run();
    expect(mockGetFiles).toHaveBeenCalledWith({ prefix: 'batch-images/' });
    expect(mockCollectionGroup).toHaveBeenCalledWith('observations');
    expect(mockGroupSelect).toHaveBeenCalledWith('image');
    expect(mockCollection).toHaveBeenCalledWith('batches');
    expect(mockCollectionSelect).toHaveBeenCalledWith();
  });

  it('ignores a same-named collection group under a different root', async () => {
    const foreign = observation('b1', 'obs1', { url: 'u' });
    foreign.ref.parent.parent.parent.id = 'ferments';
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [foreign],
      batches: ['b1'],
    });
    await run();
    expect(deletedPaths()).toEqual(['batch-images/b1/obs1.webp']);
  });

  it('skips a nested-looking object of the wrong depth rather than keying it wrong', async () => {
    given({
      objects: [object('batch-images/obs1.webp'), object('batch-images/b1/x/obs1.webp')],
      observations: [],
      batches: [],
    });
    await run();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('leaves an object with no timeCreated at all alone', async () => {
    // No `timeCreated` key at all, as distinct from an unparseable one. An
    // object whose age is unknown is left alone rather than guessed at.
    given({
      objects: [{ name: 'batch-images/b1/obs1.webp', metadata: {} }],
      observations: [],
      batches: ['b1'],
    });
    await run();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('ignores a leaf document that is not nested under anything', async () => {
    // `ref.parent.parent` is null for a top-level document. It cannot vouch for a
    // nested object, so it contributes no key and the object is swept.
    const orphanLeaf = observation('b1', 'obs1', { url: 'u' }) as unknown as {
      ref: { parent: { parent: null } };
    };
    orphanLeaf.ref.parent.parent = null;
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [orphanLeaf as unknown as ReturnType<typeof observation>],
      batches: ['b1'],
    });
    await run();
    expect(deletedPaths()).toEqual(['batch-images/b1/obs1.webp']);
  });

  it('logs the pass with the prefix and the counts', async () => {
    given({
      objects: [object('batch-images/b1/obs1.webp')],
      observations: [observation('b1', 'obs1', null)],
      batches: ['b1'],
    });
    await run();
    expect(mockInfo).toHaveBeenCalledWith(
      'sweepOrphanedStorage: swept prefix',
      expect.objectContaining({ prefix: 'batch-images/', objects: 1, deleted: 1, capped: false }),
    );
  });
});
