import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// The recipe editor's three routes are gone (issue #1319 Phase 8), and this is
// what keeps them gone.
//
// The phase's first user-testable outcome is a NEGATIVE — "`/recipes/new`,
// `/recipes/new/:kind` and `/recipes/:id/edit` are not routes, and nothing in the
// app links to them" — and a negative about the whole source tree is the one kind
// of claim no component test can make. Every suite that mounted a page proving it
// no longer navigates there proves it for that page alone; a `push('/recipes/new')`
// reappearing in a screen nobody thought to re-test would pass all of them.
//
// A SOURCE-TEXT GUARD rather than an import of the route map, deliberately:
// `src/routes/index.ts` eagerly imports a dozen page components, so asserting on
// the Map would cost a dozen store mocks for one assertion — and would still only
// cover the route table, not the call sites. Reading the text covers both. Same
// shape as `focusRingGuard.test.ts` beside it, and the same trade: it cannot see
// a path assembled from fragments at runtime. Nothing in this codebase builds a
// route that way, and if something starts to, this guard is not what should stop
// it.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every `.svelte` and `.ts` under `src`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(svelte|ts)$/.test(entry) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

/**
 * Is this line prose rather than code?
 *
 * Several comments deliberately NAME a dead route to explain why it is dead,
 * which is the opposite of a regression, so they have to be skipped. This is a
 * line test and not a comment PARSER on purpose: stripping block and Svelte
 * comment spans with a regex is the incomplete-multi-character-sanitization
 * shape CodeQL rejects (it flagged exactly that in this file's first draft), and
 * writing a real parser to serve a guard would be more machinery than the guard
 * is worth.
 *
 * THE BOUNDARY, since a line test is not a complete answer: every mention in the
 * tree today is a `//` line or a ` * ` JSDoc continuation, and a block or Svelte
 * comment whose MIDDLE line began with neither would not be skipped. That
 * direction is the safe one — such a line fails the guard and somebody reformats
 * a comment — and it is the direction a guard should err in. What it must never
 * do is skip a line of real code, and no line of code starts this way.
 */
function isProse(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

/**
 * A retired path as it would appear in code — in a route key, a `push()`, an
 * `href`, or a string built with a template literal id.
 *
 * `/recipes/new` deliberately requires a following quote, `?`, `/` or backtick so
 * it cannot match `/recipes/new-page` or a longer word; `:id/edit` is matched as
 * the `/edit` SUFFIX on a recipe path, which is how both the route key and any
 * template literal would spell it.
 */
const RETIRED = [
  { name: '/recipes/new', pattern: /\/recipes\/new(?=['"`?/]|$)/m },
  { name: '/recipes/:id/edit', pattern: /\/recipes\/(?:\$\{[^}]*\}|:id|[\w-]+)\/edit\b/ },
];

describe('the retired recipe editor routes', () => {
  it.each(RETIRED)('$name is not a route and nothing navigates to it', ({ pattern }) => {
    const offenders = files
      .filter(({ text }) => text.split('\n').some((l) => !isProse(l) && pattern.test(l)))
      .map(({ path }) => path);

    expect(
      offenders,
      `These files still reach the retired recipe editor:\n  ${offenders.join('\n  ')}\n` +
        'A recipe is edited on the page it is read on — `recipe-edit-mode-button` on ' +
        '`/recipes/:id` — and the three entries a recipe cannot get by importing, ' +
        'chatting or duplicating are minted by `RecipeNewSheet`.',
    ).toEqual([]);
  });

  it('still has a catch-all, so a stale bookmark lands on Not found rather than nothing', () => {
    const index = files.find(({ path }) => path === 'routes/index.ts')!;

    // The claim the route deletion rests on, checked rather than assumed: three
    // paths were removed from a Map whose lookup falls through to `'*'`. Without
    // this entry they would render blank instead of saying what happened.
    expect(index.text).toContain("['*', NotFound]");
  });
});
