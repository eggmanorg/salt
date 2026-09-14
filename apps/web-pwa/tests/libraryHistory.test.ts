import { describe, it, expect, beforeEach, vi } from 'vitest';
import { success } from '@salt/shared-types';
import {
  LIBRARY_PAGE_REVISION_CAP,
  type LibraryPageDoc,
  type LibraryPageRevisionDoc,
} from '@salt/domain/schemas';

// Restoring a previous version of a library page (issue #1375, Phase 1).
//
// THE property every assertion here circles: a restore is an ordinary edit, so
// the version it replaces has to be captured like any other. The way this feature
// fails is silent and total — a restore that wrote straight through
// `queueLibraryEdit` would look right on screen and would have thrown away the
// text it overwrote, so a mistaken restore would be final. That is the one thing
// a history feature must never do, and it is what `records the version it
// replaced` and `can itself be undone` are here to keep true.
//
// RESTORE IS KEYED ON THE REVISION ITSELF, not a position in the array — a sheet
// previews a revision by value and only later acts, and a concurrent write from
// another device between those two moments shifts every index. The "concurrent
// write" describe block below is what that failure mode looks like and why
// matching on the whole snapshot rather than an index closes it.

const { mockSubscribe, mockSave, mockDelete, mockMember } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockSubscribe: vi.fn(),
    mockSave: vi.fn(),
    mockDelete: vi.fn(),
    mockMember: makeStore<{ name: string } | null>({ name: 'Daniel' }),
  };
});

vi.mock('@salt/firebase-sync', () => ({
  subscribeLibraryPages: mockSubscribe,
  saveLibraryPage: mockSave,
  deleteLibraryPage: mockDelete,
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
}));
vi.mock('../src/lib/membersService.js', () => ({ currentMember: mockMember }));

import {
  beginLibraryEdit,
  flushLibraryWrites,
  initLibrarySync,
  queueLibraryEdit,
  restoreLibraryRevision,
} from '../src/lib/libraryService.js';

function revision(over: Partial<LibraryPageRevisionDoc> = {}): LibraryPageRevisionDoc {
  return {
    title: 'Weck jars',
    body: 'The 742 holds 580 g.',
    savedAt: '2026-09-14T09:00:00.000Z',
    savedBy: 'Daniel',
    ...over,
  };
}

function page(over: Partial<LibraryPageDoc> = {}): LibraryPageDoc {
  return {
    id: 'page-1',
    schemaVersion: 1,
    kind: 'note',
    title: 'Weck jars',
    body: 'The 742 holds 580 g.',
    tags: ['Fermentation'],
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

/** Deliver a snapshot through the subscription the service opened. */
function deliver(pages: LibraryPageDoc[]): void {
  (mockSubscribe.mock.calls.at(-1)?.[0] as (p: LibraryPageDoc[]) => void)(pages);
}

/** The document the last `saveLibraryPage` call carried. */
function lastSaved(): LibraryPageDoc {
  return mockSave.mock.calls.at(-1)?.[0] as LibraryPageDoc;
}

/** Restore `rev`, let the write land, and echo it back as Firestore would. */
async function restoreAndSettle(rev: LibraryPageRevisionDoc): Promise<LibraryPageDoc> {
  const write = restoreLibraryRevision('page-1', rev);
  await flushLibraryWrites();
  await write;
  const saved = lastSaved();
  deliver([saved]);
  return saved;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscribe.mockReturnValue(() => {});
  mockSave.mockResolvedValue(success(undefined));
  mockDelete.mockResolvedValue(success(undefined));
  mockMember.set({ name: 'Daniel' });
  initLibrarySync();
  deliver([]);
});

describe('restoreLibraryRevision', () => {
  it('puts the chosen version’s title and body back on the page', async () => {
    const original = revision({ title: 'Weck jars', body: 'original' });
    deliver([page({ title: 'Rewritten', body: 'rewritten', revisions: [original] })]);
    const saved = await restoreAndSettle(original);
    expect(saved).toMatchObject({ title: 'Weck jars', body: 'original' });
  });

  // The whole point. A restore goes through `beginLibraryEdit` first, so the text
  // it overwrites is snapshotted and rides into `revisions` on the same write.
  it('records the version it replaced as the newest history entry', async () => {
    const original = revision({ title: 'Weck jars', body: 'original' });
    deliver([page({ title: 'Rewritten', body: 'rewritten', revisions: [original] })]);
    const saved = await restoreAndSettle(original);
    expect(saved.revisions[0]).toMatchObject({ title: 'Rewritten', body: 'rewritten' });
    expect(saved.revisions).toHaveLength(2);
  });

  // Which is what makes a restore undoable without any undo machinery: the
  // version that was showing is now at the front of the list.
  it('can itself be undone by restoring again', async () => {
    const original = revision({ title: 'Weck jars', body: 'original' });
    deliver([page({ title: 'Rewritten', body: 'rewritten', revisions: [original] })]);
    const afterFirst = await restoreAndSettle(original);
    const back = await restoreAndSettle(afterFirst.revisions[0]!);
    expect(back).toMatchObject({ title: 'Rewritten', body: 'rewritten' });
  });

  it('restores a version from further down the list, not just the newest', async () => {
    const target = revision({ body: 'three ago' });
    deliver([
      page({
        body: 'current',
        revisions: [revision({ body: 'one ago' }), revision({ body: 'two ago' }), target],
      }),
    ]);
    expect((await restoreAndSettle(target)).body).toBe('three ago');
  });

  // The DoD line "a restore that changes nothing records nothing", pinned.
  //
  // `pushRevision`'s dedup does NOT deliver this and the comment in the issue that
  // says it does is wrong: the dedup compares the snapshot (which is the text on
  // screen) against `revisions[0]`, so restoring version 1 while version 1's text
  // is already showing finds a different `revisions[0]` and records a second copy
  // of what is showing. The guard in `restoreLibraryRevision` is what makes the
  // sentence true. Break it — drop the short-circuit — and this goes red.
  it('writes nothing at all when the chosen version is what is already showing', async () => {
    const current = revision({ body: 'current' });
    deliver([page({ body: 'current', revisions: [revision({ body: 'one ago' }), current] })]);
    const result = await restoreLibraryRevision('page-1', current);
    await flushLibraryWrites();
    expect(result.kind).toBe('ok');
    expect(mockSave).not.toHaveBeenCalled();
  });

  // …including the ordinary case of restoring the newest version twice over.
  it('records nothing the second time the same version is restored', async () => {
    const original = revision({ body: 'original' });
    deliver([page({ body: 'current', revisions: [original] })]);
    const first = await restoreAndSettle(original);
    expect(first.body).toBe('original');

    mockSave.mockClear();
    await restoreLibraryRevision('page-1', original);
    await flushLibraryWrites();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('never grows the history past the cap, however many restores', async () => {
    let current = page({ body: 'v0' });
    deliver([current]);
    // Build a full history first, then keep restoring on top of it.
    for (let i = 1; i <= LIBRARY_PAGE_REVISION_CAP + 2; i += 1) {
      beginLibraryEdit('page-1');
      void queueLibraryEdit({ ...current, body: `v${i}` });
      await flushLibraryWrites();
      current = lastSaved();
      deliver([current]);
    }
    for (let i = 0; i < LIBRARY_PAGE_REVISION_CAP + 3; i += 1) {
      const target = current.revisions[LIBRARY_PAGE_REVISION_CAP - 1]!;
      current = await restoreAndSettle(target);
    }
    expect(current.revisions).toHaveLength(LIBRARY_PAGE_REVISION_CAP);
  });

  // A restore leaves nothing pending behind it: `queueLibraryEdit` consumes the
  // snapshot, so the next ordinary edit starts its own session rather than
  // inheriting this one's and losing its own pre-edit text.
  it('leaves no pending snapshot for the next edit to inherit', async () => {
    const original = revision({ body: 'original' });
    deliver([page({ body: 'current', revisions: [original] })]);
    const restored = await restoreAndSettle(original);

    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...restored, body: 'typed after' });
    await flushLibraryWrites();
    expect(lastSaved().revisions[0]).toMatchObject({ body: 'original' });
  });

  it('reports NotFound rather than throwing when the page is gone', async () => {
    deliver([]);
    const result = await restoreLibraryRevision('page-1', revision());
    expect(result).toMatchObject({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'libraryPage' },
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('reports NotFound rather than throwing for a revision the page no longer has', async () => {
    deliver([page({ revisions: [revision()] })]);
    const result = await restoreLibraryRevision('page-1', revision({ body: 'never on the page' }));
    expect(result.kind).toBe('err');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

// THE race the index-keyed version of this command had: a preview holds a
// revision by VALUE, taken from `page.revisions` when the sheet opened. Restoring
// used to hand back the INDEX it was previewed at, re-read against a live array —
// so a write from another device landing in between shifts every index, and the
// restore silently puts back a different version than the one shown, while still
// reporting success. Family-shared data has no "nobody else is editing this"
// window, so this is the ordinary case, not a corner one.
describe('restoreLibraryRevision — a concurrent write shifts the array', () => {
  it('restores the previewed version, not whatever now sits at its old position', async () => {
    const wanted = revision({ title: 'Weck jars', body: 'the one being previewed' });
    const initial = page({
      title: 'Someone else edited',
      body: 'concurrent body',
      revisions: [revision({ body: 'newer than the preview' }), wanted],
    });
    deliver([initial]);

    // A concurrent write lands while the preview is open — an ordinary edit from
    // another device, pushing a new revision to the front and shifting `wanted`
    // from index 1 to index 2.
    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...initial, body: 'yet another device wrote this' });
    await flushLibraryWrites();
    deliver([lastSaved()]);

    // The stale index (1) would now land on the WRONG revision. Restoring the
    // value itself still finds the right one.
    const result = await restoreAndSettle(wanted);
    expect(result).toMatchObject({ title: 'Weck jars', body: 'the one being previewed' });
  });

  it('reports NotFound rather than silently restoring a different version when the previewed one is gone', async () => {
    const evicted = revision({ body: 'no longer on the page' });
    deliver([page({ body: 'current', revisions: [evicted] })]);
    // Simulates the concurrent write that evicted it — the cap enforcement
    // itself (`pushRevision`) is proved in `libraryPage.schema.test.ts`.
    deliver([page({ body: 'current', revisions: [] })]);

    const result = await restoreLibraryRevision('page-1', evicted);
    expect(result).toMatchObject({ kind: 'err', error: { kind: 'NotFound' } });
    expect(mockSave).not.toHaveBeenCalled();
  });
});
