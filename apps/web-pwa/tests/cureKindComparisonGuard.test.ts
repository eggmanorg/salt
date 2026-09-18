/**
 * Source guard: no `.svelte` file decides anything from `'cure'` or a cure
 * category (issue #1404).
 *
 * CLAUDE.md is explicit that nothing outside `packages/domain` branches on
 * `recipes.kind` for behaviour: capability comes from the pure predicates, and a
 * direct comparison is permitted only to pick words, pictures or identity. #1404
 * extends the same discipline to `cureCategory`, which is identity and grouping
 * and decides nothing about what is allowed or possible.
 *
 * The convention held for the four kinds that came before because there was
 * nothing tempting to write: this one is different. A cure is the first kind with
 * a FIELD OF ITS OWN, and the obvious way to render a control for a field only one
 * kind has is `{#if recipe.kind === 'cure'}`. That line compiles, passes every
 * other gate, reads as sensible, and is the exact thing the rule forbids — so the
 * rule needed a mechanism rather than a sentence (CLAUDE.md rule 12).
 *
 * What the app does instead: `KIND_COPY` declares a `categoryCopy` on exactly one
 * kind, and `RecipeIdentityCard` renders the editor when the kind's copy declares
 * one. That is byte for byte the `tagsHint` pattern, whose own header argues the
 * case — a vocabulary that is simply undefined for four kinds is copy, not a
 * branch on behaviour.
 *
 * ── Why the SUBJECT is narrow and the SURFACE is not ─────────────────────────
 *
 * It forbids the five category values and `'cure'`, not every kind, and that is
 * deliberate rather than timid: `'recipe'`, `'special'`, `'cocktail'` and
 * `'placeholder'` are also the names of unrelated things a Svelte file legitimately
 * compares against — `source.kind === 'recipe'` on a shopping-list source, a
 * `sortMode === 'recipe'` chip — so a guard over all of them would fire on code
 * that has nothing to do with a recipe's kind. The five category values and
 * `'cure'` are words nothing else in this app uses.
 *
 * ── How it avoids going vacuously green (docs/unit-test-spec.md §E) ──────────
 *
 *  - The forbidden values are read out of `CureCategorySchema` itself, so a sixth
 *    category is covered on the day it is added, with no list to maintain (UT-E1).
 *  - The scan surface is every `.svelte` file under `src`, walked — not a list of
 *    pages — so a second surface that wants a category is covered the day it is
 *    written (UT-E1).
 *  - The matcher is exercised against both a synthetic violation it must catch and
 *    near-misses it must not, so a regex broken by a later edit fails here rather
 *    than passing everything or failing everywhere (UT-E2).
 *  - It asserts on comparisons, never on the wording of the comments beside them
 *    and never on a line number (UT-E3).
 *
 * ── Its honest boundary ──────────────────────────────────────────────────────
 *
 * It catches a comparison written as a LITERAL in a `.svelte` file. It cannot see
 * a comparison against a value held in a variable (`kind === theCureKind`), and it
 * does not scan `.ts` files, where `recipeKind.ts` legitimately names `cure` as a
 * copy-table key. What it pins is the shape the temptation actually takes, which
 * is the literal, in the file the rule is about.
 *
 * It is a genuine source scan — it reads bytes off disk and never imports the
 * components it checks, so no `vi.mock` can make it agree.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { CureCategorySchema } from '@salt/domain/schemas';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every `.svelte` file under `src`, found by walking — never by a hand-kept list. */
function walkSvelte(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkSvelte(full);
    if (!entry.isFile()) return [];
    return entry.name.endsWith('.svelte') ? [full] : [];
  });
}

// The three comment forms a `.svelte` file can carry, each as its opener and what
// closes it. Copied in shape from `timerDefaultsGuard.test.ts`, which argues why
// a single left-to-right pass needs no ordering rule: whichever opener appears
// first wins, so a half-stripped comment cannot invent or hide a match.
const COMMENTS: readonly (readonly [open: string, close: string])[] = [
  ['<!--', '-->'],
  ['/*', '*/'],
  ['//', '\n'],
];

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

/**
 * The words no `.svelte` file may compare against: the stored kind, and every
 * category the schema knows. Read off `CureCategorySchema` rather than retyped,
 * so a sixth category joins the guard on the day it is added.
 */
const FORBIDDEN: readonly string[] = ['cure', ...CureCategorySchema.options];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * A comparison against one of those words, in either operand order and in either
 * quote style. `===`, `!==` and a `case` arm are the three shapes a branch on a
 * literal actually takes in this codebase.
 */
function comparisons(code: string): string[] {
  return FORBIDDEN.flatMap((value) => {
    const v = escapeRegExp(value);
    const quoted = String.raw`['"\`]${v}['"\`]`;
    const patterns = [
      new RegExp(String.raw`[!=]==\s*${quoted}`),
      new RegExp(`${quoted}\\s*[!=]==`),
      new RegExp(String.raw`\bcase\s+${quoted}`),
    ];
    return patterns.some((p) => p.test(code)) ? [value] : [];
  });
}

const files = walkSvelte(srcDir);

describe('no .svelte file branches on a cure kind or category (issue #1404)', () => {
  it('sees a real tree of components', () => {
    // UT-E2: the walk finding nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('RecipeIdentityCard.svelte'))).toBe(true);
    // And the subject is derived, not stated: six words, one kind plus five
    // categories, read off the schema.
    expect(FORBIDDEN).toHaveLength(1 + CureCategorySchema.options.length);
  });

  it('catches the violation it exists for, and clears the shapes that are fine', () => {
    // UT-E2: the matcher exercised both ways, so a broken regex fails HERE rather
    // than passing every file or failing all of them.
    expect(comparisons(`{#if recipe.kind === 'cure'}`)).toEqual(['cure']);
    expect(comparisons(`{#if kindOf(r) !== "cure"}`)).toEqual(['cure']);
    expect(comparisons("case 'dry_cured_whole_muscle':")).toEqual(['dry_cured_whole_muscle']);
    expect(comparisons(`{#if recipe.cureCategory === 'semi_dry'}`)).toEqual(['semi_dry']);

    // The sanctioned shapes, which must stay clear: reading words out of the copy
    // table, rendering the vocabulary a kind declares, and writing a value back.
    expect(comparisons('KIND_COPY[kindOf(recipe)].categoryCopy')).toEqual([]);
    expect(comparisons('{#if categoryCopy}')).toEqual([]);
    expect(comparisons('onEdit({ ...recipe, cureCategory: toCureCategory(v) })')).toEqual([]);
    // A capability question, which is the whole point of the predicates.
    expect(comparisons('isPlannable(kindOf(recipe))')).toEqual([]);
  });

  it('finds no such comparison anywhere under src', () => {
    const offenders = files.flatMap((file) => {
      const hits = comparisons(stripComments(readFileSync(file, 'utf8')));
      return hits.length === 0 ? [] : [`${relative(srcDir, file)}: ${hits.join(', ')}`];
    });
    expect(offenders).toEqual([]);
  });
});
