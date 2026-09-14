/**
 * `searchLibraryPages` (issue #1377) — the keyword filter behind the chef's
 * `findKitchenNotes` tool.
 *
 * A filter, not a ranking, and the tests say so: what is pinned is which pages
 * come back, that every token has to be found, that a title match outranks a
 * passing mention, and that the ceiling holds however large a `maxResults` the
 * model asks for.
 */
import { describe, it, expect } from 'vitest';
import {
  searchLibraryPages,
  LIBRARY_PAGE_SEARCH_DEFAULT_MAX,
  LIBRARY_PAGE_SEARCH_CEILING,
  type LibraryPageCandidate,
} from '@salt/domain';

const page = (over: Partial<LibraryPageCandidate> = {}): LibraryPageCandidate => ({
  id: 'p-1',
  title: 'Sous vide times',
  tags: ['sous-vide'],
  body: 'Chuck at 65 °C for 24 hours.',
  ...over,
});

const jars = page({
  id: 'p-jars',
  title: 'The Weck jars',
  tags: ['storage'],
  body: 'A tapered 1 L jar and two 580 ml tulips.',
});
const kraut = page({
  id: 'p-kraut',
  title: 'Sauerkraut',
  tags: ['ferment'],
  body: 'Two kilos of cabbage fills the 1 L jar exactly.',
});

describe('searchLibraryPages — the filter', () => {
  it('browses the whole library when no query is given', () => {
    expect(searchLibraryPages([jars, kraut]).map((p) => p.id)).toEqual(['p-jars', 'p-kraut']);
  });

  it('requires EVERY word of the query to appear somewhere in the page', () => {
    expect(searchLibraryPages([jars, kraut], { query: 'tapered tulips' }).map((p) => p.id)).toEqual(
      ['p-jars'],
    );
    expect(searchLibraryPages([jars, kraut], { query: 'tapered cabbage' })).toEqual([]);
  });

  it('matches on the body, the title and the tags alike', () => {
    expect(searchLibraryPages([jars], { query: 'weck' }).map((p) => p.id)).toEqual(['p-jars']);
    expect(searchLibraryPages([jars], { query: 'storage' }).map((p) => p.id)).toEqual(['p-jars']);
    expect(searchLibraryPages([jars], { query: 'tulips' }).map((p) => p.id)).toEqual(['p-jars']);
  });

  it('puts the page NAMED for the query ahead of one that merely mentions it', () => {
    // The difference between the page about jars and the page that happens to
    // talk about one.
    expect(searchLibraryPages([kraut, jars], { query: 'jar' }).map((p) => p.id)).toEqual([
      'p-jars',
      'p-kraut',
    ]);
  });

  it('ignores case and punctuation in the query', () => {
    expect(searchLibraryPages([jars], { query: 'WECK, jars!' }).map((p) => p.id)).toEqual([
      'p-jars',
    ]);
  });

  it('returns nothing for a query the library answers nowhere', () => {
    expect(searchLibraryPages([jars, kraut], { query: 'gochujang' })).toEqual([]);
  });

  it('handles an empty library', () => {
    expect(searchLibraryPages([], { query: 'jars' })).toEqual([]);
    expect(searchLibraryPages([])).toEqual([]);
  });
});

describe('searchLibraryPages — how much comes back', () => {
  const many = Array.from({ length: 40 }, (_, i) => page({ id: `p-${i}` }));

  it('defaults to LIBRARY_PAGE_SEARCH_DEFAULT_MAX', () => {
    expect(searchLibraryPages(many)).toHaveLength(LIBRARY_PAGE_SEARCH_DEFAULT_MAX);
  });

  it('honours a smaller maxResults', () => {
    expect(searchLibraryPages(many, { maxResults: 3 })).toHaveLength(3);
  });

  it('caps at the ceiling however large a number the model asks for', () => {
    // The bound on how much prose one search can push into the next model turn.
    expect(searchLibraryPages(many, { maxResults: 1000 })).toHaveLength(
      LIBRARY_PAGE_SEARCH_CEILING,
    );
  });

  it('never returns nothing merely because maxResults was zero or negative', () => {
    expect(searchLibraryPages(many, { maxResults: 0 })).toHaveLength(1);
    expect(searchLibraryPages(many, { maxResults: -5 })).toHaveLength(1);
  });
});
