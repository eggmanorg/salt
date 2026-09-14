/**
 * `libraryPageSummary` (issue #1377) — the search line the chef reads before
 * deciding whether to open a note.
 *
 * The property this pins is the one the design rests on: the summary is DERIVED
 * from the body every time it is asked for. There is no summary field and no cache
 * to go stale, so the only way it can be wrong is if the derivation is, which is
 * what the cases below are for.
 */
import { describe, it, expect } from 'vitest';
import { libraryPageSummary, LIBRARY_PAGE_SUMMARY_CHARS } from '@salt/domain';

describe('libraryPageSummary — the opening of a note', () => {
  it('reads the first heading and the prose under it, as one line', () => {
    expect(
      libraryPageSummary({
        body: '# Sous vide times\n\nChuck steak goes in at 65 °C for 24 hours.\n',
      }),
    ).toBe('Sous vide times Chuck steak goes in at 65 °C for 24 hours.');
  });

  it('strips the markers the reader would never see rendered', () => {
    expect(
      libraryPageSummary({
        body: '## The **Weck** jars\n\n- The _tapered_ 1 L one holds `900 ml` of kraut\n',
      }),
    ).toBe('The Weck jars The tapered 1 L one holds 900 ml of kraut');
  });

  it('keeps a link’s words and drops its target', () => {
    expect(
      libraryPageSummary({ body: 'Lifted from [Serious Eats](https://example.com/chuck).' }),
    ).toBe('Lifted from Serious Eats.');
  });

  it('keeps an image’s alt text and drops its source', () => {
    expect(libraryPageSummary({ body: '![The 1 L jar](jar.png) is the tapered one.' })).toBe(
      'The 1 L jar is the tapered one.',
    );
  });

  it('leaves a link with an enormous target alone rather than scanning past the bound', () => {
    // The ceiling that keeps the strip linear rather than quadratic — see
    // `asProse`. Past it the raw markdown survives into the summary, which is the
    // shallow strip's stated failure mode and is far better than a body somebody
    // pasted in being able to make a chat turn crawl.
    const href = `https://example.com/${'a'.repeat(2100)}`;

    expect(libraryPageSummary({ body: `See [the table](${href}).` })).toContain('[the table](');
  });

  it('skips a horizontal rule and a table separator rather than printing dashes', () => {
    expect(
      libraryPageSummary({ body: '---\n\n| Cut | Temp |\n| --- | --- |\n| Chuck | 65 °C |\n' }),
    ).toBe('Cut Temp Chuck 65 °C');
  });

  it('skips a fenced code block and its contents', () => {
    expect(
      libraryPageSummary({ body: 'Timings:\n\n```\n65 26 24\n```\n\nAnd that is the table.' }),
    ).toBe('Timings: And that is the table.');
  });

  it('returns an empty string for a body with nothing readable in it', () => {
    expect(libraryPageSummary({ body: '' })).toBe('');
    expect(libraryPageSummary({ body: '\n\n---\n\n***\n' })).toBe('');
  });

  it('cuts a long note to the budget, on a word boundary, and marks the cut', () => {
    const summary = libraryPageSummary({ body: `A ${'jar '.repeat(200)}cupboard.` });

    expect(summary.length).toBeLessThanOrEqual(LIBRARY_PAGE_SUMMARY_CHARS + 1);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('cupboard');
    // A word boundary, not mid-word: every token before the ellipsis is whole.
    expect(summary.slice(0, -1).trim().split(' ').at(-1)).toBe('jar');
  });

  it('cuts mid-word when there is no word boundary near the end of the budget', () => {
    // A table row or a pasted URL can run for hundreds of characters unbroken.
    // Better a hard cut than a summary truncated back to its first few words.
    const summary = libraryPageSummary({ body: 'x'.repeat(400) });

    expect(summary).toBe(`${'x'.repeat(LIBRARY_PAGE_SUMMARY_CHARS)}…`);
  });

  it('leaves a note shorter than the budget exactly as written', () => {
    const body = 'Chuck: 65 °C, 24 h.';
    expect(libraryPageSummary({ body })).toBe(body);
  });

  it('stops reading once the budget is spent, however long the note is', () => {
    // The guarantee that makes a search over the whole library cheap: the cost of
    // a summary is bounded by the budget, not by the size of the page.
    const body = Array.from({ length: 500 }, (_, i) => `Line ${i} about jars.`).join('\n');
    expect(libraryPageSummary({ body }).length).toBeLessThanOrEqual(LIBRARY_PAGE_SUMMARY_CHARS + 1);
  });
});
