/**
 * Source guard: which surfaces of this app render raw HTML (issue #1391).
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
 * WHEN THIS GOES RED: a surface opted in or out. That is a decision about where
 * raw HTML renders, so make it deliberately — update the list below, and say in
 * the PR why the new surface's content is trustworthy enough to parse.
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
 * Does this component's markup render a `<Markdown>` that passes `sanitizedHtml`?
 *
 * Walks the template AST. `parent` is skipped because the modern AST's nodes link
 * back to it and the walk would not terminate.
 */
function passesSanitizedHtml(source: string): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const record = node as Record<string, unknown>;
    if (record.type === 'Component' && record.name === 'Markdown') {
      const attributes = (record.attributes ?? []) as { type?: string; name?: string }[];
      if (attributes.some((a) => a.type === 'Attribute' && a.name === 'sanitizedHtml')) {
        found = true;
        return;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'parent') visit(value);
    }
  };
  visit(parse(source, { modern: true }).fragment);
  return found;
}

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

describe('sanitizedHtml — which surfaces render raw HTML', () => {
  const files = walkFiles(srcDir);
  const callers = files
    .filter((file) => passesSanitizedHtml(readFileSync(file, 'utf8')))
    .map((file) => relative(srcDir, file).split(sep).join('/'))
    .sort();

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
