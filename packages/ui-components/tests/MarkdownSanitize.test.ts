// spec: ui-spec-v04.md §12
//
// The security control for `Markdown`'s `sanitizedHtml` prop (issue #1376).
//
// Salt serves NO Content-Security-Policy, so `svgSanitizeSchema` is the entire
// defence and this file is the only thing that checks it holds. Every hostile
// case below asserts on the RENDERED DOM rather than on the schema object: a
// schema that lists the right tag names and a pipeline that never applies it
// look identical from the outside, and only one of them is safe.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Markdown from '../src/primitives/Markdown/Markdown.svelte';

afterEach(() => cleanup());

/** Tag names and attributes below `container`, in document order. */
function outline(container: HTMLElement): string[] {
  return [...container.querySelectorAll('*')].map(
    (el) =>
      `${el.tagName}[${[...el.attributes]
        .map((attr) => `${attr.name}=${attr.value}`)
        .sort()
        .join(' ')}]`,
  );
}

/** Every attribute on every element below `container`, name-first. */
function allAttributeNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((attr) => attr.name),
  );
}

const DIAGRAM = [
  '<svg viewBox="0 0 100 60" width="200">',
  '  <rect x="10" y="10" width="40" height="40" fill="none" stroke="black" stroke-width="2" />',
  '  <path d="M60 10 L90 50" stroke="black" stroke-linecap="round" />',
  '  <text x="30" y="58" text-anchor="middle" font-size="6">jar</text>',
  '</svg>',
].join('\n');

describe('Markdown sanitizedHtml — off (the default)', () => {
  // The default is what every caller but the library has, and the chat renders
  // model output. If this pair ever goes green-by-accident the blast radius is
  // the whole app, so it is asserted on the same input the "on" cases use.
  it('leaves a diagram as visible source, not an element', () => {
    const { container } = render(Markdown, { props: { text: DIAGRAM } });
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('<svg viewBox="0 0 100 60"');
  });

  it('leaves a script tag as visible source, not an element', () => {
    const { container } = render(Markdown, {
      props: { text: '<script>window.pwned = 1;<\/script>' },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  // Turning the prop on must not change ordinary Markdown. Compared as ELEMENTS
  // and as text with the whitespace taken out — and that IS the claim's real
  // boundary, not a convenience: `rehype-raw` re-parses the tree through an HTML
  // parser, which discards the whitespace-only text nodes an HTML parser is
  // required to discard inside a `<table>`. Same elements, same attributes, same
  // words; different indentation between a table's cells.
  it('renders ordinary Markdown as the same elements whether the prop is on or off', () => {
    const text = '# Jars\n\n**Kilner** and _Le Parfait_\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    const off = render(Markdown, { props: { text } }).container;
    const offShape = [outline(off), off.textContent?.replace(/\s+/g, '')];
    cleanup();
    const on = render(Markdown, { props: { text, sanitizedHtml: true } }).container;
    expect([outline(on), on.textContent?.replace(/\s+/g, '')]).toEqual(offShape);
  });
});

describe('Markdown sanitizedHtml — on, benign diagram', () => {
  // This case is also the ORDER test. `rehype-sanitize` has no rule for a `raw`
  // node and discards it, so running it before `rehype-raw` leaves nothing to
  // parse and no `<svg>` element is ever built. Swapping the two entries in
  // `Markdown.svelte` was tried: it turns seven cases in this file red.
  it('renders the drawing as real elements', () => {
    const { container } = render(Markdown, { props: { text: DIAGRAM, sanitizedHtml: true } });
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 60');
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('none');
    expect(container.querySelector('path')?.getAttribute('d')).toBe('M60 10 L90 50');
    expect(container.querySelector('text')?.textContent).toBe('jar');
  });

  it('puts the drawing in the SVG namespace, so it paints rather than sits inert', () => {
    const { container } = render(Markdown, { props: { text: DIAGRAM, sanitizedHtml: true } });
    expect(container.querySelector('svg')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  // `stroke-width` arrives from `hast-util-raw` as the property `strokeWidth`,
  // and SVG attribute names are case-sensitive: without the rename the diagram
  // renders with default paint and nothing says so.
  it('keeps hyphenated presentation attributes in the name the browser reads', () => {
    const { container } = render(Markdown, { props: { text: DIAGRAM, sanitizedHtml: true } });
    expect(container.querySelector('rect')?.getAttribute('stroke-width')).toBe('2');
    expect(container.querySelector('path')?.getAttribute('stroke-linecap')).toBe('round');
    expect(container.querySelector('text')?.getAttribute('text-anchor')).toBe('middle');
    expect(container.querySelector('text')?.getAttribute('font-size')).toBe('6');
  });

  it('still renders the Markdown around the drawing', () => {
    const { container } = render(Markdown, {
      props: { text: `## Jar profile\n\n${DIAGRAM}\n\nMeasured cold.`, sanitizedHtml: true },
    });
    expect(container.querySelector('h2')?.textContent).toBe('Jar profile');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toContain('Measured cold.');
  });
});

describe('Markdown sanitizedHtml — on, hostile input', () => {
  const rendered = (text: string): HTMLElement =>
    render(Markdown, { props: { text, sanitizedHtml: true } }).container;

  it('strips <script>, content and all', () => {
    const container = rendered('<script>window.pwned = 1;<\/script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('window.pwned');
  });

  it('strips <script> nested inside an allowed drawing', () => {
    const container = rendered(`<svg viewBox="0 0 1 1"><script>window.pwned = 1;<\/script></svg>`);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('window.pwned');
  });

  it('strips <iframe>', () => {
    const container = rendered('<iframe src="https://example.com"></iframe>');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('strips <object>', () => {
    const container = rendered('<object data="https://example.com/x.swf"></object>');
    expect(container.querySelector('object')).toBeNull();
  });

  it('strips <embed>', () => {
    const container = rendered('<embed src="https://example.com/x.swf" />');
    expect(container.querySelector('embed')).toBeNull();
  });

  it('strips <foreignObject>, which would reopen the whole of HTML inside the drawing', () => {
    const container = rendered(
      '<svg viewBox="0 0 1 1"><foreignObject><iframe src="https://example.com"></iframe></foreignObject></svg>',
    );
    expect(container.querySelector('foreignObject')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('strips <use>, so an external reference cannot be pulled in', () => {
    const container = rendered(
      '<svg viewBox="0 0 1 1"><use href="https://evil.example/x.svg#a" /></svg>',
    );
    expect(container.querySelector('use')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
  });

  it('strips every on* handler, on drawings and on Markdown elements alike', () => {
    const container = rendered(
      [
        '<svg viewBox="0 0 1 1" onload="window.pwned = 1">',
        '<rect width="1" height="1" onclick="window.pwned = 1" onmouseover="window.pwned = 1" />',
        '</svg>',
        '',
        '<p onclick="window.pwned = 1">text</p>',
      ].join('\n'),
    );
    expect(allAttributeNames(container).filter((name) => /^on/i.test(name))).toEqual([]);
  });

  it('strips a javascript: href', () => {
    const container = rendered('<a href="javascript:window.pwned = 1">tap</a>');
    expect(container.querySelector('a[href]')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('strips a data: href', () => {
    const container = rendered('<a href="data:text/html;base64,PHNjcmlwdD4８">tap</a>');
    expect(container.querySelector('a[href]')).toBeNull();
    expect(container.innerHTML).not.toContain('data:text/html');
  });

  it('strips a style attribute, so url() and expression() have nowhere to live', () => {
    const container = rendered(
      '<svg viewBox="0 0 1 1"><rect width="1" height="1" style="background:url(https://evil.example/x)" /></svg>',
    );
    expect(allAttributeNames(container)).not.toContain('style');
  });

  it('strips an unlisted SVG element rather than passing it through', () => {
    const container = rendered(
      '<svg viewBox="0 0 1 1"><image href="https://evil.example/x.png" /><animate attributeName="x" /></svg>',
    );
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('animate')).toBeNull();
  });

  // `a` stays in `tagNames`/`attributes` (inherited from `defaultSchema`) so
  // ordinary Markdown links keep working — both are namespace-blind, so
  // without `stripSvgAnchors` this survives sanitising with its `href` intact
  // and turns the whole drawing into an off-site link with no CSP under it.
  it('unwraps a bare <a href> inside <svg>, dropping the element and its href', () => {
    const container = rendered(
      '<svg viewBox="0 0 100 100"><a href="https://evil.example/phish"><rect width="100" height="100" fill="none" /></a></svg>',
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
    // The wrapped content survives — only the anchor and its href are gone.
    expect(container.querySelector('rect')).not.toBeNull();
  });

  // The second route to the same place: `schema.strip` holds only `script`,
  // so `foreignObject` is unwrapped rather than dropped and promotes its
  // children — including an `<a>` — into the `<svg>` before `stripSvgAnchors`
  // ever runs. A walk of the tree AFTER sanitising catches it regardless.
  it('unwraps an <a> promoted into <svg> by a stripped <foreignObject>', () => {
    const container = rendered(
      '<svg viewBox="0 0 1 1"><foreignObject><a href="https://evil.example">x</a><b>bold</b></foreignObject></svg>',
    );
    expect(container.querySelector('foreignObject')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
    // The rest of what foreignObject wrapped is unaffected — only the anchor goes.
    expect(container.querySelector('b')?.textContent).toBe('bold');
  });

  // Regression guard: the fix above must not touch an ordinary link outside
  // any <svg> — that is every Markdown link on a surface that opts in.
  it('leaves an ordinary <a href> outside <svg> untouched', () => {
    const container = rendered('<a href="https://example.com">tap</a>');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });
});

describe('Markdown sanitizedHtml — the stated limits', () => {
  // The header comment on `svgSanitizeSchema.ts` claims internal `url(#id)`
  // references do NOT resolve, because the default schema prefixes ids to block
  // DOM clobbering. That is a limit, not a bug — and this is what stops it
  // quietly ceasing to be true.
  it('prefixes an id, so a marker or gradient reference cannot resolve', () => {
    const { container } = render(Markdown, {
      props: {
        text: '<svg viewBox="0 0 1 1"><defs><marker id="arrow"></marker></defs></svg>',
        sanitizedHtml: true,
      },
    });
    expect(container.querySelector('marker')?.getAttribute('id')).toBe('user-content-arrow');
  });

  // Not SVG-only, and the comment says so: `rehype-raw` parses every raw tag.
  it('renders an allowed HTML tag too, not only drawings', () => {
    const { container } = render(Markdown, {
      props: { text: 'a <b>bold</b> word', sanitizedHtml: true },
    });
    expect(container.querySelector('b')?.textContent).toBe('bold');
  });

  // THE PROTOCOL LIST IS THE DEFAULT'S, AND IT IS NARROWER THAN THE WEB (#1391).
  //
  // `defaultSchema.protocols.href` is `http, https, irc, ircs, mailto, xmpp` —
  // taking it unchanged was the right call for #1376, whose Definition of Done
  // names `javascript:` and `data:`, but it is not free and the PR body read as
  // though it were. Two links a person could reasonably write in a library page
  // lose their `href` and render as plain text:
  //
  //  - `tel:` is simply not on the list. Adding `'tel'` to a `protocols.href`
  //    override is the one-line fix IF that is ever wanted; it is deliberately not
  //    done here, because a phone link in a recipe page is a product decision with
  //    nothing asking for it, not a defect.
  //  - The match is CASE-SENSITIVE (`url.slice(0, protocol.length) === protocol`
  //    in `hast-util-sanitize@5`), so `HTTPS://` does not match `https`.
  //
  // The second one fails CLOSED, which is why it stays a nuisance rather than a
  // hole, and the third assertion below is the one that has to keep passing.
  it('drops a tel: link, and an uppercase scheme, back to plain text', () => {
    for (const href of ['tel:+441234567890', 'HTTPS://example.test/jars']) {
      const { container } = render(Markdown, {
        props: { text: `<a href="${href}">tap</a>`, sanitizedHtml: true },
      });
      expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
      expect(container.textContent).toContain('tap');
      cleanup();
    }
  });

  it('drops an UPPERCASE javascript: scheme too — the case-blindness fails closed', () => {
    const { container } = render(Markdown, {
      props: { text: '<a href="JAVASCRIPT:alert(1)">tap</a>', sanitizedHtml: true },
    });
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(container.innerHTML).not.toContain('alert');
  });
});
