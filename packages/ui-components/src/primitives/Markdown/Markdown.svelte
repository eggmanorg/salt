<!-- spec: ai-kitchen-assistant.md §Surfaces v1.0 -->
<script lang="ts">
  import { Markdown as ExMarkdown, type Plugin } from 'svelte-exmarkdown';
  import { gfmPlugin } from 'svelte-exmarkdown/gfm';
  import rehypeRaw from 'rehype-raw';
  import rehypeSanitize from 'rehype-sanitize';
  import { cn } from '../../lib/cn';
  import { rehypeSvgAttributeCase, stripSvgAnchors, svgSanitizeSchema } from './svgSanitizeSchema';

  let {
    text,
    breaks = false,
    sanitizedHtml = false,
    scale = 'note',
    class: className,
  }: {
    text: string;
    breaks?: boolean;
    sanitizedHtml?: boolean;
    scale?: 'note' | 'doc';
    class?: string;
  } = $props();

  // Raw HTML in a body is INERT by default and stays that way unless a caller
  // asks otherwise. `remark-rehype` keeps it as a `raw` node and the renderer
  // prints a `raw` node as its own escaped text, so `<svg>` typed into a recipe
  // note or arriving in a chef's reply shows up as visible markup source — never
  // as an element, and never as nothing. `sanitizedHtml` is what turns those raw
  // nodes into real elements, and it is opt-in precisely because the chat renders
  // model output: see `svgSanitizeSchema.ts` for what survives, what does not,
  // and why no CSP sits underneath it.
  //
  // ORDER IS LOAD-BEARING: `rehype-raw` parses the raw HTML, THEN
  // `rehype-sanitize` applies the allowlist to what it produced. Reversed, the
  // sanitiser discards the `raw` nodes it has no rule for and no drawing ever
  // renders — `MarkdownSanitize.test.ts` goes red in seven places.
  // `stripSvgAnchors` runs right after sanitising: it is the control that
  // keeps a URL-bearing `<a>` out of a drawing (`tagNames`/`attributes` can't,
  // being namespace-blind — see `svgSanitizeSchema.ts`). `rehypeSvgAttributeCase`
  // runs last and is presentation only.
  const plugins: Plugin[] = $derived(
    sanitizedHtml
      ? [
          gfmPlugin(),
          { rehypePlugin: rehypeRaw },
          { rehypePlugin: [rehypeSanitize, svgSanitizeSchema] },
          { rehypePlugin: stripSvgAnchors },
          { rehypePlugin: rehypeSvgAttributeCase },
        ]
      : [gfmPlugin()],
  );

  // CommonMark folds a lone newline into a space, so line-per-thought prose
  // (recipe notes) would run together the first time it were rendered as
  // Markdown. `breaks` opts a caller into treating every single newline as a
  // hard break instead, by appending the two-space hard-break marker ahead of
  // it — a pure string transform, so no second Markdown dependency and no
  // change to the AST → Svelte pipeline.
  //
  // Blank lines are deliberately left alone (`(?!\n)`): they keep their
  // CommonMark paragraph meaning, so a caller gets hard breaks *and* real
  // paragraphs rather than one flat block. CRLF is normalised first so the
  // marker lands after the text, not between the \r and the \n.
  function withHardBreaks(src: string): string {
    return src.replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1  \n');
  }

  const md = $derived(breaks ? withHardBreaks(text) : text);

  // `scale` is presentation only — it adds a second class to the one wrapper
  // div and changes nothing about parsing or the AST → Svelte pipeline. The
  // default `'note'` is the scale every caller had before the prop existed, so
  // adding it changed no surface. See the `salt-md-doc` block in the style
  // section below for what document proportions are and why the selectors are
  // written two class levels deep.
</script>

<div class={cn('salt-md', scale === 'doc' && 'salt-md-doc', className)}>
  <ExMarkdown {md} {plugins} />
</div>

<style>
  .salt-md :global(:first-child) {
    margin-top: 0;
  }
  .salt-md :global(:last-child) {
    margin-bottom: 0;
  }
  .salt-md :global(p) {
    margin: 0;
  }
  .salt-md :global(p + p) {
    margin-top: 0.5rem;
  }
  .salt-md :global(ul),
  .salt-md :global(ol) {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
  }
  .salt-md :global(ul) {
    list-style: disc;
  }
  .salt-md :global(ol) {
    list-style: decimal;
  }
  .salt-md :global(li) {
    margin: 0.125rem 0;
  }
  .salt-md :global(li > ul),
  .salt-md :global(li > ol) {
    margin: 0.125rem 0;
  }
  .salt-md :global(h1),
  .salt-md :global(h2),
  .salt-md :global(h3),
  .salt-md :global(h4),
  .salt-md :global(h5),
  .salt-md :global(h6) {
    font-weight: 600;
    line-height: 1.3;
    margin: 0.5rem 0 0.25rem;
  }
  .salt-md :global(h1) {
    font-size: 1.125rem;
  }
  .salt-md :global(h2) {
    font-size: 1.0625rem;
  }
  .salt-md :global(h3) {
    font-size: 1rem;
  }
  .salt-md :global(strong) {
    font-weight: 600;
  }
  .salt-md :global(em) {
    font-style: italic;
  }
  .salt-md :global(a) {
    text-decoration: underline;
  }
  .salt-md :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.875em;
    background: rgb(0 0 0 / 0.06);
    padding: 0.0625rem 0.25rem;
    border-radius: 0.25rem;
  }
  .salt-md :global(pre) {
    background: rgb(0 0 0 / 0.06);
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin: 0.5rem 0;
  }
  .salt-md :global(pre code) {
    background: none;
    padding: 0;
  }
  .salt-md :global(blockquote) {
    border-left: 3px solid currentColor;
    opacity: 0.85;
    padding-left: 0.75rem;
    margin: 0.5rem 0;
  }
  .salt-md :global(hr) {
    border: none;
    border-top: 1px solid currentColor;
    opacity: 0.2;
    margin: 0.5rem 0;
  }
  /* A drawing only exists when a caller passed `sanitizedHtml`, and it arrives
     with whatever `width` its author typed. Cap it at the column it is in and let
     the `viewBox` keep the proportions — here rather than in each consuming
     surface, because "do not overflow your container" is the renderer's job and
     the library already has three of those surfaces. */
  .salt-md :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .salt-md :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
  }
  .salt-md :global(th),
  .salt-md :global(td) {
    border: 1px solid currentColor;
    padding: 0.25rem 0.5rem;
  }

  /* ─── `scale="doc"` — document proportions ──────────────────────────────────
     Everything above is the note scale: a chat reply or a recipe note, sitting
     inside something else. A library page body IS the page, so it reads at
     document proportions instead — bigger headings, real paragraph margins, and
     a table that scrolls in its own box rather than widening the page. These
     override the rules above rather than replacing them; every declaration not
     restated here (code, blockquote, `th`/`td` borders, the `svg` cap) still
     comes from the note scale.

     TWO CLASS LEVELS, DELIBERATELY. Both classes land on the same wrapper div,
     so each rule beats its `.salt-md :global(…)` counterpart on SPECIFICITY and
     not on source order — a rule that won only by ordering would flip the first
     time the bundler reordered two stylesheets. Writing these as
     `.salt-md-doc :global(…)` would tie with the base rules and reintroduce
     exactly that fragility. */
  .salt-md.salt-md-doc :global(p) {
    margin: 0.75rem 0;
  }
  .salt-md.salt-md-doc :global(h1) {
    font-size: 1.5rem;
    margin: 1.25rem 0 0.5rem;
  }
  .salt-md.salt-md-doc :global(h2) {
    font-size: 1.25rem;
    margin: 1.25rem 0 0.5rem;
  }
  .salt-md.salt-md-doc :global(h3) {
    font-size: 1.0625rem;
    margin: 1rem 0 0.375rem;
  }
  .salt-md.salt-md-doc :global(ul),
  .salt-md.salt-md-doc :global(ol) {
    margin: 0.75rem 0;
  }
  .salt-md.salt-md-doc :global(li) {
    margin: 0.25rem 0;
  }
  /* A jar table is the point of the library, and a phone is narrower than one.
     The table scrolls inside its own box rather than widening the page — the
     one sanctioned horizontal scroller on a Salt surface. */
  .salt-md.salt-md-doc :global(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
  }
</style>
