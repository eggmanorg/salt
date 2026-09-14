import { describe, it, expect } from 'vitest';
import { LIBRARY_PAGE_BODY_MAX } from '@salt/domain/schemas';
import { appendedBody, htmlToMarkdown } from '../src/lib/libraryImport.js';

// Converting a chunk of a website into a library page (issue #1375, Phase 2).
//
// Pure functions, no DOM event and no sheet — which is why `htmlToMarkdown` exists
// as its own module rather than living inside the paste handler.
//
// TWO PROPERTIES carry this feature and both are asserted from the outside rather
// than trusted:
//
//  1. A TABLE ARRIVES AS A TABLE. Tables are the entire point; a converter that
//     dropped them would be pointless and would still look like it worked on the
//     prose either side.
//  2. NO MARKUP SURVIVES. The renderer has no `rehype-raw`, so HTML in a body is
//     not dangerous — it is INVISIBLE, which is worse to diagnose. Two ways it
//     could get in: turndown keeping the text of an element it has no rule for
//     (`<script>`), and the GFM plugin bailing out to `outerHTML` for a table it
//     cannot express as pipes. Both are covered below, and both were observed
//     failing before the code that stops them was written.

/** Every HTML tag left in a converted body. Empty is the only acceptable answer. */
function residualTags(markdown: string): string[] {
  return markdown.match(/<\/?[a-z][^>]*>/gi) ?? [];
}

describe('htmlToMarkdown — a table off a website', () => {
  // A real fragment's shape: thead/tbody, inline formatting, entities.
  const SOUS_VIDE = `
    <table>
      <thead><tr><th>Cut</th><th>Temperature</th><th>Time</th></tr></thead>
      <tbody>
        <tr><td><strong>Ribeye</strong></td><td>54&nbsp;&deg;C</td><td>1&ndash;4 h</td></tr>
        <tr><td>Chuck</td><td>65 &deg;C</td><td><em>24 h</em></td></tr>
      </tbody>
    </table>`;

  it('converts it to a GFM pipe table, header row and all', () => {
    const md = htmlToMarkdown(SOUS_VIDE);
    const lines = md.split('\n').filter((l) => l.trim() !== '');
    expect(lines[0]).toMatch(/^\|\s*Cut\s*\|\s*Temperature\s*\|\s*Time\s*\|$/);
    expect(lines[1]).toMatch(/^\|\s*---/);
    expect(lines[2]).toContain('**Ribeye**');
    expect(lines[3]).toContain('_24 h_');
  });

  it('keeps the degree signs and dashes rather than the entities', () => {
    const md = htmlToMarkdown(SOUS_VIDE);
    expect(md).toContain('°C');
    expect(md).not.toContain('&deg;');
    expect(md).not.toContain('&nbsp;');
  });

  it('leaves no markup behind', () => {
    expect(residualTags(htmlToMarkdown(SOUS_VIDE))).toEqual([]);
  });
});

describe('htmlToMarkdown — headings, lists and links', () => {
  it('converts a heading/list fragment to markdown', () => {
    const md = htmlToMarkdown(
      '<h2>Weck jars</h2><p>What each one holds.</p>' +
        '<ul><li>742 — <em>580 g</em></li><li>744</li></ul>' +
        '<p><a href="https://example.test/jars">Source</a></p>',
    );
    expect(md).toContain('## Weck jars');
    expect(md).toMatch(/^- +742 — _580 g_$/m);
    expect(md).toContain('[Source](https://example.test/jars)');
    expect(residualTags(md)).toEqual([]);
  });

  it('uses the same markdown dialect the body editor tells Daniel to type', () => {
    const md = htmlToMarkdown('<h1>Title</h1>');
    // ATX, not Setext — `# Title`, never `Title\n=====`.
    expect(md).toBe('# Title');
  });
});

describe('htmlToMarkdown — what must not survive', () => {
  // Turndown's default for an element it has no rule for is to keep the CONTENTS
  // and drop the tag, so without an explicit `remove` the script body arrives as
  // a paragraph of JavaScript. Measured: it converts to `alert(1)`.
  it('takes a <script> away with its contents, not just its tags', () => {
    const md = htmlToMarkdown('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(md).not.toContain('alert');
    expect(md).toContain('before');
    expect(md).toContain('after');
  });

  it('drops an <iframe> entirely', () => {
    const md = htmlToMarkdown('<p>before</p><iframe src="https://evil.test"></iframe>');
    expect(md).not.toContain('evil.test');
    expect(residualTags(md)).toEqual([]);
  });

  it('drops styles, media and inline SVG rather than pasting their text in', () => {
    const md = htmlToMarkdown(
      '<style>.a{color:red}</style><p>kept</p>' +
        '<svg><title>chart</title></svg><video><source src="v.mp4"></video>',
    );
    expect(md).toBe('kept');
  });

  // THE second raw-HTML route, and the one that is invisible rather than merely
  // wrong. `@joplin/turndown-plugin-gfm` emits the table's `outerHTML` inside a
  // `joplin-table-wrapper` div whenever a cell holds a list, a heading, a rule, a
  // blockquote or code — and this app renders that as nothing at all. Remove the
  // cell flattening in `libraryImport.ts` and every assertion below goes red.
  it('still produces a TABLE when a cell holds a list', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>Stage</th><th>Notes</th></tr></thead>' +
        '<tbody><tr><td>Bulk</td><td><ul><li>fold at 30</li><li>fold at 60</li></ul></td></tr></tbody></table>',
    );
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('| Stage | Notes |');
    expect(md).toContain('fold at 30; fold at 60');
  });

  it('still produces a TABLE when a cell holds a heading, a rule or code', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>A</th><th>B</th></tr>' +
        '<tr><td><h3>Proof</h3><hr></td><td><code>54C</code></td></tr></table>',
    );
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('Proof');
    expect(md).toContain('54C');
  });

  it('leaves no markup behind for a nested table either', () => {
    const md = htmlToMarkdown(
      '<table><tr><td><table><tr><td>inner</td></tr></table></td><td>outer</td></tr></table>',
    );
    expect(residualTags(md)).toEqual([]);
  });

  // Total over strings: `text/html` parsing recovers from anything, which is what
  // makes it a browser parser, so there is no failure mode to catch.
  it('comes back with a string for anything, including nonsense', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('<<<>>>')).toEqual(expect.any(String));
    expect(htmlToMarkdown('<p>unclosed<div><span>')).toEqual(expect.any(String));
  });
});

describe('appendedBody', () => {
  it('separates the old text and the new with a blank line', () => {
    expect(appendedBody('First.', '## Second')).toBe('First.\n\n## Second');
  });

  it('adds no leading blank line to a page that had nothing in it', () => {
    expect(appendedBody('', '## Second')).toBe('## Second');
    expect(appendedBody('   \n\n ', '## Second')).toBe('## Second');
  });

  it('does not stack blank lines on a body that already ended in one', () => {
    expect(appendedBody('First.\n\n\n', 'Second')).toBe('First.\n\nSecond');
  });

  // The sheet measures the refusal with this, and `appendToLibraryPage` writes
  // what it returns — one arithmetic, so the screen cannot offer an append the
  // write then refuses.
  it('is what decides whether an import fits inside the body maximum', () => {
    const existing = 'x'.repeat(LIBRARY_PAGE_BODY_MAX - 10);
    expect(appendedBody(existing, 'y'.repeat(7)).length).toBe(LIBRARY_PAGE_BODY_MAX - 1);
    expect(appendedBody(existing, 'y'.repeat(9)).length).toBeGreaterThan(LIBRARY_PAGE_BODY_MAX);
  });
});
