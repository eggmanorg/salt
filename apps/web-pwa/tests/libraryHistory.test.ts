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

/** Restore, let the write land, and echo it back as Firestore would. */
async function restoreAndSettle(index: number): Promise<LibraryPageDoc> {
  const write = restoreLibraryRevision('page-1', index);
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
    deliver([
      page({
        title: 'Rewritten',
        body: 'rewritten',
        revisions: [revision({ title: 'Weck jars', body: 'original' })],
      }),
    ]);
    const saved = await restoreAndSettle(0);
    expect(saved).toMatchObject({ title: 'Weck jars', body: 'original' });
  });

  // The whole point. A restore goes through `beginLibraryEdit` first, so the text
  // it overwrites is snapshotted and rides into `revisions` on the same write.
  it('records the version it replaced as the newest history entry', async () => {
    deliver([
      page({
        title: 'Rewritten',
        body: 'rewritten',
        revisions: [revision({ title: 'Weck jars', body: 'original' })],
      }),
    ]);
    const saved = await restoreAndSettle(0);
    expect(saved.revisions[0]).toMatchObject({ title: 'Rewritten', body: 'rewritten' });
    expect(saved.revisions).toHaveLength(2);
  });

  // Which is what makes a restore undoable without any undo machinery: the
  // version that was showing is now at the front of the list.
  it('can itself be undone by restoring again', async () => {
    deliver([
      page({
        title: 'Rewritten',
        body: 'rewritten',
        revisions: [revision({ title: 'Weck jars', body: 'original' })],
      }),
    ]);
    await restoreAndSettle(0);
    const back = await restoreAndSettle(0);
    expect(back).toMatchObject({ title: 'Rewritten', body: 'rewritten' });
  });

  it('restores a version from further down the list, not just the newest', async () => {
    deliver([
      page({
        body: 'current',
        revisions: [
          revision({ body: 'one ago' }),
          revision({ body: 'two ago' }),
          revision({ body: 'three ago' }),
        ],
      }),
    ]);
    expect((await restoreAndSettle(2)).body).toBe('three ago');
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
    deliver([
      page({
        body: 'current',
        revisions: [revision({ body: 'one ago' }), revision({ body: 'current' })],
      }),
    ]);
    const result = await restoreLibraryRevision('page-1', 1);
    await flushLibraryWrites();
    expect(result.kind).toBe('ok');
    expect(mockSave).not.toHaveBeenCalled();
  });

  // …including the ordinary case of restoring the newest version twice over.
  it('records nothing the second time the same version is restored', async () => {
    deliver([page({ body: 'current', revisions: [revision({ body: 'original' })] })]);
    const first = await restoreAndSettle(0);
    expect(first.body).toBe('original');

    mockSave.mockClear();
    await restoreLibraryRevision('page-1', 1);
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
      current = await restoreAndSettle(LIBRARY_PAGE_REVISION_CAP - 1);
    }
    expect(current.revisions).toHaveLength(LIBRARY_PAGE_REVISION_CAP);
  });

  // A restore leaves nothing pending behind it: `queueLibraryEdit` consumes the
  // snapshot, so the next ordinary edit starts its own session rather than
  // inheriting this one's and losing its own pre-edit text.
  it('leaves no pending snapshot for the next edit to inherit', async () => {
    deliver([page({ body: 'current', revisions: [revision({ body: 'original' })] })]);
    const restored = await restoreAndSettle(0);

    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...restored, body: 'typed after' });
    await flushLibraryWrites();
    expect(lastSaved().revisions[0]).toMatchObject({ body: 'original' });
  });

  it('reports NotFound rather than throwing when the page is gone', async () => {
    deliver([]);
    const result = await restoreLibraryRevision('page-1', 0);
    expect(result).toMatchObject({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'libraryPage' },
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('reports NotFound rather than throwing for an index the page does not have', async () => {
    deliver([page({ revisions: [revision()] })]);
    const result = await restoreLibraryRevision('page-1', 4);
    expect(result.kind).toBe('err');
    expect(mockSave).not.toHaveBeenCalled();
  });
});
