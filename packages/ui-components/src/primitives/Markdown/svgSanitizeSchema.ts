// spec: ai-kitchen-assistant.md §Surfaces v1.0
import { defaultSchema, type Schema } from 'hast-util-sanitize';
import type { DocTone } from '../DocBlocks/DocBlocks.types';

/**
 * The allowlist behind `Markdown`'s `sanitizedHtml` prop — and the whole of the
 * defence.
 *
 * ─── THERE IS NO CONTENT-SECURITY-POLICY UNDER THIS ─────────────────────────
 *
 * Salt serves no CSP: `firebase.json` carries only `Cache-Control`, and
 * `apps/web-pwa/index.html` has no CSP `<meta>` (verified 2026-09-14, issue
 * #1376). Nothing backstops this schema. If a `<script>` or an `on*` handler
 * reaches the rendered DOM through it, it runs, with the signed-in user's
 * Firestore credentials in the same page. That is why the hostile-input cases in
 * `tests/MarkdownSanitize.test.ts` are the control and not a formality: they go
 * red the moment one of them gets through.
 *
 * ─── HOW IT WORKS ───────────────────────────────────────────────────────────
 *
 * `rehype-raw` parses the raw HTML that `remark-rehype`'s `allowDangerousHtml`
 * leaves in the tree as inert `raw` nodes, turning it into real elements;
 * `rehype-sanitize` then applies this schema to those elements. **The order is
 * absolute**, and `Markdown.svelte` is where it lives. Swap the two and
 * `rehype-sanitize` meets `raw` nodes it has no rule for and discards them, so
 * nothing this feature exists for renders at all — seven cases in
 * `MarkdownSanitize.test.ts` go red, verified by actually swapping them. In a
 * pipeline that carried raw HTML any other way the same mistake would be the
 * silent one instead, which is why the order is written down here as well.
 *
 * This EXTENDS `hast-util-sanitize`'s default schema rather than replacing it.
 * The default already carries the protocol handling (`href` may be http, https,
 * mailto, irc, ircs or xmpp — never `javascript:` and never `data:`), the
 * `script` strip and the `id`/`name` clobber-prefixing that a hand-written
 * schema gets subtly and silently wrong.
 *
 * ─── WHAT IT DOES NOT BUY YOU ───────────────────────────────────────────────
 *
 * Three limits worth stating plainly rather than discovering:
 *
 *  1. **It is not SVG-only.** `rehype-raw` parses every raw HTML tag, not just
 *     `<svg>`, so a `<b>` or a `<table>` typed into the body of a surface that
 *     opts in now renders as an element instead of as escaped source. What the
 *     schema controls is which elements survive, and the default's list is a
 *     benign subset of what Markdown itself already produces.
 *  2. **Internal `url(#id)` references do not resolve.** The default schema
 *     prefixes every `id` with `user-content-` to block DOM clobbering, and
 *     nothing rewrites the reference pointing at it. So `<marker>` and gradient
 *     reuse are expressible and non-functional; a diagram is geometry and text.
 *     `MarkdownSanitize.test.ts` pins that rewrite, so the limit cannot quietly
 *     stop being true.
 *  3. **The protocol list is narrower than the web, and case-sensitive.** Taking
 *     `defaultSchema.protocols` unchanged is the right trade — a hand-written
 *     list is how `javascript:` gets let back in — but it is not free, and #1391
 *     asked for the price to be written down rather than implied. `href` allows
 *     `http, https, irc, ircs, mailto, xmpp` and nothing else, so a `tel:` link a
 *     person typed into a library page renders as plain text; and the check is
 *     `url.slice(0, protocol.length) === protocol`, so `HTTPS://example.test`
 *     does not match `https` and loses its `href` too. Both fail CLOSED, which is
 *     what keeps them nuisances instead of holes — an uppercase `JAVASCRIPT:` is
 *     dropped by the same case-blindness. `MarkdownSanitize.test.ts` pins all
 *     three, including that last one. Widening this is one `protocols.href`
 *     override away if `tel:` is ever wanted; it is a product call, not a fix.
 *
 * ─── COLOUR IS A TONE ───────────────────────────────────────────────────────
 *
 * A drawing's `fill` and `stroke` take a tone name or `none` and nothing else
 * (`SVG_PAINTS`, issue #1663) — the library's "Salt's colours, never arbitrary
 * ones", made mechanical rather than asked for in a prompt. It is a DESIGN
 * control, not a security one: no paint value runs anything. It reaches only
 * these two attributes, and only on what passes through this schema — the
 * `salt-*` block primitives draw from validated data and never come here.
 */

/**
 * Presentation attributes whose hast property name IS the attribute name.
 *
 * Split from the hyphenated ones below because those two sets need different
 * handling, and the split is what keeps the allowlist and the rename in step:
 * an attribute built from `PAINT_HYPHENATED` or `TYPE_HYPHENATED` cannot be
 * allowed and then left un-renamed. That guarantee stops at those two sets —
 * it does not reach `defaultSchema.attributes['*']`, which every SVG tag also
 * inherits and which is DOM-IDL-cased too. `tabindex` is the example: it
 * reaches the DOM as `tabIndex`, is not in `KEBAB_ATTRIBUTES`, and SVG ignores
 * an attribute by that name — a drawing that should be focusable silently
 * isn't. Cosmetic, not a security hole, but stated here rather than implied.
 */
const PAINT_PLAIN = ['opacity', 'transform'] as const;

/**
 * The only values `fill` and `stroke` keep: the five tone names a document
 * block takes (`DocTone`), and `none`. A `Record` over `DocTone` rather than a
 * written-out list, so a sixth tone is a compile error here until it is added.
 *
 * A tone name is not a colour the browser understands, so on its own it paints
 * nothing: `Markdown.svelte`'s style block maps each one to its design token
 * with an attribute selector (`[fill='sage']`), which is how a drawing gets
 * Salt's colours with no `style` or `class` attribute on this allowlist.
 * `MarkdownSanitize.test.ts` checks that block has a rule for every name here.
 */
const TONE_PAINTS: Record<DocTone, true> = {
  primary: true,
  sage: true,
  terracotta: true,
  warning: true,
  muted: true,
};
export const SVG_PAINTS: readonly string[] = [...Object.keys(TONE_PAINTS), 'none'];

/** What a paint that is not in `SVG_PAINTS` becomes, and what a drawing inks with when it names none. */
export const SVG_DEFAULT_PAINT: DocTone = 'muted';

type PropertyDefinition = NonNullable<Schema['attributes']>[string][number];

/** `fill` and `stroke`, each allowed only with a value from `SVG_PAINTS`. */
const PAINT_TONED: PropertyDefinition[] = [
  ['fill', ...SVG_PAINTS],
  ['stroke', ...SVG_PAINTS],
];

/**
 * Hast property name → the SVG attribute name the browser actually reads.
 *
 * Written out rather than derived by kebab-casing: `strokeLineCap` is
 * `stroke-linecap`, not `stroke-line-cap`, and the same trap sits under
 * `stroke-linejoin` and `stroke-dasharray`. A mechanical rule gets all three
 * wrong and nothing complains — the attribute is simply ignored.
 */
const PAINT_HYPHENATED = {
  fillOpacity: 'fill-opacity',
  strokeOpacity: 'stroke-opacity',
  strokeWidth: 'stroke-width',
  strokeLineCap: 'stroke-linecap',
  strokeLineJoin: 'stroke-linejoin',
  strokeDashArray: 'stroke-dasharray',
} as const;

/** Type only, on `text` and `tspan`. */
const TYPE_HYPHENATED = {
  textAnchor: 'text-anchor',
  dominantBaseline: 'dominant-baseline',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  fontFamily: 'font-family',
  fontStyle: 'font-style',
} as const;

const PRESENTATION: PropertyDefinition[] = [
  ...PAINT_TONED,
  ...PAINT_PLAIN,
  ...Object.keys(PAINT_HYPHENATED),
];
const TYPE_SETTING = Object.keys(TYPE_HYPHENATED);

/**
 * The drawing elements. Deliberately absent from this list, and to stay
 * absent: `script`, `iframe`, `object`, `embed`, `foreignObject`, `use`,
 * `image` and `animate` — `use` and `image` because both take a URL, and
 * `foreignObject` because it reopens the whole of HTML inside a subtree the
 * schema was narrowed for.
 *
 * `<a>` cannot be handled the same way. `tagNames` and `attributes` are
 * namespace-blind, so the `a` this schema inherits from `defaultSchema` —
 * needed for every ordinary Markdown link on a surface that opts in — is
 * exactly as reachable inside an `<svg>` subtree as outside one: leaving it
 * off this list buys nothing, and dropping it from `defaultSchema.tagNames`
 * would kill ordinary links too, not just the SVG case. `stripSvgAnchors`,
 * below, is the actual control: it runs AFTER sanitising and unwraps any `<a>`
 * found inside an `<svg>` subtree, keeping its children and discarding the
 * element and its `href` — however the `<a>` got there. That "however"
 * matters: `schema.strip` holds only `script`, so `foreignObject` is unwrapped
 * rather than dropped and promotes its children into the `<svg>` before this
 * ever runs, and a walk of the FINAL tree catches an `<a>` that arrived that
 * way exactly as it catches one written directly inside an `<svg>`.
 */
const SVG_TAGS = [
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'marker',
  'title',
  'desc',
] as const;

export const svgSanitizeSchema: Schema = {
  ...defaultSchema,
  // `!` rather than `?? []`: `Schema` types every field optional, the default
  // schema populates this one, and a fallback arm that cannot run is a branch no
  // test can reach.
  tagNames: [...defaultSchema.tagNames!, ...SVG_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    // `viewBox` is case-sensitive and is the attribute most often lost to an
    // allowlist that lower-cases; `width`, `height`, `id` and `title` arrive
    // from the default's `*` list.
    svg: ['viewBox', 'preserveAspectRatio', ...PRESENTATION],
    g: [...PRESENTATION],
    path: ['d', ...PRESENTATION],
    rect: ['x', 'y', 'rx', 'ry', ...PRESENTATION],
    circle: ['cx', 'cy', 'r', ...PRESENTATION],
    ellipse: ['cx', 'cy', 'rx', 'ry', ...PRESENTATION],
    line: ['x1', 'y1', 'x2', 'y2', ...PRESENTATION],
    polyline: ['points', ...PRESENTATION],
    polygon: ['points', ...PRESENTATION],
    text: ['x', 'y', 'dx', 'dy', ...PRESENTATION, ...TYPE_SETTING],
    tspan: ['x', 'y', 'dx', 'dy', ...PRESENTATION, ...TYPE_SETTING],
  },
};

/**
 * The rename table applied after sanitising.
 *
 * `hast-util-raw` names properties the DOM-IDL way, so `stroke-width` reaches
 * this schema as `strokeWidth` — and `svelte-exmarkdown`'s renderer spreads
 * property names onto the element verbatim (it rewrites `className` and `aria*`
 * and nothing else). SVG attribute names are case-sensitive, so a `strokeWidth`
 * attribute is not `stroke-width`: it is silently ignored and the diagram
 * renders with default paint. Hence the rename.
 */
const KEBAB_ATTRIBUTES: Record<string, string> = {
  ...PAINT_HYPHENATED,
  ...TYPE_HYPHENATED,
};

type MaybeElement = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown;
};

const SVG_TAG_SET = new Set<string>(SVG_TAGS);

/**
 * Rename the sanitised SVG properties to the attribute names the browser reads.
 *
 * Runs AFTER `rehype-sanitize`, never before: it is a naming adapter and not a
 * security control, and moving it earlier would hand the schema property names
 * it does not list. Scoped to the SVG tags above, so no HTML element's
 * attributes are touched.
 */
export function rehypeSvgAttributeCase() {
  return (tree: unknown): void => {
    const visit = (node: MaybeElement): void => {
      // `String(...)` and not `?? ''` for the same reason as the `!` above: an
      // element always has a tag name, so the fallback arm is unreachable.
      if (node.type === 'element' && node.properties && SVG_TAG_SET.has(String(node.tagName))) {
        for (const [from, to] of Object.entries(KEBAB_ATTRIBUTES)) {
          if (from in node.properties) {
            node.properties[to] = node.properties[from];
            delete node.properties[from];
          }
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child as MaybeElement);
      }
    };
    visit(tree as MaybeElement);
  };
}

const PAINT_SET = new Set(SVG_PAINTS);

/**
 * Turn every paint that is not a tone into the default tone, and give a drawing
 * that names no `fill` the default as its ink.
 *
 * Runs BEFORE `rehype-sanitize`, the one plugin that does: after it, a paint the
 * schema refused is already gone and there is nothing left to replace. The
 * sanitiser alone would DROP the value, leaving the browser's own default —
 * black for a fill, and NO stroke at all, so a line drawn in `#333` would
 * vanish from the page. Here it is drawn in `SVG_DEFAULT_PAINT` instead.
 *
 * Not a security control, and it adds nothing the schema does not then check:
 * it writes only a constant, into two attributes the schema still narrows to
 * `SVG_PAINTS`. Take it out and no colour gets through — lines just go missing.
 * An absent `stroke` is left absent: no outline is a shape, not a colour.
 */
export function rehypeToneOnlyPaint() {
  return (tree: unknown): void => {
    const visit = (node: MaybeElement): void => {
      if (node.type === 'element' && SVG_TAG_SET.has(String(node.tagName))) {
        // `!`: a hast element always carries `properties`; `MaybeElement` only
        // types it optional, and a fallback arm here could never run.
        const properties = node.properties!;
        for (const name of ['fill', 'stroke']) {
          if (name in properties && !PAINT_SET.has(String(properties[name]))) {
            properties[name] = SVG_DEFAULT_PAINT;
          }
        }
        if (node.tagName === 'svg' && !('fill' in properties)) {
          properties.fill = SVG_DEFAULT_PAINT;
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child as MaybeElement);
      }
    };
    visit(tree as MaybeElement);
  };
}

/**
 * Unwrap any `<a>` found inside an `<svg>` subtree — the security control
 * that `tagNames`/`attributes` cannot provide, because both are
 * namespace-blind and `a` has to stay allowed globally for ordinary Markdown
 * links (see the comment on `SVG_TAGS`). Keeps the anchor's children, drops
 * the element and its `href` — the same "children survive, the wrapper does
 * not" shape `hast-util-sanitize` already applies to every disallowed element
 * but `script`.
 *
 * Runs AFTER `rehype-sanitize`, on the tree sanitising already produced, so it
 * catches an `<a>` regardless of how it ended up inside the `<svg>`: written
 * there directly, or promoted when a `foreignObject` wrapping it was unwrapped
 * out from under it.
 */
export function stripSvgAnchors() {
  return (tree: unknown): void => {
    const visit = (node: MaybeElement, insideSvg: boolean): void => {
      if (!Array.isArray(node.children)) return;
      const children = node.children as MaybeElement[];
      const kept: MaybeElement[] = [];
      for (const child of children) {
        const childInsideSvg = insideSvg || child.tagName === 'svg';
        visit(child, childInsideSvg);
        if (childInsideSvg && child.tagName === 'a') {
          kept.push(...(child.children as MaybeElement[]));
        } else {
          kept.push(child);
        }
      }
      node.children = kept;
    };
    visit(tree as MaybeElement, false);
  };
}
