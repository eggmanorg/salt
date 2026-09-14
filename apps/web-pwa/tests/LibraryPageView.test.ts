import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { success, failure } from '@salt/shared-types';
import type { LibraryPageDoc } from '@salt/domain/schemas';

// One library page (epic #1372, Phase 1) — `/library/:id`.
//
// THE thing this screen has to get right is that there is no Save button and no
// edit mode: tap a field, it becomes a text box; tap away, it is written. So most
// of what is asserted here is that an edit reaches `queueLibraryEdit` at all, that
// leaving a field flushes rather than merely stopping, and that an editing session
// is marked open BEFORE the edit — which is what the revision capture hangs on.

const {
  mockPages,
  mockInit,
  mockQueue,
  mockFlush,
  mockBegin,
  mockEnd,
  mockRemove,
  mockRestore,
  mockGate,
  mockToast,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockPages: makeStore<LibraryPageDoc[] | undefined>(undefined),
    mockInit: vi.fn(() => () => {}),
    mockQueue: vi.fn(),
    mockFlush: vi.fn(),
    mockBegin: vi.fn(),
    mockEnd: vi.fn(),
    mockRemove: vi.fn(),
    mockRestore: vi.fn(),
    mockGate: makeStore<{ enabled: boolean; settled: boolean }>({ enabled: true, settled: true }),
    mockToast: vi.fn(),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/libraryService.js', () => ({
  libraryPages: mockPages,
  initLibrarySync: mockInit,
  queueLibraryEdit: mockQueue,
  flushLibraryWrites: mockFlush,
  beginLibraryEdit: mockBegin,
  endLibraryEdit: mockEnd,
  removeLibraryPage: mockRemove,
  restoreLibraryRevision: mockRestore,
}));
vi.mock('../src/lib/featureGate.js', () => ({
  libraryGate: mockGate,
  featureGate: () => mockGate,
  isFeatureEnabled: () => true,
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockToast }));

import { push } from 'svelte-spa-router';
import LibraryPageView from '../src/routes/library/LibraryPageView.svelte';

function page(over: Partial<LibraryPageDoc> = {}): LibraryPageDoc {
  return {
    id: 'page-1',
    schemaVersion: 1,
    kind: 'note',
    title: 'Weck jars',
    body: '## Jars\n\n| Model | Brim |\n| --- | --- |\n| 742 | 580 g |',
    tags: ['Fermentation'],
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

function mount(doc: LibraryPageDoc | null = page()) {
  const result = render(LibraryPageView, { props: { params: { id: 'page-1' } } });
  mockPages.set(doc === null ? [] : [doc]);
  return result;
}

/** The document the last queued edit carried. */
function lastEdit(): LibraryPageDoc {
  return mockQueue.mock.calls.at(-1)?.[0] as LibraryPageDoc;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockPages.set(undefined);
  mockGate.set({ enabled: true, settled: true });
  mockQueue.mockResolvedValue(success(undefined));
  mockFlush.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(success(undefined));
  mockRestore.mockResolvedValue(success(undefined));
});

function revision(over: Partial<LibraryPageDoc['revisions'][number]> = {}) {
  return {
    title: 'Weck jars',
    body: '## Jars\n\nThe 742 holds 580 g.',
    savedAt: '2026-09-14T09:00:00.000Z',
    savedBy: 'Daniel',
    ...over,
  };
}

describe('LibraryPageView — what it shows', () => {
  it('waits for the first snapshot rather than claiming the page is gone', () => {
    render(LibraryPageView, { props: { params: { id: 'page-1' } } });
    expect(screen.getByTestId('library-page-loading')).toBeTruthy();
    expect(screen.queryByTestId('library-page-missing')).toBeNull();
  });

  // svelte-spa-router passes no `params` for a route with no placeholders, and a
  // component that assumed one would throw rather than render its empty state.
  it('renders the not-found state rather than throwing when no params arrive', async () => {
    render(LibraryPageView);
    mockPages.set([page()]);
    expect(await screen.findByTestId('library-page-missing')).toBeTruthy();
  });

  it('says so when the page is not in the library any more', async () => {
    mount(null);
    expect(await screen.findByTestId('library-page-missing')).toBeTruthy();
  });

  // Tables are the point of this feature. The renderer already carries
  // `gfmPlugin()`, and this is what says so for the library rather than for chat.
  it('renders the body as markdown — headings and TABLES', async () => {
    mount();
    const body = await screen.findByTestId('library-body');
    expect(body.querySelector('h2')?.textContent).toBe('Jars');
    expect(body.querySelector('table')).toBeTruthy();
    expect(body.querySelectorAll('td')[1]?.textContent).toBe('580 g');
  });

  // No `rehype-raw` anywhere in the repo, so raw HTML in a body is INERT rather
  // than sanitised — it is not rendered at all. Phase 3 is what opens that,
  // deliberately and behind an allowlist; this pins today's answer.
  it('does not render raw HTML in a body', async () => {
    mount(page({ body: '<div data-testid="smuggled">hello</div>' }));
    await screen.findByTestId('library-body');
    expect(screen.queryByTestId('smuggled')).toBeNull();
  });

  it('invites the first words when the page is blank', async () => {
    mount(page({ body: '   ' }));
    expect((await screen.findByTestId('library-body')).textContent).toMatch(/nothing written/i);
  });

  it('shows the tags as chips', async () => {
    mount(page({ tags: ['Fermentation', 'Sous vide'] }));
    const chips = await screen.findAllByTestId('library-page-tag');
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Fermentation', 'Sous vide']);
  });
});

describe('LibraryPageView — editing in place', () => {
  it('turns the body into a text box on a tap, with no Save button anywhere', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    expect(await screen.findByTestId('library-body-input')).toBeTruthy();
    expect(screen.queryByText(/^save$/i)).toBeNull();
  });

  it('marks the editing session open BEFORE the first edit', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    const input = await screen.findByTestId('library-body-input');
    await fireEvent.input(input, { target: { value: 'rewritten' } });
    expect(mockBegin).toHaveBeenCalledWith('page-1');
    expect(mockBegin.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueue.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('queues the whole document on every keystroke, rebuilt from the page', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    await fireEvent.input(await screen.findByTestId('library-body-input'), {
      target: { value: 'rewritten' },
    });
    expect(lastEdit()).toMatchObject({ id: 'page-1', title: 'Weck jars', body: 'rewritten' });
  });

  it('edits the title in place', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-edit-title'));
    await fireEvent.input(await screen.findByTestId('library-title-input'), {
      target: { value: 'Jars' },
    });
    expect(lastEdit().title).toBe('Jars');
  });

  // Typed as a comma line, stored as a list: blanks dropped, duplicates collapsed
  // case-insensitively, and the words kept exactly as they were typed.
  it('splits, trims and de-duplicates the tag line', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-edit-tags'));
    await fireEvent.input(await screen.findByTestId('library-tags-input'), {
      target: { value: ' Fermentation , , fermentation ,Sous vide ' },
    });
    expect(lastEdit().tags).toEqual(['Fermentation', 'Sous vide']);
  });

  // "Tap away and it saves" — the debounce alone loses the last edit when the page
  // is navigated away from inside its window.
  it('closes and flushes when focus leaves the editor', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    const input = await screen.findByTestId('library-body-input');
    await fireEvent.focusOut(input.closest('div')!, { relatedTarget: null });
    await waitFor(() => expect(screen.queryByTestId('library-body-input')).toBeNull());
    expect(mockFlush).toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalledWith('page-1');
  });

  it('stays open when focus moves to something inside the editor', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    const input = await screen.findByTestId('library-body-input');
    const wrapper = input.closest('div')!;
    await fireEvent.focusOut(wrapper, { relatedTarget: input });
    expect(screen.queryByTestId('library-body-input')).toBeTruthy();
  });

  it('offers a dashed slot when the page has no tags yet', async () => {
    mount(page({ tags: [] }));
    const slot = await screen.findByTestId('library-edit-tags');
    expect(slot.textContent).toMatch(/\+ Tags/);
    expect(screen.queryByTestId('library-page-tag')).toBeNull();
  });

  it('closes the title editor when focus leaves it', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-edit-title'));
    const input = await screen.findByTestId('library-title-input');
    await fireEvent.focusOut(input.closest('div')!, { relatedTarget: null });
    await waitFor(() => expect(screen.queryByTestId('library-title-input')).toBeNull());
    expect(mockFlush).toHaveBeenCalled();
  });

  it('closes the tags editor when focus leaves it', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-edit-tags'));
    const input = await screen.findByTestId('library-tags-input');
    await fireEvent.focusOut(input.closest('div')!, { relatedTarget: null });
    await waitFor(() => expect(screen.queryByTestId('library-tags-input')).toBeNull());
  });

  it('opens the body editor from the keyboard route as well as the tap target', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-edit-body'));
    expect(await screen.findByTestId('library-body-input')).toBeTruthy();
    // The button is the editor's own affordance, so it goes while the editor is up.
    expect(screen.queryByTestId('library-edit-body')).toBeNull();
  });

  // The coalescer hands every edit in one window the same promise, so comparing
  // against the last one toasted is what turns a burst into one message.
  it('raises one toast when the write fails', async () => {
    mockQueue.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    await fireEvent.input(await screen.findByTestId('library-body-input'), {
      target: { value: 'x' },
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
  });
});

describe('LibraryPageView — deleting', () => {
  it('says nothing more when the SAME failed write resolves for a second edit', async () => {
    const shared = Promise.resolve(failure({ kind: 'StorageError', reason: 'unavailable' }));
    mockQueue.mockReturnValue(shared);
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    const input = await screen.findByTestId('library-body-input');
    await fireEvent.input(input, { target: { value: 'a' } });
    await fireEvent.input(input, { target: { value: 'ab' } });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToast).toHaveBeenCalledTimes(1);
  });
});

describe('LibraryPageView — leaving', () => {
  it('goes back rather than to a fixed route', async () => {
    mount();
    await fireEvent.click(await screen.findByRole('button', { name: 'Library' }));
    // `goBack` falls back to the list when nothing in-app is behind us, which is
    // the case in a freshly-rendered test.
    expect(push).toHaveBeenCalledWith('/library');
  });
});

describe('LibraryPageView — deleting', () => {
  it('asks before deleting, because a page is an evening’s work', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-delete-page'));
    expect(await screen.findByTestId('library-delete-dialog')).toBeTruthy();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('keeps the page when the dialog is dismissed', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-delete-page'));
    await fireEvent.click(await screen.findByText('Keep it'));
    await waitFor(() => expect(screen.queryByTestId('library-delete-dialog')).toBeNull());
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('deletes and leaves for the list once confirmed', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-delete-page'));
    await fireEvent.click(await screen.findByTestId('library-delete-confirm'));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('page-1'));
    expect(push).toHaveBeenCalledWith('/library');
  });

  it('stays put and says so when the delete fails', async () => {
    mockRemove.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    mount();
    await fireEvent.click(await screen.findByTestId('library-delete-page'));
    await fireEvent.click(await screen.findByTestId('library-delete-confirm'));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });
});

describe('LibraryPageView — the feature gate', () => {
  it('renders nothing at all for someone the library is hidden from', async () => {
    mockGate.set({ enabled: false, settled: true });
    mount();
    await waitFor(() => expect(screen.queryByTestId('library-page-view')).toBeNull());
  });
});

// The history surface (issue #1375, Phase 1). The service-level proof that a
// restore keeps the version it replaced lives in `libraryHistory.test.ts`; what
// is asserted here is the screen — that the control is always there, that a
// version can be read before anything changes, and that the page lands a
// half-typed edit BEFORE opening the sheet, which is what makes the version a
// restore then replaces the one actually on screen.
describe('LibraryPageView — history', () => {
  it('offers History even on a page nobody has edited, and says it is empty', async () => {
    mount(page({ revisions: [] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    expect(await screen.findByTestId('library-history-empty')).toBeTruthy();
    expect(screen.queryByTestId('library-history-list')).toBeNull();
  });

  it('lists the versions newest first, each with when and by whom', async () => {
    mount(
      page({
        revisions: [
          revision({ title: 'Newest', savedBy: 'Daniel' }),
          revision({ title: 'Older', savedBy: 'Amy' }),
        ],
      }),
    );
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    const rows = await screen.findAllByTestId('library-history-row');
    expect(rows.map((r) => r.querySelector('span')?.textContent?.trim())).toEqual([
      'Newest',
      'Older',
    ]);
    expect(rows[1]?.textContent).toMatch(/replaced by Amy/);
  });

  it('shows a version rendered, and changes nothing until Restore is pressed', async () => {
    mount(page({ revisions: [revision({ body: '## Jars\n\n| Model |\n| --- |\n| 742 |' })] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    await fireEvent.click(await screen.findByTestId('library-history-row'));
    const preview = await screen.findByTestId('library-history-preview');
    expect(preview.querySelector('h2')?.textContent).toBe('Jars');
    expect(preview.querySelector('table')).toBeTruthy();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  // A title can be cleared in place, so a version can carry an empty one — and a
  // blank row would be unclickable-looking rather than merely untitled.
  it('names an untitled version rather than showing a blank row', async () => {
    mount(page({ revisions: [revision({ title: '  ' })] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    const row = await screen.findByTestId('library-history-row');
    expect(row.querySelector('span')?.textContent?.trim()).toBe('Untitled');
  });

  it('says so when the version being previewed was empty', async () => {
    mount(page({ revisions: [revision({ body: '   ' })] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    await fireEvent.click(await screen.findByTestId('library-history-row'));
    const preview = await screen.findByTestId('library-history-preview');
    expect(preview.textContent).toMatch(/nothing written/i);
  });

  it('goes back to the list from a preview without restoring anything', async () => {
    mount(page({ revisions: [revision()] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    await fireEvent.click(await screen.findByTestId('library-history-row'));
    await fireEvent.click(await screen.findByText('Back'));
    expect(await screen.findByTestId('library-history-list')).toBeTruthy();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('restores the version being previewed and closes', async () => {
    mount(page({ revisions: [revision(), revision({ title: 'Older' })] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    await fireEvent.click((await screen.findAllByTestId('library-history-row'))[1]!);
    await fireEvent.click(await screen.findByTestId('library-history-restore'));
    await waitFor(() => expect(mockRestore).toHaveBeenCalledWith('page-1', 1));
    await waitFor(() => expect(screen.queryByTestId('library-history-preview')).toBeNull());
  });

  it('lands a half-typed edit before the sheet opens', async () => {
    mount();
    await fireEvent.click(await screen.findByTestId('library-body'));
    await fireEvent.input(await screen.findByTestId('library-body-input'), {
      target: { value: 'half typed' },
    });
    mockFlush.mockClear();
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    expect(mockEnd).toHaveBeenCalledWith('page-1');
    expect(mockFlush).toHaveBeenCalled();
    await screen.findByTestId('library-history-empty');
  });

  it('says so when the restore fails', async () => {
    mockRestore.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    mount(page({ revisions: [revision()] }));
    await fireEvent.click(await screen.findByTestId('library-page-history'));
    await fireEvent.click(await screen.findByTestId('library-history-row'));
    await fireEvent.click(await screen.findByTestId('library-history-restore'));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
  });
});
