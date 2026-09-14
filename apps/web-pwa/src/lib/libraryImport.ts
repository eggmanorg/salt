import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

// Turning a chunk of somebody else's web page into a library page (issue #1375).
//
// THE OUTPUT IS MARKDOWN AND ONLY MARKDOWN. The renderer has no `rehype-raw`, so
// HTML in a page body is inert rather than dangerous — but inert does not mean
// invisible: `svelte-exmarkdown` emits a `raw` hast node as its own escaped text
// (`Renderer.svelte`'s `raw` arm), so a pasted `<table>` that survived conversion
// would show up on the page as visible markup, not vanish. Everything below
// exists so the conversion either produces markdown or produces text, never a
// lump of markup that renders as its own source.
//
// It also keeps the epic's Phase 3 decision — whether to render raw HTML behind an
// allowlist — independent of this one: no import can put raw HTML into a body, so
// that decision is about what a person types, not about what a paste smuggled in.
//
// DOM work lives here in web-pwa, never in `@salt/domain` (Rule 1): the conversion
// parses with the browser's own parser.

// Elements whose TEXT must not survive either.
//
// Turndown's default for an element it has no rule for is "drop the tag, keep the
// contents", which is right for a `<span>` and catastrophic for a `<script>`: the
// JavaScript lands in the page as a paragraph. Measured, not assumed — without
// this list `<script>alert(1)</script>` converts to the paragraph `alert(1)`.
// `remove()` is the only thing that takes the contents with the tag.
//
// Deliberately short. This is NOT a sanitiser and does not need to be, since
// nothing downstream renders HTML; it is the list of elements whose text is not
// prose, so what lands reads like the page somebody copied.
// A Set behind a predicate rather than turndown's tag-name array, because `svg`
// is not an `HTMLElementTagNameMap` key and the array form is typed as that —
// inline SVG is exactly the sort of thing a copied web page carries.
const DROP_WITH_CONTENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'audio',
  'video',
]);

// A markdown pipe table's cell is a single line of inline content: it cannot hold
// a list, a heading, a rule or a code block. The GFM plugin's answer to a table
// that does is to emit the table's `outerHTML` inside a `joplin-table-wrapper`
// div — raw HTML, which this app renders as its own visible markup rather than
// dropping it, on exactly the time-and-temperature tables this feature exists
// for.
//
// So the block content is flattened out of the cells BEFORE turndown sees them,
// which is the only faithful thing available: markdown has no cell that could hold
// it. A `<br>`, or more than one block child (`<p><p>`, `<div><div>`), gets
// flattened the same way, by `flattenLineBreaks` below: turndown converts either
// into an embedded newline, and the GFM plugin's `cell()` re-escapes any newline
// it finds in a cell back into a literal `<br>` tag rather than leave the row
// broken — the same raw-HTML route through a different door. Afterwards no
// bail-out condition is left — the plugin's others are a nested table (which it
// renders as paragraphs, not HTML) and `preserveTableStyles`, which is off.
// `tests/libraryImport.test.ts` asserts no tag survives, so this stays true rather
// than merely being believed.
const CELL_LISTS = 'ul, ol';
const CELL_BLOCKS = 'h1, h2, h3, h4, h5, h6, blockquote, pre, code';

// The one `??` in this module, in one place rather than at each call site.
// `textContent` is typed `string | null` on `Node` and is null only for a
// `Document` or a `DocumentType` — never for the elements below — so the fallback
// is unreachable rather than defensive, and is written once for that reason.
function textOf(element: Element): string {
  return (element.textContent ?? '').trim();
}

// A `<br>`, or more than one block child (`<p><p>`, `<div><div>`) — the ordinary
// shape of a table cell copied out of Google Docs, or a time-and-temperature cell
// typed with a line break — converts to an embedded newline in turndown's own
// output: a `<br>` becomes a literal `\n`, and a second `<p>`/`<div>` gets its own
// blank-line paragraph. `CELL_LISTS`/`CELL_BLOCKS` above never see it, because
// nothing there matches a `<br>`, a `<p>` or a `<div>`. The GFM plugin's `cell()`
// then re-escapes that embedded newline back into a literal `<br>` tag so the pipe
// row still parses — which is exactly the raw HTML this module exists to keep out
// (see the module header).
//
// So the line break is removed the same way the blocks above are: before turndown
// ever sees it. UNWRAPPING rather than reducing to bare text (unlike the
// heading/list case above), so a `<strong>`/`<a>` inside the paragraph keeps its
// formatting instead of losing it — this is the ordinary shape of a pasted table,
// not the edge case the block/list flattening exists for.
function flattenLineBreaks(doc: Document, cell: Element): void {
  for (const br of cell.querySelectorAll('br')) {
    br.replaceWith(doc.createTextNode('; '));
  }
  for (const block of cell.querySelectorAll('p, div')) {
    const separator = block.previousSibling === null ? [] : [doc.createTextNode('; ')];
    block.replaceWith(...separator, ...block.childNodes);
  }
}

function flattenTableCells(doc: Document): void {
  for (const cell of doc.querySelectorAll('td, th')) {
    // Lists first: one inside a blockquote must become its items, not the
    // blockquote's run-together text.
    for (const list of cell.querySelectorAll(CELL_LISTS)) {
      const items = [...list.querySelectorAll('li')].map(textOf).filter((text) => text !== '');
      list.replaceWith(doc.createTextNode(items.join('; ')));
    }
    for (const block of cell.querySelectorAll(CELL_BLOCKS)) {
      block.replaceWith(doc.createTextNode(textOf(block)));
    }
    for (const rule of cell.querySelectorAll('hr')) rule.remove();
    flattenLineBreaks(doc, cell);
  }
}

// A `javascript:` (or `data:`, `vbscript:`, ...) href converts cleanly to a
// markdown link and renders as a LIVE, clickable link — `mdast-util-to-hast`
// normalises the URI but does not filter schemes, and the repo carries no
// Content-Security-Policy anywhere. Pasting from an untrusted page is precisely
// what this feature is for, so this is an ALLOWLIST rather than a denylist: only
// `http:`, `https:` and `mailto:` survive (a relative href, e.g. `/recipe` or
// `#note`, resolves against that allowed base and survives too). Everything else
// loses its `href` before turndown ever sees the element — with the attribute
// gone, turndown's own link rule no longer matches the `<a>`, so it falls to the
// same "drop the tag, keep the contents" default `DROP_WITH_CONTENTS` above
// exists to override — which here is exactly right: the link's TEXT survives with
// no way to click it anywhere. This is a URL-scheme check on the HTML→Markdown
// conversion, not the rendering-side sanitiser or `rehype-raw` the issue rules
// out.
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function hasSafeScheme(href: string): boolean {
  try {
    return SAFE_LINK_SCHEMES.has(new URL(href, 'https://salt.invalid/').protocol);
  } catch {
    return false;
  }
}

function stripUnsafeLinks(doc: Document): void {
  for (const link of doc.querySelectorAll('a[href]')) {
    if (!hasSafeScheme(link.getAttribute('href') ?? '')) link.removeAttribute('href');
  }
}

// One service, built once. Constructing a `TurndownService` compiles its rule set,
// and the preview converts on every keystroke of an edited paste.
//
// `headingStyle: 'atx'` and `bulletListMarker: '-'` because that is what the body
// editor's own placeholder tells Daniel to type — an import that produced
// `Setext\n=====` headings would be markdown he did not recognise as his own.
const service = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});
service.use(gfm);
service.remove((node) => DROP_WITH_CONTENTS.has(node.nodeName.toLowerCase()));

/**
 * A chunk of HTML as markdown — headings, lists, emphasis, links and GFM tables.
 *
 * Total over strings, which is why there is no `try`/`catch` here: `text/html`
 * parsing has no failure mode (the parser recovers from anything, which is what
 * makes it a browser), and `turndown` throws only for an input that is not a
 * string, which the signature already excludes. An empty string in is an empty
 * string out.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  stripUnsafeLinks(doc);
  flattenTableCells(doc);
  return service.turndown(doc.body.innerHTML).trim();
}

/**
 * The body that appending `markdown` to `existing` would produce — a blank line
 * between them, and no leading blank line on a page that had nothing in it.
 *
 * ONE PLACE, TWO READERS. The import sheet measures this against
 * `LIBRARY_PAGE_BODY_MAX` to decide whether to offer the append at all, and
 * `appendToLibraryPage` builds the document it writes from it. Two copies of the
 * arithmetic would let the screen offer an append the write then refuses.
 */
export function appendedBody(existing: string, markdown: string): string {
  const base = existing.replace(/\s+$/, '');
  return base === '' ? markdown : `${base}\n\n${markdown}`;
}
