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
      .filter(({ text }) => {
        // Comments may name a dead route — several explain why it is dead, which
        // is the opposite of a regression. Strip them before looking.
        const code = text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/<!--[\s\S]*?-->/g, '');
        return pattern.test(code);
      })
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
