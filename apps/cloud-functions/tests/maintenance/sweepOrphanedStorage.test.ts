import { describe, it, expect } from 'vitest';

import {
  selectOrphanedObjects,
  idFromObjectPath,
  nestedKeyFromObjectPath,
  liveNestedKeys,
  embeddingCandidate,
  type SweepCandidate,
  type NestedLeaf,
} from '../../src/maintenance/sweepOrphanedStorage.js';

const NOW = Date.UTC(2026, 6, 28);
const DAY = 86_400_000;

function candidate(id: string, ageDays: number): SweepCandidate {
  return { path: `canon-icons/${id}.webp`, id, createdAt: NOW - ageDays * DAY };
}

describe('idFromObjectPath', () => {
  it('extracts the doc id from a prefixed object path', () => {
    expect(idFromObjectPath('canon-icons/abc123.webp', 'canon-icons/')).toBe('abc123');
    expect(idFromObjectPath('recipe-images/r-1.webp', 'recipe-images/')).toBe('r-1');
  });

  it('keeps dots inside the id, splitting only on the extension', () => {
    expect(idFromObjectPath('canon-icons/a.b.c.webp', 'canon-icons/')).toBe('a.b.c');
  });

  it('handles an extensionless object', () => {
    expect(idFromObjectPath('canon-icons/abc123', 'canon-icons/')).toBe('abc123');
  });

  it('rejects anything not directly under the prefix', () => {
    expect(idFromObjectPath('other/abc.webp', 'canon-icons/')).toBeNull();
    expect(idFromObjectPath('canon-icons/nested/abc.webp', 'canon-icons/')).toBeNull();
  });

  it('rejects the bare prefix and a bare extension', () => {
    expect(idFromObjectPath('canon-icons/', 'canon-icons/')).toBeNull();
    expect(idFromObjectPath('canon-icons/.webp', 'canon-icons/')).toBeNull();
  });
});

describe('selectOrphanedObjects', () => {
  it('selects an aged object whose doc is gone', () => {
    const orphan = candidate('gone', 30);
    expect(selectOrphanedObjects({ candidates: [orphan], liveIds: new Set(), now: NOW })).toEqual([
      orphan,
    ]);
  });

  it('never selects an object whose doc still exists, however old', () => {
    expect(
      selectOrphanedObjects({
        candidates: [candidate('live', 3650)],
        liveIds: new Set(['live']),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('spares an orphan younger than the grace period', () => {
    expect(
      selectOrphanedObjects({
        candidates: [candidate('fresh', 6)],
        liveIds: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('selects an orphan exactly at the grace boundary', () => {
    expect(
      selectOrphanedObjects({
        candidates: [candidate('sevenDays', 7)],
        liveIds: new Set(),
        now: NOW,
      }),
    ).toHaveLength(1);
  });

  it('spares an orphan with a future timestamp rather than treating it as ancient', () => {
    expect(
      selectOrphanedObjects({
        candidates: [candidate('skewed', -5)],
        liveIds: new Set(),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('caps deletions per run', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`orphan-${i}`, 30));
    expect(
      selectOrphanedObjects({ candidates: many, liveIds: new Set(), now: NOW, limit: 5 }),
    ).toHaveLength(5);
  });

  it('separates live, fresh and doomed in one mixed pass', () => {
    const doomed = candidate('doomed', 30);
    const result = selectOrphanedObjects({
      candidates: [candidate('live', 30), candidate('fresh', 1), doomed],
      liveIds: new Set(['live']),
      now: NOW,
    });
    expect(result).toEqual([doomed]);
  });

  it('is a no-op on an empty bucket', () => {
    expect(selectOrphanedObjects({ candidates: [], liveIds: new Set(['a']), now: NOW })).toEqual(
      [],
    );
  });
});

describe('embeddingCandidate', () => {
  it('reads the age off an ISO updatedAt', () => {
    expect(embeddingCandidate('c1', '2026-07-01T12:00:00.000Z')).toEqual({
      path: 'canonEmbeddings/c1',
      id: 'c1',
      createdAt: Date.parse('2026-07-01T12:00:00.000Z'),
    });
  });

  // `updatedAt` is optional on CanonEmbeddingSchema, so an undated row is a
  // legitimate state. Unknown age must read as "leave alone", never as "ancient".
  it('declines a doc with no usable updatedAt rather than dating it', () => {
    expect(embeddingCandidate('c1', undefined)).toBeNull();
    expect(embeddingCandidate('c1', '')).toBeNull();
    expect(embeddingCandidate('c1', 'not a date')).toBeNull();
    expect(embeddingCandidate('c1', 1_780_000_000_000)).toBeNull();
  });
});

// The vectors go through the very same selection as the Storage objects — these
// cases exist to pin the join end to end, from a raw `updatedAt` string to a
// delete decision, not to re-test the pure selector.
describe('selectOrphanedObjects — canonEmbeddings pass', () => {
  function vector(id: string, ageDays: number): SweepCandidate {
    const candidate = embeddingCandidate(id, new Date(NOW - ageDays * DAY).toISOString());
    if (candidate === null) throw new Error('fixture produced an undated candidate');
    return candidate;
  }

  it('deletes a vector whose canon item is gone and is past the grace', () => {
    const orphan = vector('split-away', 30);
    expect(selectOrphanedObjects({ candidates: [orphan], liveIds: new Set(), now: NOW })).toEqual([
      orphan,
    ]);
  });

  it('spares an orphaned vector still inside the grace', () => {
    expect(
      selectOrphanedObjects({ candidates: [vector('fresh', 6)], liveIds: new Set(), now: NOW }),
    ).toEqual([]);
  });

  it('never touches a vector whose canon item is live', () => {
    expect(
      selectOrphanedObjects({
        candidates: [vector('live', 400)],
        liveIds: new Set(['live']),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('caps a run, so a wrong join costs at most `limit` embeddings', () => {
    const many = Array.from({ length: 20 }, (_, i) => vector(`orphan-${i}`, 30));
    expect(
      selectOrphanedObjects({ candidates: many, liveIds: new Set(), now: NOW, limit: 5 }),
    ).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The nested `batch-images/` pass (issue #968).
//
// Two-segment objects — `batch-images/{batchId}/{observationId}.webp` — whose
// orphan-ness is a three-way join rather than a doc-id lookup. Pure selection
// throughout, no emulator, matching the passes above.
// ---------------------------------------------------------------------------

const PREFIX = 'batch-images/';

describe('nestedKeyFromObjectPath', () => {
  it('pairs the two segments, dropping the extension', () => {
    expect(nestedKeyFromObjectPath('batch-images/b1/obs1.webp', PREFIX)).toBe('b1/obs1');
  });

  it('keeps an extensionless leaf whole', () => {
    expect(nestedKeyFromObjectPath('batch-images/b1/obs1', PREFIX)).toBe('b1/obs1');
  });

  it('splits on the LAST dot, so a dotted id survives', () => {
    expect(nestedKeyFromObjectPath('batch-images/b1/a.b.c.webp', PREFIX)).toBe('b1/a.b.c');
  });

  it('returns null for a single segment', () => {
    // The flat shape fed to the nested join. A key of the wrong shape matches no
    // document, and a key nothing matches is a deletion.
    expect(nestedKeyFromObjectPath('batch-images/obs1.webp', PREFIX)).toBeNull();
  });

  it('returns null for three or more segments', () => {
    expect(nestedKeyFromObjectPath('batch-images/b1/x/obs1.webp', PREFIX)).toBeNull();
  });

  it('returns null when either half is empty', () => {
    expect(nestedKeyFromObjectPath('batch-images//obs1.webp', PREFIX)).toBeNull();
    expect(nestedKeyFromObjectPath('batch-images/b1/', PREFIX)).toBeNull();
    expect(nestedKeyFromObjectPath('batch-images/b1/.webp', PREFIX)).toBeNull();
  });

  it('returns null for another prefix', () => {
    expect(nestedKeyFromObjectPath('canon-icons/b1/obs1.webp', PREFIX)).toBeNull();
  });

  it('is the twin of idFromObjectPath, not a widening of it', () => {
    // Neither function may drift into accepting the other's shape: each produces
    // a key for a different join, and a key handed to the wrong join is unmatched.
    expect(idFromObjectPath('batch-images/b1/obs1.webp', PREFIX)).toBeNull();
    expect(nestedKeyFromObjectPath('canon-icons/abc.webp', 'canon-icons/')).toBeNull();
  });
});

describe('liveNestedKeys', () => {
  const leaf = (over: Partial<NestedLeaf> = {}): NestedLeaf => ({
    id: 'obs1',
    parentId: 'b1',
    parentCollection: 'batches',
    claim: { url: 'https://example/o/x.webp', source: 'upload' },
    ...over,
  });
  const join = (leaves: NestedLeaf[], parents = ['b1']) =>
    liveNestedKeys({
      leaves,
      liveParentIds: new Set(parents),
      parentCollection: 'batches',
    });

  it('claims the key when the leaf, its parent and its claim field are all there', () => {
    expect([...join([leaf()])]).toEqual(['b1/obs1']);
  });

  it('releases the key when the claim field is null', () => {
    // THE ORPHAN REACHABLE TODAY. setObservationImageUpload saves the object and
    // THEN stamps the URL; a failed stamp leaves a live observation with
    // `image: null` beside an object nothing references.
    expect([...join([leaf({ claim: null })])]).toEqual([]);
  });

  it('releases the key when the claim field is absent entirely', () => {
    expect([...join([leaf({ claim: undefined })])]).toEqual([]);
  });

  it('releases the key when the parent document is gone', () => {
    // Deleting a Firestore doc does not delete its subcollection, so a future
    // non-cascading deleteBatch strands live-looking observations. Their photos
    // are still freed.
    expect([...join([leaf()], [])]).toEqual([]);
  });

  it('releases the key when the leaf is not nested at all', () => {
    expect([...join([leaf({ parentId: null, parentCollection: null })])]).toEqual([]);
  });

  it('ignores a same-named collection group under a different root', () => {
    // A collection group matches the NAME anywhere in the tree. Another root's
    // `observations` must not vouch for an object in this bucket.
    expect([...join([leaf({ parentCollection: 'ferments' })])]).toEqual([]);
  });

  it.each([
    ['an empty object', {}],
    ['a bare string', 'https://example/o/x.webp'],
    ['a number', 0],
    ['an empty string', ''],
    ['false', false],
  ])('keeps the object when the claim field is malformed: %s', (_label, claim) => {
    // PRESENCE, NOT VALIDITY. A field we cannot parse is a document we do not
    // understand, and the safe reading of that is "claimed" — these are
    // photographs a person took. Parsing here would turn a schema bug into
    // photo loss.
    expect([...join([leaf({ claim })])]).toEqual(['b1/obs1']);
  });

  it('keys by the PAIR, so two batches may hold the same observation id', () => {
    const keys = join([leaf(), leaf({ parentId: 'b2' })], ['b1', 'b2']);
    expect([...keys].sort()).toEqual(['b1/obs1', 'b2/obs1']);
  });
});

describe('selectOrphanedObjects — batch-images pass', () => {
  const object = (key: string, ageDays: number): SweepCandidate => ({
    path: `${PREFIX}${key}.webp`,
    id: key,
    createdAt: NOW - ageDays * 86_400_000,
  });

  it('deletes the photo of an observation that no longer claims one', () => {
    const live = liveNestedKeys({
      leaves: [{ id: 'obs1', parentId: 'b1', parentCollection: 'batches', claim: null }],
      liveParentIds: new Set(['b1']),
      parentCollection: 'batches',
    });
    expect(
      selectOrphanedObjects({ candidates: [object('b1/obs1', 30)], liveIds: live, now: NOW }),
    ).toEqual([object('b1/obs1', 30)]);
  });

  it('keeps the photo of an observation that claims one', () => {
    const live = liveNestedKeys({
      leaves: [{ id: 'obs1', parentId: 'b1', parentCollection: 'batches', claim: { url: 'u' } }],
      liveParentIds: new Set(['b1']),
      parentCollection: 'batches',
    });
    expect(
      selectOrphanedObjects({ candidates: [object('b1/obs1', 30)], liveIds: live, now: NOW }),
    ).toEqual([]);
  });

  it('leaves a young orphan alone — the shared seven-day grace applies here too', () => {
    // The upload writes the object and stamps the document a moment later; the
    // grace is what stops the sweep racing that window.
    expect(
      selectOrphanedObjects({ candidates: [object('b1/obs1', 3)], liveIds: new Set(), now: NOW }),
    ).toEqual([]);
  });

  it('applies the shared cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => object(`b1/obs${i}`, 30));
    expect(
      selectOrphanedObjects({ candidates: many, liveIds: new Set(), now: NOW, limit: 5 }),
    ).toHaveLength(5);
  });
});
