/**
 * Source guard: nothing re-declares a shared rule (issues #933, #1055, #1394).
 *
 * Three issues' worth of rows, one walk of `src`. #933 collapsed eleven DISPLAY
 * rules — what a number, a date, a URL or a viewport reads as. #1055 collapsed
 * eight PAGE-LOCAL copies where the answer already existed a few lines away and
 * the page wrote it again. #1394 collapsed three copies of the library's
 * document type scale into a prop on the `Markdown` primitive. Same cause, same
 * shape of fix, so the same guard rather than a second file scanning the same
 * tree (which would itself have been #1055's subject matter).
 *
 * Eleven rules that decide what a number, a date, a URL or a viewport READS AS on
 * screen each had between two and eight implementations. Three of them had
 * already drifted into forks a user could see — the same 90-minute bake read
 * `1 h 30 min` on one screen and `1 hr 30 min` on another; a member whose name
 * was typed with a leading space rendered as a blank chef label; a hand-added
 * shopping item showed its provenance in the edit sheet and nothing at all in the
 * row. None of that failed a test, because both spellings are correct-looking and
 * neither throws.
 *
 * The other eight were identical ON THE DAY THEY WERE MEASURED, held that way by
 * prose. That is the state this file replaces: comments asking the next author to
 * keep copies in agreement have now failed twice in this repo — `timerDefaults`
 * (#994, whose guard is this file's template) and `CanonIcon` — and a request is
 * not a mechanism.
 *
 * ── Two halves, because drift has two shapes ─────────────────────────────────
 *
 * A file can copy a rule by NAME (`function formatGrams(g) { … }`) or by VALUE
 * (`new Date().toLocaleDateString('en-CA')` — which declares nothing named and
 * references nothing shared, so a name-only guard cannot see it). Every one of
 * the eleven was found in the second shape at least once, so both are checked.
 *
 * ── How it avoids going vacuously green (docs/unit-test-spec.md §E) ──────────
 *
 *  - The guarded NAMES are read out of the owning modules themselves, so renaming
 *    or adding an export moves the guard with it. There is no list of identifiers
 *    to maintain (UT-E1).
 *  - The scan surface is the whole of `src`, walked — not a list of pages. A
 *    twelfth surface that wants one of these rules is covered on the day it is
 *    written (UT-E1).
 *  - Every matcher is exercised against BOTH a synthetic copy it must catch and a
 *    near-miss it must not, so a regex broken by a later edit fails here rather
 *    than passing everything or failing everywhere (UT-E2).
 *  - It asserts on identifiers, imports and value shapes, never on the wording of
 *    the comments beside them and never on a line number (UT-E3) — both are
 *    things this very issue rewrote.
 *
 * ── The honest boundary of the VALUE half ────────────────────────────────────
 *
 * The forbidden shapes below are STATED, not derived, and that is a real
 * limitation rather than an oversight. Three of the rules they cover are owned by
 * `@salt/domain` (`dateInZone`, `recipeHeroUrl`, `memberFirstName`), and UT-E4
 * forbids a `../../../../packages/…` path escape to read their source. So the
 * shapes are written here with the reason attached, and each is pinned by the
 * self-tests below. What that buys is still the thing that matters: the SCAN
 * SURFACE is derived, so nothing can drop out of coverage by moving.
 *
 * It is a genuine source scan — it reads bytes off disk and never imports the
 * modules it checks, so no `vi.mock` can make it agree.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * The modules that OWN a display rule after issue #933, and what each is for.
 *
 * This list is the one thing here that is hand-kept, and it is the right thing to
 * hand-keep: it says which modules are authorities, which is a design decision
 * rather than something readable off the tree. Everything else — which names they
 * export, which files exist — is derived from it.
 */
const OWNERS: readonly { readonly path: string; readonly rule: string }[] = [
  { path: 'lib/durationDisplay.ts', rule: 'how a length of time reads' },
  { path: 'lib/quantityDisplay.ts', rule: 'how a gram figure reads' },
  { path: 'lib/today.ts', rule: 'what day it is here' },
  { path: 'lib/shoppingSource.ts', rule: 'where a shopping item came from' },
  { path: 'lib/mediaQuery.svelte.ts', rule: 'a live media query, read safely' },
  { path: 'lib/reducedMotion.ts', rule: 'the reduced-motion preference' },
  { path: 'lib/swipe.ts', rule: 'the gesture thresholds' },
  // ── issue #1055 ──
  { path: 'lib/canonIndex.ts', rule: 'canon by id, and whether it may be judged yet' },
  { path: 'lib/attachedRecipes.ts', rule: "which recipes a day's ids point at" },
  { path: 'lib/timeOptions.ts', rule: 'the quarter-hour pickers' },
  { path: 'routes/recipes/unitCount.ts', rule: 'how many units a shape declares' },
];

/**
 * Every source file under `src`, found by walking — never by a hand-kept list.
 *
 * `.css` is in the list because `app.css` is a declaration site like any other
 * and was invisible to this guard until #1409 — a rule written there needs no
 * `:global()` to reach the whole app. It is handed to all three halves rather
 * than to the CSS-shaped row alone: that was checked by running it, and nothing
 * in the name half, the value half or the count half fires on a stylesheet.
 */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.isFile()) return [];
    return ['.ts', '.svelte', '.css'].some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

// The three comment forms a `.ts`, `.svelte` or `.css` file can carry, each as
// its opener and what closes it. A line comment closes at the newline, which is
// kept. CSS has no `//` form, so applying it to a stylesheet can only over-strip
// — the tail of a line holding a `url(https://…)` — which costs coverage and
// never invents a match.
const COMMENTS: readonly (readonly [open: string, close: string])[] = [
  ['<!--', '-->'],
  ['/*', '*/'],
  ['//', '\n'],
];

/**
 * Strip comments so a MENTION of a rule in prose never counts as a copy of it.
 *
 * This matters more here than almost anywhere: the whole issue consisted of
 * comments describing rules, and several of the modules under `src` now carry
 * sentences like "the hero rule itself is `recipeHeroUrl`". Left in, those would
 * be read as the drift they are documenting.
 *
 * Scanned once, left to right, taking whichever opener appears FIRST — the same
 * approach as `timerDefaultsGuard.test.ts`, and for the same reason: a
 * replace-pass per form has to pick an order, and whichever it picks the other
 * form's opener can sit inside it.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const found = COMMENTS.find(([open]) => src.startsWith(open, i));
    if (found === undefined) {
      out += src[i];
      i += 1;
      continue;
    }
    const [open, close] = found;
    const end = src.indexOf(close, i + open.length);
    i = end === -1 ? src.length : end + close.length;
    out += close === '\n' ? '\n' : ' ';
  }
  return out;
}

interface Scanned {
  readonly path: string;
  readonly code: string;
}

const ownerPaths = new Set(OWNERS.map((o) => o.path));

const allFiles: Scanned[] = walk(srcDir).map((path) => ({
  path: relative(srcDir, path).split(sep).join('/'),
  code: stripComments(readFileSync(path, 'utf8')),
}));

/** Everything the guard polices — every file except the authorities themselves. */
const files = allFiles.filter((f) => !ownerPaths.has(f.path));

const sourceOf = (path: string): string => {
  const found = allFiles.find((f) => f.path === path);
  if (found === undefined) throw new Error(`guard cannot find its own subject: ${path}`);
  return found.code;
};

// ─── Half one: the rule copied by NAME ────────────────────────────────────────

/** What each owner exports, read from the module rather than restated (UT-E1). */
const GUARDED: readonly {
  readonly name: string;
  readonly owner: string;
  readonly rule: string;
}[] = OWNERS.flatMap(({ path, rule }) =>
  [...sourceOf(path).matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].flatMap(
    (m) => (m[1] === undefined ? [] : [{ name: m[1], owner: path, rule }]),
  ),
);

/** A local binding of that name — the drift this guard exists to catch. */
function redeclares(code: string, name: string): boolean {
  return new RegExp(String.raw`\b(?:const|let|var|function|class|enum)\s+${name}\b`).test(code);
}

const references = (code: string, name: string): boolean =>
  new RegExp(String.raw`\b${name}\b`).test(code);

// ─── Half two: the rule copied by VALUE ───────────────────────────────────────

interface Shape {
  /** What a reader should write instead. */
  readonly instead: string;
  /** Why this shape is drift and not merely similar-looking. */
  readonly because: string;
  readonly pattern: RegExp;
  /** Files allowed to carry it, and why. Empty means nowhere in `src`. */
  readonly allowed?: readonly string[];
}

const FORBIDDEN: readonly Shape[] = [
  {
    instead: 'todayIso() from lib/today.js',
    because:
      "five modules each answered 'what day is it here' with this expression; the rule is dateInZone in @salt/domain and the clock belongs to lib/today.ts",
    pattern: /toLocaleDateString\(\s*['"]en-CA['"]/,
  },
  {
    instead: 'recipeHeroUrl(recipe) from @salt/domain',
    because:
      'the hero nonce precedence was written out at eight sites; imageRequestedAt is only ever a cache-buster and only ever falls back to updatedAt',
    pattern: /imageRequestedAt\s*\?\?/,
  },
  {
    instead: 'SPLIT_QUERY from lib/mediaQuery.svelte.js',
    because:
      'three pages carried this literal and the 25-line guarded effect around it; app.css holds the only other legitimate spelling, in the variant form Tailwind needs',
    pattern: /width\s*>=\s*700px/,
  },
  {
    instead: 'prefersReducedMotion() from lib/reducedMotion.js',
    because:
      "svelte/motion's reader is a different API with a different default when matchMedia is missing, which is exactly the case the app's helper exists to get right",
    pattern: /from\s*['"]svelte\/motion['"]/,
  },
  {
    instead: 'memberFirstName from @salt/domain',
    because:
      "split(' ') takes an empty leading field and never sees a tab or a newline as a separator, so a name typed with either rendered wrong",
    pattern: /\.split\(\s*['"] ['"]\s*\)\s*\[\s*0\s*\]/,
  },

  // ── issue #1055 ────────────────────────────────────────────────────────────
  {
    instead: 'canonIndex(items) from lib/canonIndex.js',
    because:
      'six surfaces built this map for themselves, four of them under the same name; the domain match queries already take the ReadonlyMap it produces',
    pattern: /\.map\(\s*\(c\)\s*=>\s*\[\s*c\.id\s*,\s*c\s*\]\s*\)/,
  },
  {
    instead: 'matchMarkersReady(...) from lib/canonIndex.js',
    because:
      "the recipe list's pip and the recipe view's row markers must answer 'has canon landed' identically or the card counts problems the recipe does not show (#867); two comments used to ask the next author to keep them in step",
    pattern: /!\$?isLoadingAisles\s*&&\s*!\$?isLoadingProductForms/,
  },
  {
    instead: 'resolveRecipeIds(ids, byId) from lib/attachedRecipes.js',
    because:
      'the skip is the whole rule — a recipe deleted since it was attached must drop out rather than render as a blank row (#17) — and until #1055 no test anywhere asserted it, so every copy could lose it silently',
    pattern: /\.filter\(\s*\(\s*r\s*\)\s*:\s*r\s+is\s+Recipe\s*=>\s*r\s*!==\s*undefined\s*\)/,
  },
  {
    instead: 'quarterHourOptions(fromHour, count) from lib/timeOptions.js',
    because:
      'two pickers shared this arithmetic and NOT their windows; written out by hand the difference hides inside the expression, where a later reader collapses two deliberately different lists into one',
    pattern: /Math\.floor\(\s*i\s*\/\s*4\s*\)/,
  },
  {
    instead: 'currentMember from lib/membersService.js',
    because:
      'AdminGuard re-derived the signed-in member and disagreed with the exported store on a signed-out session, admitting one against an empty-email admin row; membersService is the only place that may resolve a uid to a member',
    pattern: /\.find\(\s*\(m\)\s*=>\s*m\.email\s*===/,
    // The authority itself, which resolves it twice on purpose: once reactively
    // for components (`currentMember`) and once as a snapshot for the route
    // guard (`findMemberByEmail`). It is not an OWNER row because #1055 added no
    // module here — it deleted the copy that shadowed this one.
    allowed: ['lib/membersService.ts'],
  },

  // ── issue #1394 ────────────────────────────────────────────────────────────
  //
  // A CSS rule, not an expression, which is why it is a FORBIDDEN shape and not
  // an OWNER row: the thing that owns it is `Markdown.svelte` in
  // `@salt/ui-components`, outside this tree, and UT-E4 forbids reaching across
  // a `../../../../packages/…` path to read it.
  //
  // WHAT THIS CATCHES, HONESTLY (widened by #1409). It catches a second
  // DECLARATION SITE: any file walked above whose text NAMES `.salt-md` or
  // `.salt-md-doc` as a class in a selector that opens a rule block. That is
  // every spelling a fourth copy could reach for — the paren form
  // `:global(.salt-md h1)` the three deleted copies had, Svelte 5's `:global
  // { … }` BLOCK form, `.salt-md-doc :global(p)` with the token on the
  // surface's own wrapper, and a bare `.salt-md-doc p { … }` in `app.css`,
  // which needs no `:global()` at all because it is already global at that
  // scope. `app.css` is inside the scan surface as of #1409; it was not before.
  //
  // WHY "opens a rule block" AND NOT THE BARE CLASS NAME. `\.salt-md` alone
  // would fire on a JS string — `querySelector('.salt-md')` — which is a
  // different sin from re-declaring the rules and would make this row noisy
  // enough to be edited away. Requiring the selector to run on to a `{` keeps
  // it to declarations. The near-miss self-tests below pin both directions.
  //
  // THE OTHER HALF IS NOT HERE. That a surface still ASKS for the scale — the
  // `scale="doc"` prop on its `<Markdown>` — is pinned by
  // `sanitizedHtmlCallers.test.ts`, which parses the markup rather than matching
  // text (#1409). A dropped prop is invisible to this row and always will be:
  // the two are one mechanism in two files, and neither claims the other's half.
  //
  // WHAT IT STILL CANNOT CATCH, and no lint rule can: a surface that
  // reimplements document proportions by a route that never names the class —
  // Tailwind utilities on a wrapper, a `prose`-style plugin, or `:global(h1)`
  // under some class of its own. Those are not spellings of this rule; they are
  // a second rule that happens to look the same on screen, and telling them
  // apart needs a person reading the diff. That gap is the boundary of the
  // claim, and it did not close in #1409.
  //
  // Two smaller boundaries worth stating rather than pretending away: a
  // selector group whose only line naming the class ends in a comma while the
  // `{` sits on a later line that does not name it is not matched, and the
  // class reached through a preprocessor variable or an interpolation is not
  // matched either. Both are catchable by eye in a diff; neither is silent
  // failure of something the pattern claims.
  {
    instead: 'scale="doc" on <Markdown> from @salt/ui-components',
    because:
      "the library's document type scale was declared three times — page body, history preview, import preview — byte-identical and held that way by a comment asking the next author to keep them in step; #1394 moved the rules into the primitive, where the next change is made once",
    pattern: /\.salt-md\b[^;{}]*\{/,
  },
];

// ─── Half three: the rule collapsed WITHIN one file ───────────────────────────
//
// Three of #1055's eight collapses exported nothing new — the copy and its twin
// were both inside one file, and the fix was to delete one of them. There is no
// owning module to read a name out of and no shape that is forbidden everywhere,
// so neither half above can see them. What is true instead is an OCCURRENCE
// COUNT inside one named file, and that is what is asserted.
//
// The path is stated and the count is stated; everything else is read off disk.
// `sourceOf` throws if a named file moves or is renamed, so this cannot go
// vacuously green by losing its subject (UT-E2) — which is the failure mode that
// matters, since a guard keyed on a path is exactly the kind that rots quietly.
interface Counted {
  readonly path: string;
  readonly what: string;
  readonly pattern: RegExp;
  readonly expected: number;
  readonly because: string;
}

const COUNTED: readonly Counted[] = [
  {
    path: 'routes/recipes/FormulaPage.svelte',
    what: 'a trimmed, finite, strictly-positive number parser',
    pattern: /Number\.isFinite\(value\)\s*&&\s*value\s*>\s*0/g,
    expected: 1,
    because:
      'this file declared `parseGrams` and `parseMinutes` ten lines apart with byte-identical bodies; `parseBakeLoss` and `parseCelsius` stay because their predicates genuinely differ (>= 0 with a ceiling, and no lower bound at all)',
  },
  {
    path: 'lib/shoppingDayService.ts',
    what: 'a teardown',
    pattern: /weekUnsubs\.clear\(\)/g,
    expected: 1,
    because:
      'the closure `initShoppingDaySync` returns and `__resetShoppingDayServiceForTest` were ten identical statements written twice; a store added to one and not the other bleeds state between tests and surfaces as a flake somewhere else entirely',
  },
  {
    path: 'lib/recipeService.ts',
    what: 'a root user-action span',
    pattern: /startUserActionSpan\(/g,
    // TWO, deliberately, and this is the honest count rather than the tidy one.
    // One is `tracedUserAction`, the shared helper behind `importRecipeFromUrl`,
    // `importRecipeFromPhoto` and `authorRecipeTraced`. The other is
    // `describeScene`, the fourth instance of the same skeleton, which #1055 left
    // alone on purpose: unlike the other three it MAPS its success value and
    // RETURNS from its failure branch, so folding it in would cost two more
    // parameters to serve one caller. If it is ever absorbed — or if the four
    // callers outside this file are swept — this number comes down and the change
    // is deliberate. What it must never do is drift UP.
    expected: 2,
    because:
      'three exported functions each opened a root span, a named child span and an outcome attribute in the same twenty-four-line skeleton, under three different attribute names',
  },
];

const occurrences = (code: string, pattern: RegExp): number =>
  [...code.matchAll(new RegExp(pattern.source, 'g'))].length;

const carries = (code: string, shape: Shape): boolean => shape.pattern.test(code);

// ─────────────────────────────────────────────────────────────────────────────

describe('display rules are declared once', () => {
  it('can still see the source it guards', () => {
    // Not an inventory — an anchor. A walk that narrowed, or an owner that moved
    // out from under the guard, fails here instead of going quietly green.
    expect(files.length).toBeGreaterThan(100);
    const names = files.map((f) => f.path.split('/').pop());
    expect(names).toContain('RecipeViewPage.svelte');
    expect(names).toContain('ShoppingItemRow.svelte');
    expect(names).toContain('MealPlanWeekPage.svelte');
    // The `.css` surface added by #1409, named so it cannot drop back out of
    // the walk silently. `app.css` is the only stylesheet under `src` today and
    // the likeliest fourth home for a rule the primitive already owns; a walk
    // that stopped collecting `.css` would otherwise go green having quietly
    // stopped covering it.
    expect(names).toContain('app.css');

    // Every owner must actually exist and be excluded from the policed set.
    for (const { path } of OWNERS) {
      expect(allFiles.map((f) => f.path)).toContain(path);
      expect(files.map((f) => f.path)).not.toContain(path);
    }
  });

  it('reads a non-empty set of names out of the owning modules', () => {
    // If the export regex ever stops matching, every name assertion below passes
    // trivially. These four are the rules that had already forked.
    expect(GUARDED.length).toBeGreaterThan(5);
    const names = GUARDED.map((g) => g.name);
    expect(names).toContain('formatMinutes');
    expect(names).toContain('formatGrams');
    expect(names).toContain('todayIso');
    expect(names).toContain('describeSource');
    expect(names).toContain('DRAG_START_PX');
    expect(names).toContain('SPLIT_QUERY');
    expect(names).toContain('prefersReducedMotion');
    // ── issue #1055's four modules ──
    expect(names).toContain('canonIndex');
    expect(names).toContain('matchMarkersReady');
    expect(names).toContain('resolveRecipeIds');
    expect(names).toContain('recipeIndex');
    expect(names).toContain('quarterHourOptions');
    expect(names).toContain('parseUnitCount');
  });

  it('recognises a re-declaration when it sees one', () => {
    // The exact shapes this issue deleted, as strings — so a regex broken by a
    // future edit fails on these rather than on nothing at all.
    expect(redeclares('  function formatGrams(grams: number): string {', 'formatGrams')).toBe(true);
    expect(redeclares('  const DRAG_START_PX = 6;', 'DRAG_START_PX')).toBe(true);
    expect(redeclares('  const todayIso = () => new Date();', 'todayIso')).toBe(true);
    expect(redeclares("  function describeSource(src) { return ''; }", 'describeSource')).toBe(
      true,
    );

    // And what it must NOT see, or the whole-`src` walk becomes noise: a call,
    // an import, and a longer name this one is merely a prefix of.
    expect(redeclares('  const label = formatGrams(totals.totalGrams);', 'formatGrams')).toBe(
      false,
    );
    expect(redeclares("  import { formatGrams } from '../../lib/quantityDisplay.js';", 'formatGrams')).toBe(false); // prettier-ignore
    expect(redeclares('  const formatGramsRange = (a, b) => a;', 'formatGrams')).toBe(false);
  });

  it('recognises an inlined rule when it sees one', () => {
    const shape = (instead: string): Shape => {
      const found = FORBIDDEN.find((s) => s.instead.startsWith(instead));
      if (found === undefined) throw new Error(`no forbidden shape for ${instead}`);
      return found;
    };

    // Each of these is a real line this issue deleted from `src`.
    expect(carries("  return new Date().toLocaleDateString('en-CA');", shape('todayIso'))).toBe(
      true,
    );
    expect(carries('  appendCacheBuster(r.image.url, r.imageRequestedAt ?? r.updatedAt)', shape('recipeHeroUrl'))).toBe(true); // prettier-ignore
    expect(carries("  const Q = '(width >= 700px) and (height >= 480px)';", shape('SPLIT_QUERY'))).toBe(true); // prettier-ignore
    expect(carries("  import { prefersReducedMotion } from 'svelte/motion';", shape('prefersReducedMotion'))).toBe(true); // prettier-ignore
    expect(carries("  return name.split(' ')[0] ?? name;", shape('memberFirstName'))).toBe(true);

    // And the near-misses each must NOT fire on.
    expect(carries("  formatDayKey(date, { weekday: 'long' });", shape('todayIso'))).toBe(false);
    expect(carries("  new Date().toLocaleDateString('en-GB');", shape('todayIso'))).toBe(false);
    expect(carries('  recipeHeroUrl(recipe)', shape('recipeHeroUrl'))).toBe(false);
    expect(carries('  if (imageRequestedAt !== undefined) refetch();', shape('recipeHeroUrl'))).toBe(false); // prettier-ignore
    expect(carries('  createMediaQuery(SPLIT_QUERY)', shape('SPLIT_QUERY'))).toBe(false);
    expect(carries('  @media (min-width: 700px)', shape('SPLIT_QUERY'))).toBe(false);
    expect(carries("  import { prefersReducedMotion } from './reducedMotion.js';", shape('prefersReducedMotion'))).toBe(false); // prettier-ignore
    expect(carries("  name.trim().split(/\\s+/).filter(Boolean)[0]", shape('memberFirstName'))).toBe(false); // prettier-ignore
    expect(carries("  text.split(', ')[0]", shape('memberFirstName'))).toBe(false);

    // ── issue #1055: a real line it deleted, then the near-miss beside it ──
    expect(carries('  const canonById = $derived(new Map($canonItems.map((c) => [c.id, c])));', shape('canonIndex'))).toBe(true); // prettier-ignore
    // Still live, and a DIFFERENT rule: these index the name, not the item.
    expect(carries('  const canonNameById = $derived(new Map($canonItems.map((c) => [c.id, c.name])));', shape('canonIndex'))).toBe(false); // prettier-ignore
    expect(carries('  $canonItems.map((c) => ({ value: c.id, label: titleCase(c.name) }))', shape('canonIndex'))).toBe(false); // prettier-ignore

    expect(carries('    !$isLoadingAisles && !$isLoadingProductForms && $canonItems.length > 0,', shape('matchMarkersReady'))).toBe(true); // prettier-ignore
    expect(carries('  matchMarkersReady($isLoadingAisles, $isLoadingProductForms, $canonItems.length)', shape('matchMarkersReady'))).toBe(false); // prettier-ignore

    expect(carries('    .filter((r): r is Recipe => r !== undefined),', shape('resolveRecipeIds'))).toBe(true); // prettier-ignore
    // The two shapes that look like it and are not: a SINGLE id resolved (one
    // id, not a list — MealDayDetail does this and must keep doing it), and a
    // display join with no skip at all.
    expect(carries('    const picked = recipes.find((r) => r.id === id);', shape('resolveRecipeIds'))).toBe(false); // prettier-ignore
    expect(carries("  dup.prepIds.map((id) => prepNumbers.get(id) ?? '?').join(', ')", shape('resolveRecipeIds'))).toBe(false); // prettier-ignore
    expect(carries('  .filter((r): r is Recipe => r !== undefined && takesIngredients(kindOf(r)))', shape('resolveRecipeIds'))).toBe(false); // prettier-ignore

    expect(carries('    (_, i) => `${16 + Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, \'0\')}`,', shape('quarterHourOptions'))).toBe(true); // prettier-ignore
    expect(carries('  const TIME_OPTIONS = quarterHourOptions(16, 28);', shape('quarterHourOptions'))).toBe(false); // prettier-ignore
    expect(carries('  Math.floor(index / 4)', shape('quarterHourOptions'))).toBe(false);

    expect(carries('  const currentMember = $derived($members.find((m) => m.email === currentEmail) ?? null);', shape('currentMember'))).toBe(true); // prettier-ignore
    expect(carries('  const isAdmin = $derived($currentMember?.admin === true);', shape('currentMember'))).toBe(false); // prettier-ignore
    expect(carries('  members.find((m) => m.id === memberId)', shape('currentMember'))).toBe(false);

    // ── issue #1394: the block re-added, then the shapes beside it ──
    const docScale = shape('scale="doc"');
    // Real lines this issue deleted, from all three surfaces.
    expect(carries('  .salt-md-doc :global(.salt-md h1) {', docScale)).toBe(true);
    expect(carries('  .salt-md-doc :global(.salt-md table) {', docScale)).toBe(true);
    // And the two other spellings a fourth surface would reach for: the token
    // targeted directly now that the primitive owns it, and the base class with
    // no wrapper at all.
    expect(carries('  :global(.salt-md-doc p) {', docScale)).toBe(true);
    expect(carries('  :global(.salt-md h2) {', docScale)).toBe(true);

    // ── issue #1409: the three spellings that used to slip past the paren ──
    // Svelte 5's BLOCK form, which compiles to the same fully-global rule.
    expect(carries('  :global { .salt-md p { margin: 0.75rem 0; } }', docScale)).toBe(true);
    // The token on the surface's own wrapper rather than the primitive's.
    expect(carries('  .salt-md-doc :global(p) {', docScale)).toBe(true);
    // And a bare rule in `app.css`, which is global already and needs no
    // `:global()` — the shape the walk could not even read until #1409.
    expect(carries('.salt-md-doc p {\n  margin: 0.75rem 0;\n}', docScale)).toBe(true);
    // The primitive's own two-class spelling, appearing under `src`. This
    // assertion was `false` before #1409, on the stated grounds that the rule
    // lives in ui-components and is never scanned here — which is a fact about
    // where the file is, not about what the line means. A file under
    // `apps/web-pwa/src` writing it genuinely IS a fourth declaration site, so
    // it must fire.
    expect(carries('  .salt-md.salt-md-doc :global(p) {', docScale)).toBe(true);

    // What it must NOT fire on, or every library surface fails its own guard:
    // passing the prop, an unrelated `:global` in a page, the class named in
    // markup or in a `cn()` call rather than a selector, and a JS lookup of it
    // (which is a different sin and not this row's).
    expect(carries('  <Markdown text={page.body} sanitizedHtml scale="doc" />', docScale)).toBe(false); // prettier-ignore
    expect(carries('  <div class="min-h-24 cursor-text rounded">', docScale)).toBe(false);
    expect(carries('  :global(.cook-deck h1) {', docScale)).toBe(false);
    expect(carries('  <div class="salt-md-doc">', docScale)).toBe(false);
    expect(carries('  const el = root.querySelector(".salt-md");', docScale)).toBe(false);
  });

  it('has no file outside its owning module re-declaring one of them', () => {
    const offenders = files.flatMap((file) =>
      GUARDED.filter(({ name }) => redeclares(file.code, name)).map(
        ({ name, owner, rule }) => `${file.path}: ${name} (${rule}) — import it from ${owner}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('has no file writing one of the rules out by hand', () => {
    const offenders = files.flatMap((file) =>
      FORBIDDEN.filter(
        (shape) => !(shape.allowed ?? []).includes(file.path) && carries(file.code, shape),
      ).map((shape) => `${file.path}: use ${shape.instead} — ${shape.because}`),
    );
    expect(offenders).toEqual([]);
  });

  it('has every file that uses one importing it from the module that owns it', () => {
    const consumers = files.filter((file) =>
      GUARDED.some(({ name }) => references(file.code, name)),
    );
    // A screen that formats a duration or reads the seam must exist, or the scan
    // is measuring nothing.
    expect(consumers.length).toBeGreaterThan(0);

    const unsourced = consumers.flatMap((file) => {
      const imported = [...file.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g)]
        .map((m) => m[1] ?? '')
        .join(',');
      return GUARDED.filter(
        ({ name }) => references(file.code, name) && !references(imported, name),
      ).map(({ name, owner, rule }) => `${file.path}: ${name} (${rule}) — import it from ${owner}`);
    });
    expect(unsourced).toEqual([]);
  });

  // ─── Half three: the intra-file collapses ──────────────────────────────────

  it('can still find every file it counts within', () => {
    // The anti-vacuity anchor for the count half (UT-E2). A path-keyed guard is
    // the kind that rots silently, so this fails loudly when a subject moves
    // rather than counting zero of something in a file that is no longer there.
    for (const { path, pattern } of COUNTED) {
      expect(() => sourceOf(path)).not.toThrow();
      // And the pattern must still match SOMETHING, or `expected` is being met
      // by a regex that stopped working rather than by the code being right.
      expect(occurrences(sourceOf(path), pattern)).toBeGreaterThan(0);
    }
  });

  it('counts occurrences the way the rows assume', () => {
    // The matchers, against a synthetic copy each must catch and a near-miss
    // each must not — the same discipline the two halves above follow.
    const parser = COUNTED[0]!.pattern;
    expect(occurrences('return Number.isFinite(value) && value > 0 ? value : null;', parser)).toBe(1); // prettier-ignore
    // The two parsers that legitimately stay: a percentage with a floor of zero
    // and a ceiling, and a temperature with no bound at all.
    expect(occurrences('return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;', parser)).toBe(0); // prettier-ignore
    expect(occurrences('return Number.isFinite(value) ? value : null;', parser)).toBe(0);
    // Two copies read as two, or the count can never rise.
    expect(occurrences('Number.isFinite(value) && value > 0; Number.isFinite(value) && value > 0;', parser)).toBe(2); // prettier-ignore

    const span = COUNTED[2]!.pattern;
    expect(occurrences('const span = startUserActionSpan(name);', span)).toBe(1);
    // The import is not a call site, and must not inflate the count.
    expect(occurrences("import { startUserActionSpan } from '@salt/observability';", span)).toBe(0);
  });

  it.each(COUNTED)('declares $what exactly $expected time(s) in $path', (row) => {
    // Read off disk, not asserted about a symbol this file imports — the whole
    // point is that no `vi.mock` can make it agree.
    expect(occurrences(sourceOf(row.path), row.pattern)).toBe(row.expected);
  });
});
