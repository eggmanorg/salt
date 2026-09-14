import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { success, failure } from '@salt/shared-types';
import type { LibraryPageDoc } from '@salt/domain/schemas';

// The library list (epic #1372, Phase 1) — `/library`.
//
// There is no folder tree: a page is filed by its tags, so the tag chips and the
// search box ARE the navigation. Both run client-side over the delivered list,
// which is why the subscription carries no query and the collection needs no index
// — and why the filtering is worth asserting here rather than trusting Firestore
// to have done it.

const { mockPages, mockInit, mockCreate, mockGate, mockToast } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockPages: makeStore<LibraryPageDoc[] | undefined>(undefined),
    mockInit: vi.fn(() => () => {}),
    mockCreate: vi.fn(),
    mockGate: makeStore<{ enabled: boolean; settled: boolean }>({ enabled: true, settled: true }),
    mockToast: vi.fn(),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/libraryService.js', () => ({
  libraryPages: mockPages,
  initLibrarySync: mockInit,
  createLibraryPage: mockCreate,
}));
vi.mock('../src/lib/featureGate.js', () => ({
  libraryGate: mockGate,
  featureGate: () => mockGate,
  isFeatureEnabled: () => true,
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockToast }));

import { push } from 'svelte-spa-router';
import LibraryListPage from '../src/routes/library/LibraryListPage.svelte';

function page(over: Partial<LibraryPageDoc> = {}): LibraryPageDoc {
  return {
    id: 'page-1',
    schemaVersion: 1,
    kind: 'note',
    title: 'Weck jars',
    body: '',
    tags: ['Fermentation'],
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

const JARS = page();
const SOUS_VIDE = page({
  id: 'page-2',
  title: 'Sous vide chuck',
  tags: ['Sous vide'],
  updatedAt: '2026-09-14T11:00:00.000Z',
});
const SAUSAGE = page({
  id: 'page-3',
  title: 'Fermented sausage',
  tags: ['Fermentation', 'Sous vide'],
  updatedAt: '2026-09-14T10:00:00.000Z',
});

function titles(): string[] {
  return screen.queryAllByTestId('library-card-title').map((el) => el.textContent?.trim() ?? '');
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockPages.set(undefined);
  mockGate.set({ enabled: true, settled: true });
  mockCreate.mockResolvedValue(success(JARS));
});

describe('LibraryListPage — loading and empty', () => {
  it('shows nothing but the loader until the first snapshot', () => {
    render(LibraryListPage);
    expect(screen.queryByTestId('library-list')).toBeNull();
    expect(screen.queryByTestId('library-empty')).toBeNull();
  });

  it('says the library is empty once it is loaded and empty', async () => {
    render(LibraryListPage);
    mockPages.set([]);
    expect(await screen.findByTestId('library-empty')).toBeTruthy();
  });
});

describe('LibraryListPage — order and filtering', () => {
  it('lists pages newest-edited first', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    await waitFor(() =>
      expect(titles()).toEqual(['Sous vide chuck', 'Fermented sausage', 'Weck jars']),
    );
  });

  it('searches titles', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    const search = await screen.findByTestId('library-search-input');
    await fireEvent.input(search, { target: { value: 'jar' } });
    await waitFor(() => expect(titles()).toEqual(['Weck jars']));
  });

  it('offers one chip per tag anybody has used, and no vocabulary to curate', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    const chips = await screen.findAllByTestId('library-tag-filter');
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['Fermentation', 'Sous vide']);
  });

  it('narrows to a tag when its chip is pressed', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    const chips = await screen.findAllByTestId('library-tag-filter');
    await fireEvent.click(chips[0]!);
    await waitFor(() => expect(titles()).toEqual(['Fermented sausage', 'Weck jars']));
  });

  it('un-narrows when a pressed chip is pressed again', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    const chips = await screen.findAllByTestId('library-tag-filter');
    await fireEvent.click(chips[0]!);
    await waitFor(() => expect(titles()).toEqual(['Fermented sausage', 'Weck jars']));
    await fireEvent.click(chips[0]!);
    await waitFor(() =>
      expect(titles()).toEqual(['Sous vide chuck', 'Fermented sausage', 'Weck jars']),
    );
  });

  // Chips NARROW rather than widen: a page filed under both tags is what "and"
  // leaves behind, and that is the behaviour a filter row reads as.
  it('ANDs two chosen tags rather than ORing them', async () => {
    render(LibraryListPage);
    mockPages.set([JARS, SOUS_VIDE, SAUSAGE]);
    const chips = await screen.findAllByTestId('library-tag-filter');
    await fireEvent.click(chips[0]!);
    await fireEvent.click(chips[1]!);
    await waitFor(() => expect(titles()).toEqual(['Fermented sausage']));
  });

  // Filters matching nothing is a different sentence from an empty library, and
  // saying "nothing here yet" over a populated library would be a lie.
  it('distinguishes "no matches" from "nothing written"', async () => {
    render(LibraryListPage);
    mockPages.set([JARS]);
    const search = await screen.findByTestId('library-search-input');
    await fireEvent.input(search, { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByTestId('library-no-matches')).toBeTruthy());
    expect(screen.queryByTestId('library-empty')).toBeNull();
  });

  it('hides the tag row when there is nothing to choose between', async () => {
    render(LibraryListPage);
    mockPages.set([JARS]);
    await screen.findByTestId('library-list');
    expect(screen.queryByTestId('library-tag-filters')).toBeNull();
  });
});

describe('LibraryListPage — creating and opening', () => {
  it('shows no tag row on a card that carries none', async () => {
    render(LibraryListPage);
    mockPages.set([page({ tags: [] })]);
    await screen.findByTestId('library-card');
    expect(screen.queryByTestId('library-card-tag')).toBeNull();
  });

  it('opens a page when its card is tapped', async () => {
    render(LibraryListPage);
    mockPages.set([JARS]);
    await fireEvent.click(await screen.findByTestId('library-card'));
    expect(push).toHaveBeenCalledWith('/library/page-1');
  });

  // No title dialog: the page's own title is editable in place, so a second way to
  // name it would be a second way to do a thing the feature already does.
  it('mints a page and lands on it', async () => {
    render(LibraryListPage);
    mockPages.set([]);
    await fireEvent.click(await screen.findByTestId('library-new-page'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/library/page-1'));
    expect(mockCreate).toHaveBeenCalled();
  });

  it('stays put and says so when the write fails', async () => {
    mockCreate.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    render(LibraryListPage);
    mockPages.set([]);
    await fireEvent.click(await screen.findByTestId('library-new-page'));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });
});

describe('LibraryListPage — the feature gate', () => {
  // Nothing may HINT that a feature is withheld: the surface is simply absent,
  // with no denial copy (issue #831).
  it('renders nothing at all for someone the library is hidden from', async () => {
    mockGate.set({ enabled: false, settled: true });
    render(LibraryListPage);
    mockPages.set([JARS]);
    await waitFor(() => expect(screen.queryByTestId('library-list-page')).toBeNull());
    expect(screen.queryByText(/library/i)).toBeNull();
  });
});

// Pasting a website into a brand-new page (issue #1375, Phase 2).
//
// The conversion is proved in `libraryImport.test.ts`. What matters here is that
// the list's import lands as a NEW page carrying the converted markdown, and that
// it is minted with the same placeholder title a hand-written page gets — the
// title is editable in place, so a dialog asking for one would be a second way to
// do a thing this feature already does.
describe('LibraryListPage — pasting content in', () => {
  const TABLE =
    '<table><thead><tr><th>Cut</th></tr></thead><tbody><tr><td>Ribeye</td></tr></tbody></table>';

  async function openImport() {
    render(LibraryListPage);
    mockPages.set([]);
    await fireEvent.click(await screen.findByTestId('library-import-page'));
    return (await screen.findByTestId('library-import-input')) as HTMLTextAreaElement;
  }

  it('creates a page carrying the converted markdown and opens it', async () => {
    mockCreate.mockResolvedValue(success({ ...page(), id: 'page-9' }));
    const box = await openImport();
    await fireEvent.paste(box, {
      clipboardData: { getData: (t: string) => (t === 'text/html' ? TABLE : '') },
    });
    await waitFor(() => expect(box.value).toContain('| Cut |'));
    await fireEvent.click(await screen.findByTestId('library-import-confirm'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const [title, body] = mockCreate.mock.calls.at(-1) as [string, string];
    expect(title).toBe('Untitled page');
    expect(body).toContain('| Cut |');
    expect(push).toHaveBeenCalledWith('/library/page-9');
  });

  it('still mints an empty page from New page', async () => {
    mockCreate.mockResolvedValue(success(page()));
    render(LibraryListPage);
    mockPages.set([]);
    await fireEvent.click(await screen.findByTestId('library-new-page'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('Untitled page', ''));
  });
});
