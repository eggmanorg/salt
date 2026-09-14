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
 * A genuine source scan: it reads `.svelte` bytes off disk and imports nothing,
 * so no stub or test-only render can make it vacuously green. It is also the
 * reason `grep` and not Serena — `sanitizedHtml` is a Svelte prop, and Serena is
 * TypeScript-only here by decision (CLAUDE.md → Code search).
 *
 * WHEN THIS GOES RED: a surface opted in or out. That is a decision about where
 * raw HTML renders, so make it deliberately — update the list below, and say in
 * the PR why the new surface's content is trustworthy enough to parse.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every `.svelte` file under `src`, found by walking — never a hand-kept list. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [full] : [];
  });
}

/**
 * Strip HTML and JS comments, so a component that merely DISCUSSES the prop —
 * `LibraryPageDocument.svelte` has a paragraph about it — is not counted as one
 * that passes it.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// The prop as it is actually passed: shorthand (`<Markdown … sanitizedHtml />`),
// or bound to an expression. A component that only names it in a type or a
// destructure is `Markdown` itself, which does not live under this app.
const PASSES_PROP = /\bsanitizedHtml\b(?!\s*[?:])/;

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
  const callers = walk(srcDir)
    .filter((file) => PASSES_PROP.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(srcDir, file).split(sep).join('/'))
    .sort();

  it('is exactly the three library surfaces, and nothing else in the app', () => {
    expect(callers).toEqual(OPTED_IN);
  });

  // Guards the guard: a scan that found nothing would pass the assertion above
  // only if the list were empty too, but a scan pointed at the wrong directory
  // would fail confusingly rather than tell you why.
  it('scanned a tree that actually has components in it', () => {
    expect(walk(srcDir).length).toBeGreaterThan(20);
  });
});
