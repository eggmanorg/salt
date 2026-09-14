<!-- spec: ai-kitchen-assistant.md §Surfaces v1.0 -->
<script lang="ts">
  import { Markdown as ExMarkdown, type Plugin } from 'svelte-exmarkdown';
  import { gfmPlugin } from 'svelte-exmarkdown/gfm';
  import rehypeRaw from 'rehype-raw';
  import rehypeSanitize from 'rehype-sanitize';
  import { cn } from '../../lib/cn';
  import { rehypeSvgAttributeCase, svgSanitizeSchema } from './svgSanitizeSchema';

  let {
    text,
    breaks = false,
    sanitizedHtml = false,
    class: className,
  }: { text: string; breaks?: boolean; sanitizedHtml?: boolean; class?: string } = $props();

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
  // `rehypeSvgAttributeCase` runs last and is presentation only.
  const plugins: Plugin[] = $derived(
    sanitizedHtml
      ? [
          gfmPlugin(),
          { rehypePlugin: rehypeRaw },
          { rehypePlugin: [rehypeSanitize, svgSanitizeSchema] },
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
</script>

<div class={cn('salt-md', className)}>
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
</style>
