/**
 * Source guard: no `Intl.DateTimeFormat` is built per call (issue #940, finding
 * `A2-014`).
 *
 * Constructing a formatter resolves locale data; calling `.format()` on one that
 * exists does not. Ten call sites across five feature areas built theirs inside
 * the function that formatted, so a fourteen-row planner view constructed forty
 * of them on mount and again on every snapshot that arrived. Two screens had
 * always had it right, as a module constant. Nothing said which shape was
 * correct, so both kept being written.
 *
 * The failure it prevents is SILENT: the wrong shape renders byte-identical
 * output and passes every test in the suite. Only a profile shows it.
 *
 * ── What is allowed, and why exactly this ────────────────────────────────────
 *
 * Exactly one shape is legal: the initialiser of a top-level declaration —
 * `const CLOCK_FORMAT = new Intl.DateTimeFormat(...)` — because that runs once
 * for the life of the module, which is the whole point. Every other position
 * runs per call.
 *
 * Note what that rule is NOT. "Not nested inside braces" would be the obvious
 * reading and it is wrong: `const f = (o) => new Intl.DateTimeFormat('en-GB', o)`
 * opens no brace, so it sits at top level while constructing on every call. The
 * declaration keyword is what separates the two, and the synthetic cases below
 * pin that distinction rather than assuming it.
 *
 * `lib/dateFormat.ts` is the single exemption, and it is named here rather than
 * inferred: its construction is inside `formatterFor`, a memo that builds each
 * distinct (locale, options) pair once and hands the same object back forever.
 * A caller that passes its options in — the planner's day labels, the
 * add-to-planner night list — cannot be a constant, and that memo is the shape
 * that serves them. Exempting the file rather than pattern-matching "looks
 * cached" keeps the rule mechanical: there is one memo, in one place, and this
 * test fails if a second file starts claiming to be one.
 *
 * ── How it avoids going vacuously green (docs/unit-test-spec.md §E) ──────────
 *
 *  - The scan surface is the whole of `src`, WALKED — not a list of pages or
 *    directories. A screen written next month is covered on the day it is
 *    written (UT-E1).
 *  - It proves it can still see (UT-E2): the walk must find a substantial number
 *    of files including the ones the finding was in, the exempt module must
 *    still be there and must still contain a construction, and the depth scanner
 *    is exercised against synthetic sources — the per-call shapes it must catch
 *    AND the module constants it must not — so a broken scanner fails here
 *    rather than passing everything or failing everywhere.
 *  - It asserts on STRUCTURE — where the construction sits — never on wording,
 *    formatter options or line numbers (UT-E3).
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
 * The one module allowed to construct inside a function: it memoises, so each
 * distinct (locale, options) pair is still built exactly once.
 */
const MEMO_MODULE = join('lib', 'dateFormat.ts');

/** Every source file under `src`, found by walking — never by a hand-kept list. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.isFile()) return [];
    return entry.name.endsWith('.ts') || entry.name.endsWith('.svelte') ? [full] : [];
  });
}

/**
 * Every `new Intl.DateTimeFormat` in `source` that is NOT built once per module,
 * as `[index, snippet]` pairs.
 *
 * "Once per module" means exactly one shape: the initialiser of a top-level
 * `const`/`let`/`var` — `const CLOCK_FORMAT = new Intl.DateTimeFormat(...)`.
 *
 * Nesting depth alone is not enough, and the near-miss that proves it is a
 * concise arrow: `const f = (o) => new Intl.DateTimeFormat('en-GB', o)` opens no
 * brace at all, so it sits at depth 0 while constructing on every single call —
 * a guard checking only depth would wave through the very shape it exists to
 * stop. Requiring the declaration keyword excludes it, and excludes an argument,
 * a returned expression and a ternary branch with it.
 *
 * The scan skips comments and string/template literals so a brace inside either
 * cannot shift the count. Template substitutions (`${…}`) are scanned as code,
 * because that is what they hold, and the mode stack puts the scanner back into
 * the template when the substitution closes.
 */
function perCallConstructions(source: string): string[] {
  const NEEDLE = 'new Intl.DateTimeFormat';
  // A module-level declaration whose initialiser is the construction. Anchored
  // at the end, so it must sit immediately before the `new`.
  const CONST_INIT =
    /(?:^|[;{}\n])\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?=\s*$/;
  const found: string[] = [];
  // 'code' or 'template'; a `${` pushes 'code', its closing brace pops back.
  const modes: ('code' | 'template')[] = ['code'];
  // For each open brace, whether it was opened by a `${`.
  const substitution: boolean[] = [];
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const mode = modes[modes.length - 1]!;
    const rest = source.slice(i);
    if (mode === 'template') {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (rest.startsWith('${')) {
        modes.push('code');
        substitution.push(true);
        depth += 1;
        i += 2;
        continue;
      }
      if (source[i] === '`') {
        modes.pop();
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i]!;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (source[i] === '`') {
      modes.push('template');
      i += 1;
      continue;
    }
    if (rest.startsWith(NEEDLE)) {
      const builtOnce = depth === 0 && CONST_INIT.test(source.slice(0, i));
      if (!builtOnce) found.push(source.slice(Math.max(0, i - 40), i + NEEDLE.length).trim());
      i += NEEDLE.length;
      continue;
    }
    if (source[i] === '{') {
      depth += 1;
      substitution.push(false);
      i += 1;
      continue;
    }
    if (source[i] === '}') {
      depth -= 1;
      if (substitution.pop() === true) modes.pop();
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

const files = walk(srcDir);
const relOf = (file: string): string => relative(srcDir, file).split(sep).join('/');

describe('date formatters are built once, not per call (#940)', () => {
  it('can still see the tree it is guarding', () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(100);
    const seen = files.map(relOf);
    // Files the finding was actually in, so a moved tree fails loudly here
    // rather than quietly excusing itself.
    expect(seen).toContain('routes/mealplan/MealPlanWeekPage.svelte');
    expect(seen).toContain('routes/batches/batchDisplay.ts');
    expect(seen).toContain('lib/dateFormat.ts');
  });

  it('still finds a per-call construction in the memo module, so the exemption is not vacuous', () => {
    const memo = readFileSync(join(srcDir, MEMO_MODULE), 'utf8');
    // The exemption below excuses exactly one thing: the memo's own construction,
    // which is inside `formatterFor` and therefore per-call by this guard's rule.
    // If `dateFormat.ts` ever stops constructing one, the exemption is excusing
    // nothing and should be deleted rather than left standing.
    expect(perCallConstructions(memo).length).toBe(1);
  });

  it('rejects every per-call shape and accepts the module constant, on synthetic sources', () => {
    // The scanner is the whole guard, so it is exercised both ways rather than
    // trusted. Each of these is a shape that has actually appeared in this repo.
    const perCall = [
      "function f() {\n  return new Intl.DateTimeFormat('en-GB', {}).format(d);\n}",
      // The near-miss a depth-only guard waves through: no braces, still per call.
      "const f = (o) => new Intl.DateTimeFormat('en-GB', { ...o }).format(d);",
      'const label = $derived.by(() => {\n  return new Intl.DateTimeFormat(undefined, {}).format(d);\n});',
      "const x = cond ? new Intl.DateTimeFormat('en-GB', {}) : null;",
      "render(new Intl.DateTimeFormat('en-GB', {}));",
    ];
    for (const source of perCall) {
      expect(perCallConstructions(source)).toHaveLength(1);
    }

    const builtOnce = [
      "const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit' });",
      "const NIGHT = new Intl.DateTimeFormat('en-GB', {\n  weekday: 'short',\n});\nfunction g() { return NIGHT.format(d); }",
      "export const WIDE: Intl.DateTimeFormat = new Intl.DateTimeFormat('en-GB', {});",
    ];
    for (const source of builtOnce) {
      expect(perCallConstructions(source)).toEqual([]);
    }

    // Neither a brace in prose nor one in a string or template may shift the
    // depth, and a template must hand the scanner back after its substitution.
    expect(
      perCallConstructions(
        "// a comment with { braces }\nconst s = '} { }';\nconst F = new Intl.DateTimeFormat('en-GB', {});",
      ),
    ).toEqual([]);
    expect(
      perCallConstructions(
        'const t = `a ${b ? "{" : "}"} c`;\nconst F = new Intl.DateTimeFormat("en-GB", {});',
      ),
    ).toEqual([]);
  });

  it('builds every formatter once per module, everywhere under src', () => {
    const offenders = files.flatMap((file) => {
      const rel = relOf(file);
      if (rel === MEMO_MODULE.split(sep).join('/')) return [];
      return perCallConstructions(readFileSync(file, 'utf8')).map(
        (snippet) => `${rel}: ${snippet}`,
      );
    });
    // Every one of these rebuilds a formatter on each call. Hoist it to a module
    // constant, or route it through `lib/dateFormat.ts`.
    expect(offenders).toEqual([]);
  });
});
