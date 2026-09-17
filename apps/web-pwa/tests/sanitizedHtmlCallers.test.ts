/**
 * Source guard: which surfaces pass which `Markdown` prop (issues #1391, #1409).
 *
 * TWO claims, one walk and one parser, because they are the same question asked
 * of the same component from the same bytes: `sanitizedHtml` — which surfaces
 * render raw HTML (#1391) — and `scale="doc"` — which surfaces render at
 * document proportions (#1394, pinned here by #1409). Each is its own `describe`
 * below and states its own subject and its own reason for existing; what they
 * share is the mechanism, not the argument. A third file re-walking this tree to
 * ask a near-identical question about the same component would itself be the
 * duplication `sharedHelperGuard.test.ts` exists to police.
 *
 * ── Claim one: `sanitizedHtml`, a SECURITY fact ──────────────────────────────
 *
 * `Markdown`'s `sanitizedHtml` prop turns raw HTML in a body from escaped text
 * into real elements, filtered by `svgSanitizeSchema` — and Salt serves no
 * Content-Security-Policy, so that schema is the whole of the defence
 * (`packages/ui-components/src/primitives/Markdown/svgSanitizeSchema.ts`). Which
 * surfaces opt in is therefore a security fact about the app, not a detail of
 * three components.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * It was already written down. `LibraryPageView.test.ts`, `RecipeNotesCard.test.ts`
 * and `ChatSessionPage.test.ts` each carried a prose claim about who opts in,
 * pinned by naming today's other callers — so a fourth surface could opt in with
 * every suite green and three comments quietly wrong (CLAUDE.md rule 12). This is
 * that claim made mechanical, in one place, and the three comments now point here
 * instead of restating it.
 *
 * ── Claim two: `scale="doc"`, a CONSISTENCY fact ─────────────────────────────
 *
 * #1394 collapsed three byte-identical copies of the library's document type
 * scale into a `scale` prop on the same primitive. `sharedHelperGuard.test.ts`
 * catches a file that re-DECLARES those rules; nothing caught a surface that
 * quietly stopped ASKING for them. Delete `scale="doc"` from the history sheet
 * and a revision previews at compact note scale beside a page body at document
 * scale — the exact failure #1394 named, with every suite green. The second
 * `describe` below is that half, and the two guards read as one mechanism.
 *
 * ── Why it PARSES rather than greps ──────────────────────────────────────────
 *
 * The scan has to ignore a component that merely DISCUSSES the prop —
 * `LibraryPageDocument.svelte` has a paragraph about it — and stripping comments
 * with a regex first is a trap twice over. It is wrong (removing the inner
 * comment of `<!--<!-- -->-->` re-forms an outer one from the surrounding text),
 * and CodeQL rejects the shape outright as `js/incomplete-multi-character-
 * sanitization` — including the repeat-to-a-fixed-point version, which was tried
 * and still failed CI. Svelte's own parser has no such problem: a `Comment` is
 * its own AST node and is never walked as an element, so prose is excluded BY
 * CONSTRUCTION rather than by a pattern that has to be got right.
 *
 * It also makes the guard stricter than a grep could be — it demands the prop on
 * a `<Markdown>` specifically, not the identifier appearing somewhere in a file.
 *
 * A genuine source scan either way: it reads `.svelte` bytes off disk and imports
 * none of the components, so no stub or test-only render can make it vacuously
 * green.
 *
 * WHEN EITHER GOES RED: a surface opted in or out. Both are decisions rather than
 * details — where raw HTML renders, and which bodies read as documents — so make
 * them deliberately. Update the list concerned, and say in the PR why: for
 * `sanitizedHtml`, why the new surface's content is trustworthy enough to parse;
 * for `scale="doc"`, why that surface is or is not showing a library page body.
 *
 * WHAT NEITHER CAN SEE: a surface that gets the same result by another route —
 * raw HTML rendered outside `Markdown`, or document proportions reimplemented
 * with utilities that never touch the prop. These guards are bounded to a
 * LITERAL spelling of the prop on a `<Markdown>` element — `scale="doc"`, not
 * `scale={'doc'}` or `scale={someBinding}`. An interpolated `scale` is not read
 * as text by the second `describe` below, so on its own that would let a fourth
 * surface pick up the document scale — or drop it — with every assertion here
 * staying green. That gap does not stay open: a second guard in that `describe`
 * refuses to guess at an interpolated `scale` and fails loudly instead, so the
 * whole of what these two guards claim is a literal `scale="doc"`, tracked, and
 * anything else written into a `<Markdown>`'s `scale`, refused.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'svelte/compiler';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every `.svelte` file under `src`, found by walking — never a hand-kept list. */
function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [full] : [];
  });
}

/**
 * The literal text of an attribute, or `null` when it has none that is literal.
 *
 * In the modern AST a `foo="bar"` attribute's value is a one-element array of a
 * `Text` node; a shorthand boolean (`sanitizedHtml`) is `true`, and anything
 * interpolated (`scale={x}`) is an expression node. Only a literal answers here,
 * which is what makes `scale="doc"` checkable and `scale={someVariable}` — quite
 * correctly — not a match this guard can claim to have understood.
 */
function literalValue(attribute: unknown): string | null {
  const { value } = attribute as { value?: unknown };
  if (!Array.isArray(value) || value.length !== 1) return null;
  const only = value[0] as { type?: string; data?: unknown } | undefined;
  return only?.type === 'Text' && typeof only.data === 'string' ? only.data : null;
}

/**
 * Visits every `<Markdown>` component in this template's markup, calling `test`
 * with its attribute list; stops at the first list `test` accepts. The
 * parse-and-walk is written once here and shared by every check below, so
 * `rendersMarkdownWith` and `hasUnreadableScale` differ only in the predicate
 * they hand it. `parent` is skipped because the modern AST's nodes link back to
 * it and the walk would not terminate.
 */
function anyMarkdownComponent(
  source: string,
  test: (attributes: { type?: string; name?: string }[]) => boolean,
): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const record = node as Record<string, unknown>;
    if (record.type === 'Component' && record.name === 'Markdown') {
      const attributes = (record.attributes ?? []) as { type?: string; name?: string }[];
      if (test(attributes)) {
        found = true;
        return;
      }
    }
    for (const [key, value_] of Object.entries(record)) {
      if (key !== 'parent') visit(value_);
    }
  };
  visit(parse(source, { modern: true }).fragment);
  return found;
}

/**
 * Does this component's markup render a `<Markdown>` carrying this attribute?
 *
 * With `value` given, the attribute must also be written as that literal
 * string. `scale={'doc'}` and `scale={x}` are NOT this — `literalValue` reads
 * only a one-element `Text` node, so an interpolated `scale` looks identical
 * here to the prop being absent entirely. That is a real gap for a `value`
 * check to have on its own, and `hasUnreadableScale` below is what closes it:
 * this function stays honest about what it can read, rather than trying to
 * evaluate an expression it was never meant to.
 */
function rendersMarkdownWith(source: string, name: string, value?: string): boolean {
  return anyMarkdownComponent(source, (attributes) =>
    attributes.some(
      (a) =>
        a.type === 'Attribute' &&
        a.name === name &&
        (value === undefined || literalValue(a) === value),
    ),
  );
}

/**
 * Does this component's markup pass `<Markdown>` a `scale` this guard cannot
 * read as text — `scale={'doc'}`, `scale={someBinding}`, or any other
 * expression rather than a bare string?
 *
 * `passesDocScale` (below) can only see the literal spelling, so on its own an
 * interpolated `scale` would be a silent way to add or drop a surface from
 * `DOC_SCALE` with that check staying green either way. Rather than trying to
 * evaluate the expression — which would mean re-implementing a JS interpreter
 * to answer "is this string 'doc'?" — this refuses to guess: ANY non-literal
 * `scale` on a `<Markdown>` is flagged, whatever it would have evaluated to,
 * so a fourth surface reaching for `scale={DOC}` fails loudly here instead of
 * quietly missing the list above.
 */
function hasUnreadableScale(source: string): boolean {
  return anyMarkdownComponent(source, (attributes) =>
    attributes.some(
      (a) => a.type === 'Attribute' && a.name === 'scale' && literalValue(a) === null,
    ),
  );
}

const passesSanitizedHtml = (source: string): boolean =>
  rendersMarkdownWith(source, 'sanitizedHtml');

const passesDocScale = (source: string): boolean => rendersMarkdownWith(source, 'scale', 'doc');

/** Every `.svelte` file under `src`, walked once and shared by both claims. */
const files = walkFiles(srcDir);

/** The files, relative to `src`, whose markup satisfies `predicate`. */
const callersOf = (predicate: (source: string) => boolean): string[] =>
  files
    .filter((file) => predicate(readFileSync(file, 'utf8')))
    .map((file) => relative(srcDir, file).split(sep).join('/'))
    .sort();

/**
 * The surfaces that render raw HTML, relative to `src`. All three are the
 * library, which is the one place a person writes the content themselves and
 * then reads it back — diagrams and tables are the point of it (#1376). The chat
 * is deliberately NOT here: it renders model output.
 */
const OPTED_IN = [
  'routes/library/LibraryHistorySheet.svelte',
  'routes/library/LibraryImportSheet.svelte',
  'routes/library/LibraryPageDocument.svelte',
];

/**
 * The surfaces that render at document proportions, relative to `src`. The same
 * three, and not by coincidence: a library page body, the history sheet's
 * preview of a revision of one, and the import sheet's preview of one about to
 * become one. They must agree, or the library shows the same page at two sizes.
 */
const DOC_SCALE = [
  'routes/library/LibraryHistorySheet.svelte',
  'routes/library/LibraryImportSheet.svelte',
  'routes/library/LibraryPageDocument.svelte',
];

describe('sanitizedHtml — which surfaces render raw HTML', () => {
  const callers = callersOf(passesSanitizedHtml);

  it('is exactly the three library surfaces, and nothing else in the app', () => {
    expect(callers).toEqual(OPTED_IN);
  });

  // Guards the guard: a scan pointed at the wrong directory, or one whose parse
  // silently returned nothing, would satisfy the assertion above only by accident
  // of the list being short — and would fail confusingly rather than say why.
  it('scanned a tree that actually has components in it', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // The prose-versus-markup distinction this file turns on, asserted rather than
  // assumed: a comment that shows the prop is not a caller, and `LibraryPageDocument`
  // really does contain such a comment as well as a real call.
  it('does not count a component that only mentions the prop in a comment', () => {
    expect(passesSanitizedHtml('<!-- <Markdown text={x} sanitizedHtml /> -->')).toBe(false);
    expect(passesSanitizedHtml('<Markdown text={x} sanitizedHtml />')).toBe(true);
    expect(passesSanitizedHtml('<Markdown text={x} />')).toBe(false);
  });
});

describe('scale="doc" — which surfaces render at document proportions', () => {
  const callers = callersOf(passesDocScale);

  // The half `sharedHelperGuard.test.ts`'s `#1394` row cannot see. That row
  // fires on a second DECLARATION of the rules; this one fires when a surface
  // stops asking for them with the LITERAL spelling — a dropped `scale="doc"`,
  // or a fourth surface adding it the same literal way. A surface that reaches
  // for `scale={anything}` instead does not move this list either way, since
  // `passesDocScale` cannot read it; that shape is caught separately, below,
  // by the guard that refuses to guess at it rather than silently missing it.
  it('is exactly the three library surfaces, and nothing else in the app', () => {
    expect(callers).toEqual(DOC_SCALE);
  });

  // Same anchor as above, and it earns its place twice: this `describe` would
  // satisfy the assertion above trivially if the walk returned nothing at all.
  it('scanned a tree that actually has components in it', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // The prose-versus-markup distinction, for this prop: `LibraryPageDocument`
  // discusses `scale="doc"` in its header comment as well as passing it, so a
  // grep would count it for the wrong reason and keep counting it after the real
  // call was deleted.
  it('does not count a component that only mentions the prop in a comment', () => {
    expect(passesDocScale('<!-- <Markdown text={x} sanitizedHtml scale="doc" /> -->')).toBe(false);
    expect(passesDocScale('<Markdown text={x} sanitizedHtml scale="doc" />')).toBe(true);
  });

  // And the value half: the prop is only a match at the value this guard is
  // about. A note-scale caller is every other `Markdown` in the app.
  it('counts the value, not merely the prop', () => {
    expect(passesDocScale('<Markdown text={x} />')).toBe(false);
    expect(passesDocScale('<Markdown text={x} scale="note" />')).toBe(false);
    // An interpolated scale is not a literal, so `passesDocScale` cannot read
    // it — on its own that would let `scale={chosen}` add or drop a surface
    // from the list above with THIS assertion staying green either way. That
    // gap does not stay open: `hasUnreadableScale`, checked in the next test,
    // fails on exactly this shape, so a caller written this way is refused
    // rather than silently counted or silently missed.
    expect(passesDocScale('<Markdown text={x} scale={chosen} />')).toBe(false);
  });

  // Pins the direction stated above: a `scale` this guard cannot read as text
  // is refused, not ignored. Both false-negative shapes verified on this PR's
  // review — an interpolated literal and a variable reference — must flag, and
  // both the working literal spelling and no `scale` at all must not.
  it('refuses a <Markdown> whose scale it cannot read, rather than missing it', () => {
    expect(hasUnreadableScale("<Markdown text={x} scale={'doc'} />")).toBe(true);
    expect(hasUnreadableScale('<Markdown text={x} scale={chosen} />')).toBe(true);
    expect(hasUnreadableScale('<Markdown text={x} scale="doc" />')).toBe(false);
    expect(hasUnreadableScale('<Markdown text={x} scale="note" />')).toBe(false);
    expect(hasUnreadableScale('<Markdown text={x} />')).toBe(false);
  });

  // The scan surface itself: no file under `src` today passes `<Markdown>` a
  // `scale` this guard cannot read. If one does, it must be rewritten as a
  // literal `scale="doc"` or `scale="note"` so the two guards above can see
  // it, not left as an expression neither can evaluate.
  it('has no <Markdown> anywhere in the app passing an unreadable scale', () => {
    const offenders = files
      .filter((file) => hasUnreadableScale(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });

  // The two lists are the same three files today. Asserting that they are equal
  // would be asserting a coincidence; asserting that each is checked separately
  // is what makes dropping one prop from one file visible.
  it('is a separate claim from the raw-HTML one', () => {
    expect(DOC_SCALE).not.toBe(OPTED_IN);
    expect(passesSanitizedHtml('<Markdown text={x} sanitizedHtml />')).toBe(true);
    expect(passesDocScale('<Markdown text={x} sanitizedHtml />')).toBe(false);
  });
});
