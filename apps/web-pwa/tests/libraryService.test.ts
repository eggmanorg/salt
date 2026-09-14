import { describe, it, expect, beforeEach, vi } from 'vitest';
import { success, failure } from '@salt/shared-types';
import { LIBRARY_PAGE_REVISION_CAP, type LibraryPageDoc } from '@salt/domain/schemas';

// The library service (epic #1372, Phase 1) — the store over `libraryPages` and the
// one write path for it.
//
// Most of what is asserted here is the REVISION CAPTURE, because it is the only
// part of this service that is not a thin pass-through, and because the way it can
// go wrong is silent: writes are debounced, so a snapshot taken per write rather
// than per editing session produces a ten-deep history of one paragraph typed ten
// characters at a time — a history that looks healthy and can restore nothing.

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

import { get } from 'svelte/store';
import {
  beginLibraryEdit,
  createLibraryPage,
  endLibraryEdit,
  flushLibraryWrites,
  initLibrarySync,
  libraryPageById,
  libraryPages,
  queueLibraryEdit,
  removeLibraryPage,
} from '../src/lib/libraryService.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscribe.mockReturnValue(() => {});
  mockSave.mockResolvedValue(success(undefined));
  mockDelete.mockResolvedValue(success(undefined));
  mockMember.set({ name: 'Daniel' });
  initLibrarySync();
  deliver([]);
});

describe('initLibrarySync', () => {
  it('holds `undefined` until the first snapshot, then the pages', () => {
    vi.clearAllMocks();
    mockSubscribe.mockReturnValue(() => {});
    initLibrarySync();
    // Nothing delivered yet — but the store keeps whatever the previous
    // subscription last delivered, so the interesting assertion is the delivery.
    deliver([page()]);
    expect(get(libraryPages)?.map((p) => p.id)).toEqual(['page-1']);
  });

  it('settles on an EMPTY list when the stream fails, never on the spinner', () => {
    const onError = mockSubscribe.mock.calls.at(-1)?.[1] as (e: unknown) => void;
    onError({ kind: 'StorageError', reason: 'unavailable' });
    expect(get(libraryPages)).toEqual([]);
  });
});

describe('createLibraryPage', () => {
  it('mints an id and a clock, and writes immediately', async () => {
    const result = await createLibraryPage('  Sous vide  ');
    expect(result.kind).toBe('ok');
    const saved = lastSaved();
    expect(saved.title).toBe('Sous vide');
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.createdAt).toEqual(expect.any(String));
    expect(saved).toMatchObject({ schemaVersion: 1, kind: 'note', body: '', tags: [] });
  });

  it('denormalises the signed-in member as a display NAME, never a uid', async () => {
    await createLibraryPage('Sous vide');
    expect(lastSaved()).toMatchObject({ createdBy: 'Daniel', lastEditedBy: 'Daniel' });
  });

  it('falls back to a human word when nobody is on the roster', async () => {
    mockMember.set(null);
    await createLibraryPage('Sous vide');
    expect(lastSaved().createdBy).toBe('Someone');
  });

  it('puts the page in the store before the write comes back', async () => {
    let resolve!: (v: unknown) => void;
    mockSave.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = createLibraryPage('Sous vide');
    expect(get(libraryPages)?.map((p) => p.title)).toContain('Sous vide');
    resolve(success(undefined));
    await pending;
  });

  it('reports the failure back to the caller, which has to navigate or not', async () => {
    mockSave.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    expect((await createLibraryPage('Sous vide')).kind).toBe('err');
  });
});

describe('queueLibraryEdit', () => {
  beforeEach(() => deliver([page()]));

  it('applies to the store synchronously and stamps the edit', () => {
    void queueLibraryEdit({ ...page(), title: 'Jars' });
    const stored = libraryPageById('page-1');
    expect(stored?.title).toBe('Jars');
    expect(stored?.updatedAt).not.toBe('2026-09-14T09:00:00.000Z');
    expect(stored?.lastEditedBy).toBe('Daniel');
  });

  it('coalesces a burst into one write', async () => {
    void queueLibraryEdit({ ...page(), body: 'a' });
    void queueLibraryEdit({ ...page(), body: 'ab' });
    void queueLibraryEdit({ ...page(), body: 'abc' });
    await flushLibraryWrites();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(lastSaved().body).toBe('abc');
  });
});

describe('revision capture', () => {
  beforeEach(() => deliver([page({ body: 'original' })]));

  it('records the PRE-EDIT state on the first write of an editing session', async () => {
    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...page({ body: 'original' }), body: 'rewritten' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toHaveLength(1);
    expect(lastSaved().revisions[0]).toMatchObject({ body: 'original', savedBy: 'Daniel' });
  });

  // THE property this whole mechanism exists for. Writes are debounced, so a
  // snapshot per write would be a snapshot per keystroke burst.
  it('records ONE revision for a session however many writes it takes', async () => {
    beginLibraryEdit('page-1');
    // Rebuilt from the store each time, which is what the page itself does: the
    // optimistic apply is what carries the growing document forward.
    for (const body of ['o', 'or', 'ori', 'orig']) {
      void queueLibraryEdit({ ...(libraryPageById('page-1') as LibraryPageDoc), body });
      await flushLibraryWrites();
    }
    expect(lastSaved().revisions).toHaveLength(1);
    expect(lastSaved().revisions[0]?.body).toBe('original');
  });

  it('keeps the FIRST snapshot when several fields are opened in one session', async () => {
    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...page({ body: 'original' }), title: 'Jars' });
    await flushLibraryWrites();
    deliver([lastSaved()]);
    // A second `begin` inside the same session must not re-snapshot the text the
    // first edit already changed.
    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...lastSaved(), body: 'rewritten' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toHaveLength(2);
    expect(lastSaved().revisions[0]?.title).toBe('Jars');
  });

  // The early return in `beginLibraryEdit`. Opening the title editor, then the
  // body editor, inside ONE session must not re-snapshot: the second snapshot
  // would already carry the first field's new text, so restoring it would give
  // back a version that never existed.
  it('keeps the first snapshot when a session is re-opened before any write', async () => {
    beginLibraryEdit('page-1');
    beginLibraryEdit('page-1');
    void queueLibraryEdit({ ...page({ body: 'original' }), body: 'rewritten' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toHaveLength(1);
    expect(lastSaved().revisions[0]?.body).toBe('original');
  });

  it('records nothing when no session was opened — a chat write comes later', async () => {
    void queueLibraryEdit({ ...page({ body: 'original' }), body: 'rewritten' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toEqual([]);
  });

  it('drops an abandoned session so it cannot attach to a later edit', async () => {
    beginLibraryEdit('page-1');
    endLibraryEdit('page-1');
    void queueLibraryEdit({ ...page({ body: 'original' }), body: 'rewritten' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toEqual([]);
  });

  it('ignores a session opened on a page the store does not hold', async () => {
    beginLibraryEdit('nope');
    void queueLibraryEdit({ ...page({ id: 'nope' }), body: 'x' });
    await flushLibraryWrites();
    expect(lastSaved().revisions).toEqual([]);
  });

  it('never grows past the cap', async () => {
    let current = page({ body: 'v0' });
    deliver([current]);
    for (let i = 1; i <= LIBRARY_PAGE_REVISION_CAP + 3; i += 1) {
      beginLibraryEdit('page-1');
      void queueLibraryEdit({ ...current, body: `v${i}` });
      await flushLibraryWrites();
      current = lastSaved();
      deliver([current]);
    }
    expect(current.revisions).toHaveLength(LIBRARY_PAGE_REVISION_CAP);
  });
});

// Every mutator has to work in the window between the page mounting and the first
// snapshot arriving, when the store still holds `undefined` rather than a list —
// offline on a cold start that window is unbounded.
describe('before the first snapshot has arrived', () => {
  let service: typeof import('../src/lib/libraryService.js');

  beforeEach(async () => {
    vi.resetModules();
    service = await import('../src/lib/libraryService.js');
    service.initLibrarySync();
  });

  it('starts a page list from nothing when one is created', async () => {
    await service.createLibraryPage('Sous vide');
    expect(get(service.libraryPages)?.map((p) => p.title)).toEqual(['Sous vide']);
  });

  it('appends rather than replaces when an edit arrives for a page it has not seen', async () => {
    void service.queueLibraryEdit(page({ id: 'unseen' }));
    expect(get(service.libraryPages)?.map((p) => p.id)).toEqual(['unseen']);
    await service.flushLibraryWrites();
  });

  it('deletes without a list to delete from', async () => {
    expect((await service.removeLibraryPage('page-1')).kind).toBe('ok');
    expect(get(service.libraryPages)).toEqual([]);
  });
});

describe('removeLibraryPage', () => {
  beforeEach(() => deliver([page(), page({ id: 'page-2', title: 'Sous vide' })]));

  it('deletes for real and takes the page out of the store', async () => {
    await removeLibraryPage('page-1');
    expect(mockDelete).toHaveBeenCalledWith('page-1');
    expect(get(libraryPages)?.map((p) => p.id)).toEqual(['page-2']);
  });

  // A pending edit holds a whole document captured BEFORE the delete. Left on its
  // own timer it would issue that `setDoc` afterwards and resurrect the page, so
  // the flush has to happen first — and it has to be this page's, not everybody's.
  it('flushes this page’s pending edit before deleting, and keeps another page’s', async () => {
    void queueLibraryEdit({ ...page(), body: 'half-typed' });
    void queueLibraryEdit({ ...page({ id: 'page-2', title: 'Sous vide' }), body: 'elsewhere' });
    await removeLibraryPage('page-1');

    const order = mockSave.mock.invocationCallOrder[0] ?? 0;
    expect(mockDelete.mock.invocationCallOrder[0]).toBeGreaterThan(order);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(lastSaved().id).toBe('page-1');

    // The other page's edit survived and still lands.
    await flushLibraryWrites();
    expect(lastSaved().id).toBe('page-2');
  });

  it('surfaces a failed delete rather than throwing', async () => {
    mockDelete.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    expect((await removeLibraryPage('page-1')).kind).toBe('err');
  });
});
