/**
 * Source guard: no `<SheetContent>` re-supplies what the primitive now gives
 * (issue #930, Phases 2 and 3).
 *
 * Every bottom sheet in this app used to hand-write `p-4 pb-8` and
 * `max-h-[85vh]` — eleven copies of the same four tokens, because
 * `sheetContentVariants` supplied desktop-drawer padding and no height ceiling.
 * Phase 2 moved those into the variant's `bottom` arm and deleted the copies;
 * Phase 3 then changed the bottom padding to clear the iPhone home bar, which
 * is the one thing the whole exercise was for.
 *
 * That fix only reaches a sheet that does NOT override it. So the failure this
 * guards against is silent by construction: a twelfth sheet copy-pasted from a
 * page still in someone's editor buffer re-supplies `pb-8`, wins the merge, and
 * that one sheet quietly loses the home-bar clearance again. Nothing renders
 * wrong on a desktop viewport, no test fails, and the e2e suite runs in a
 * viewport with no inset — it would not see it either.
 *
 * ── How it avoids going vacuously green (docs/unit-test-spec.md §E) ──────────
 *
 *  - The scan surface is the whole of `src`, walked. A sheet added in a
 *    directory nobody has thought of yet is covered the day it is written, and
 *    there is no list of files to maintain (UT-E1).
 *  - It proves it can still see: the walk must find sheets, in more than one
 *    file, and both matchers are exercised against synthetic tags — the drift
 *    they must catch and the near-misses they must not (UT-E2).
 *  - It asserts on class tokens inside a named tag — structure — never on a
 *    comment or a label (UT-E3).
 *  - It stays inside the package: no `../../packages/...` escape (UT-E4). What
 *    the variant actually resolves to is `Sheet.test.ts`'s subject, over there
 *    where the variant lives; this file only asserts that no call site here
 *    fights it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// jsdom's global `URL` resolves against the document base, so the node
// `new URL(…, import.meta.url)` idiom does not work here — resolve by path.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * What `sheetContentVariants`' `bottom` arm supplies, and therefore what no
 * call site should be writing. Deliberately the VALUES rather than the
 * property names: a site is still free to override the padding or the ceiling
 * with a different value — `MealDayEditor` overrides the ceiling with `85dvh`
 * and that is documented at the site — but re-stating the primitive's own
 * value is always duplication, and re-stating the inset is the one that breaks
 * silently.
 */
const SUPPLIED_BY_THE_VARIANT = ['p-4', 'pb-8', 'max-h-[85vh]'] as const;

/**
 * The inset is matched as a SUBSTRING and the rest as whole class tokens, and
 * the difference is load-bearing. `env(safe-area-inset-bottom)` only ever
 * appears inside an arbitrary value, so it has no token of its own to match;
 * `p-4` very much does, and `gap-4` contains it — a substring test flags all
 * nine sheets that legitimately write `gap-4` and says nothing true.
 */
const INSET = 'safe-area-inset';

const classTokens = (tag: string): string[] =>
  [...tag.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean);

const violations = (tag: string): string[] => {
  const tokens = classTokens(tag);
  const found = SUPPLIED_BY_THE_VARIANT.filter((t) => tokens.includes(t));
  return tag.includes(INSET) ? [...found, INSET] : [...found];
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

/** Every `<SheetContent …>` opening tag in a file, attributes and all. */
function sheetTags(source: string): string[] {
  return [...source.matchAll(/<SheetContent\b[^>]*>/g)].map((m) => m[0]);
}

const SITES = walk(SRC).flatMap((file) =>
  sheetTags(readFileSync(file, 'utf8')).map((tag) => ({ file, tag })),
);

describe('SheetContent call sites do not fight the primitive', () => {
  it('the walk still finds sheets, across more than one page', () => {
    // Liveness, not a ceiling. #930 counted eleven; the assertion is that the
    // scan is looking at something, not that the number has stayed put.
    expect(SITES.length).toBeGreaterThan(5);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThan(1);
  });

  it.each([...SUPPLIED_BY_THE_VARIANT, INSET])('no call site writes %s', (token) => {
    const offenders = SITES.filter((s) => violations(s.tag).includes(token)).map(
      (s) => `${s.file.slice(SRC.length + 1)}: ${s.tag}`,
    );
    expect(offenders).toEqual([]);
  });

  it('catches the drift it exists for', () => {
    const insetBack =
      '<SheetContent class="flex flex-col gap-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">';
    const paddingBack = '<SheetContent class="flex max-h-[85vh] flex-col gap-4 p-4 pb-8">';

    expect(sheetTags(insetBack)).toHaveLength(1);
    expect(violations(insetBack)).toEqual([INSET]);
    expect(violations(paddingBack)).toEqual(['p-4', 'pb-8', 'max-h-[85vh]']);
  });

  it.each([
    ['gap-4 — contains "p-4" as a substring and is not a violation', 'flex flex-col gap-4'],
    ['MealDayEditor’s surviving dvh ceiling', 'max-h-[85dvh] gap-3'],
    ['ShoppingListPage’s deliberate opt-out', 'flex max-h-none flex-col gap-4'],
    ['a caller’s own overflow', 'overflow-y-auto'],
  ])('leaves alone: %s', (_name, classes) => {
    expect(violations(`<SheetContent class="${classes}">`)).toEqual([]);
  });

  it('sees a multi-line tag, which is how prettier writes a long one', () => {
    // The regex is `[^>]*`, so it spans newlines — a tag broken across lines is
    // exactly where a hand-written override would be easiest to miss.
    const wrapped = '<SheetContent\n  class="flex flex-col gap-4 pb-8"\n>';
    const [tag] = sheetTags(wrapped);
    expect(tag).toBeDefined();
    expect(tag).toContain('pb-8');
  });
});
