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
//  2. NO MARKUP SURVIVES. Since #1376 the library page passes `Markdown`'s
//     `sanitizedHtml` prop, so raw HTML in a body is PARSED and rendered through
//     `svgSanitizeSchema`'s allowlist rather than shown as escaped source: a
//     `<table>` that got through here would render as a table the person cannot
//     see in the text they are editing, and a `joplin-table-wrapper` div would
//     render as a div. (Before #1376 the same leak showed up as visible markup
//     source instead — different symptom, same defect, and the earlier wording of
//     this paragraph described that world.) Either way the requirement is
//     unchanged and is the whole reason this module exists: what a person
//     deliberately types is theirs, what a paste smuggled in is not. Three ways it
//     could get in: turndown keeping the text of an element it has no rule for
//     (`<script>`), the GFM plugin bailing out to `outerHTML` (the whole table —
//     from a cell OR from a `<caption>`, which the plugin scans too), and a
//     `<br>`/extra block child inside one cell forcing a re-escaped `<br>` back in.
//     All are covered below, and each was observed failing before the code that
//     stops it was written.

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

// A `javascript:` href survives the ordinary conversion and renders as a LIVE,
// clickable link — measured end to end against this PR's own code, and the repo
// carries no Content-Security-Policy anywhere to fall back on. Pasting from an
// untrusted page is precisely what this feature is for, so this is not a
// hypothetical: an allowlist on the converted link's scheme, applied to the DOM
// before turndown sees it — not a sanitiser and not `rehype-raw`.
describe('htmlToMarkdown — link schemes', () => {
  it('drops the href but keeps the text for a javascript: link', () => {
    const md = htmlToMarkdown('<a href="javascript:alert(document.cookie)">Click me</a>');
    expect(md).toBe('Click me');
    expect(md).not.toContain('javascript');
    expect(residualTags(md)).toEqual([]);
  });

  it('drops the href for a data: link too', () => {
    const md = htmlToMarkdown('<a href="data:text/html,hi">Open</a>');
    expect(md).toBe('Open');
    expect(md).not.toContain('data:');
  });

  it('keeps an ordinary http(s) link as a link', () => {
    const md = htmlToMarkdown('<a href="https://example.test/jars">Source</a>');
    expect(md).toBe('[Source](https://example.test/jars)');
  });

  it('keeps a mailto: link as a link', () => {
    const md = htmlToMarkdown('<a href="mailto:kitchen@example.test">Email</a>');
    expect(md).toBe('[Email](mailto:kitchen@example.test)');
  });

  it('keeps a relative link as a link', () => {
    const md = htmlToMarkdown('<a href="/recipes/sous-vide">Recipe</a>');
    expect(md).toBe('[Recipe](/recipes/sous-vide)');
  });

  // Fails CLOSED: an href the URL parser itself rejects (an empty host is one —
  // `new URL('http://', base)` throws) is treated as unsafe rather than let
  // through on a parse failure, the same "deny by default" the scheme allowlist
  // above is built on.
  it('drops a href the URL parser itself cannot make sense of', () => {
    const md = htmlToMarkdown('<a href="http://">Broken</a>');
    expect(md).toBe('Broken');
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

  // THE second raw-HTML route, and the one that shows up as visible markup rather
  // than a plausible-looking wrong result. `@joplin/turndown-plugin-gfm` emits
  // the table's `outerHTML` inside a `joplin-table-wrapper` div whenever a cell
  // holds a list, a heading, a rule, a blockquote or code (or a `<br>`, or more
  // than one block child — see `flattenLineBreaks` below) — and this app renders
  // that HTML as its own escaped source text, not as nothing. Remove the cell
  // flattening in `libraryImport.ts` and every assertion below goes red.
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

  // A nested table takes the plugin's OTHER bail-out, which emits no HTML — so the
  // no-markup property holds. What it does emit is the finding this test now pins:
  // not paragraphs, not a table, but every cell of both tables run together with no
  // separator whatsoever. `residualTags()` alone was green on that, which is how
  // the module comment came to claim "paragraphs" for two PRs running. Asserted
  // exactly, so changing the behaviour has to be a decision rather than a drift.
  it('collapses a nested table to run-on text — no markup, and no separator either', () => {
    const md = htmlToMarkdown(
      '<table><tr><td><table><tr><td>inner</td></tr></table></td><td>outer</td></tr></table>',
    );
    expect(residualTags(md)).toEqual([]);
    expect(md).toBe('innerouter');
  });

  // The third route in, and the one #1391 found: `tableShouldBeHtml` walks the
  // whole `<table>`, so block content in a `<caption>` trips the `outerHTML`
  // bail-out with every `<td>` already clean. Drop `caption` from `CELL_SELECTOR`
  // in `libraryImport.ts` and all three assertions below go red with a
  // `joplin-table-wrapper` div in the body.
  it('still produces a TABLE when the CAPTION holds a list, a heading or a rule', () => {
    const rows = '<tr><th>Stage</th><th>Time</th></tr><tr><td>Bulk</td><td>4 h</td></tr>';
    for (const caption of [
      '<ul><li>measured cold</li><li>fan off</li></ul>',
      '<h3>Times</h3>',
      'Times<hr>',
    ]) {
      const md = htmlToMarkdown(`<table><caption>${caption}</caption>${rows}</table>`);
      expect(residualTags(md)).toEqual([]);
      expect(md).toContain('| Stage | Time |');
    }
  });

  // Flattening a caption costs nothing, because turndown already emits a caption as
  // the paragraph above the table — so the text survives where the reader expects
  // it rather than being thrown away with the markup.
  it('keeps the caption text as the line above the table', () => {
    const md = htmlToMarkdown(
      '<table><caption><h3>Sous vide</h3></caption>' +
        '<tr><th>Cut</th><th>Time</th></tr><tr><td>Ribeye</td><td>2 h</td></tr></table>',
    );
    expect(md.split('\n')[0]).toBe('Sous vide');
    expect(md).toContain('| Cut | Time |');
  });

  // THE fix for the finding measured against this PR's own code: a cell holding a
  // `<br>`, or more than one block child, converts to a literal `<br>` in the
  // pipe cell rather than a table bail-out — `flattenTableCells` never touched
  // this route, because the newline does not come from a list, a heading, a rule
  // or a blockquote, it comes from the `<br>`/block itself. Div-wrapped and
  // `<br>`-separated cells are the ordinary shape of a copied
  // time-and-temperature table, not the edge case.
  it('flattens a <br> inside a cell instead of leaving a literal one', () => {
    const md = htmlToMarkdown(
      '<table><tr><td>Medium rare<br>Pink throughout</td><td>54 °C</td></tr></table>',
    );
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('Medium rare; Pink throughout');
  });

  it('flattens a cell with two <p> children instead of leaving embedded <br>s', () => {
    const md = htmlToMarkdown('<table><tr><td><p>one</p><p>two</p></td><td>x</td></tr></table>');
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('one; two');
  });

  it('flattens a cell with two <div> children the same way', () => {
    const md = htmlToMarkdown(
      '<table><tr><td><div>one</div><div>two</div></td><td>x</td></tr></table>',
    );
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('one; two');
  });

  // A single <p> wrapping a whole cell — the ordinary shape of a Google Docs
  // table — must not grow a stray leading separator, and inline formatting inside
  // it must survive (unlike the heading/list flattening above, which reduces to
  // bare text).
  it('keeps a single wrapping <p> plain, formatting and all', () => {
    const md = htmlToMarkdown('<table><tr><td><p><strong>Ribeye</strong></td></tr></table>');
    expect(residualTags(md)).toEqual([]);
    expect(md).toContain('**Ribeye**');
    expect(md).not.toMatch(/^;/);
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
