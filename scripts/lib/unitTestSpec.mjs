// The mechanically-checkable half of docs/unit-test-spec.md, as matchers.
//
// The spec states 31 `UT-*` rules. Nine of them are countable off the source of
// a test file or a test project's config; the other twenty-two need a reader.
// This module is the nine, and `unit-test-spec.areas.mjs` at the repo root is
// the per-area ceiling each one is currently frozen at. The test that drives
// both is `scripts/tests/unitTestSpecGuard.test.mjs`.
//
// WHY A MODULE AND NOT JUST THE TEST. The self-tests in the test file exercise
// every matcher here against a synthetic violation and a near-miss, and both
// samples travel WITH the rule (`catches` / `misses` below) rather than in a
// hand-kept list beside them. A rule added without its two samples fails the
// guard's own completeness test. Keeping the rules in one exported array is
// what makes that iteration possible.
//
// ── How this avoids going vacuously green (unit-test-spec §E) ────────────────
//
//  - The AREAS are read out of the root `vitest.config.ts`'s `projects` array,
//    so a ninth vitest project is scanned the day it is added, and arrives with
//    no ceiling — which the guard reports rather than skipping (UT-E1).
//  - The FILES in each area are found by walking its `tests/` tree, never by a
//    list (UT-E1).
//  - Every matcher carries its own positive and near-miss samples and the guard
//    runs all of them, so a regex broken by a later edit fails there rather than
//    matching everything or nothing (UT-E2).
//  - Matching is on structure — a call, a declaration, an assignment, a path —
//    never on a sentence (UT-E3).
//  - It reads bytes off disk and imports nothing it checks, so no `vi.mock` can
//    make it agree.
//
// ── Path resolution, and UT-E4 ──────────────────────────────────────────────
//
// `scripts/` sits at the repo root, so the root is `../..` from here and every
// scanned path is BUILT from it with `join`. The literal `../../packages/` the
// rule forbids therefore never appears — which matters, because UT-E4 is one of
// the rules this file matches, and a guard tripping its own rule would have to
// exempt itself, which is the shape UT-E2 exists to prevent.
//
// ── The honest boundary ─────────────────────────────────────────────────────
//
//  - `stripComments` skips quoted strings so a `//` inside one does not eat the
//    rest of the line, but it does not parse regex literals or template-literal
//    interpolation. A comment opener inside a regex would truncate that line's
//    scan. No file in the tree does this today and the self-tests pin the
//    string case; treat it as a known limit, not a guarantee.
//  - A count is per FILE, not per occurrence: a file with eight `vi.mock` calls
//    is one UT-B1 violation, not three. The ceilings are counts of files.
//  - UT-B1's spec text permits exceeding the cap "with a comment naming why the
//    seam cannot be narrowed". That escape hatch is prose, and UT-E3 forbids
//    matching prose, so this module does not implement it. Raising the area's
//    ceiling in `unit-test-spec.areas.mjs`, with the reason in the diff, IS the
//    deliberate exception — the same act, in the place a reviewer can see it.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo root.
 *
 * `import.meta.url` is passed to `fileURLToPath` as a STRING, deliberately: the
 * `.mjs` suites run under `environment: 'node'` today, but a jsdom project's
 * global `URL` is whatwg-url, and `fileURLToPath(new URL('..', import.meta.url))`
 * throws "The URL must be of scheme file" there. The string form works in both.
 */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The vitest projects, read out of the root config rather than restated.
 *
 * Returns each project's ROOT directory — `packages/domain/vitest.config.ts`
 * becomes `packages/domain` — which is what an area is keyed by.
 */
export function unitTestAreas(root = repoRoot) {
  const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  const block = /projects:\s*\[([^\]]*)\]/.exec(stripComments(config));
  if (block === null) throw new Error('vitest.config.ts declares no `projects` array');
  return [...block[1].matchAll(/['"]([^'"]+)vitest\.config\.ts['"]/g)].map((m) =>
    m[1].replace(/\/$/, ''),
  );
}

const COMMENTS = [
  ['/*', '*/'],
  ['//', '\n'],
];
const QUOTES = ['"', "'", '`'];

/**
 * Strip comments, keeping string literals intact.
 *
 * Both halves matter. Comments go because the spec's own rule names appear in
 * prose all over this repo — `docs/unit-test-spec.md` quotes a `../../../../packages/`
 * path escape, and so does the header above — and a mention must never count as
 * an instance (that is a self-test case below). Strings STAY because an import
 * specifier is a string, and UT-E4 is a rule about import specifiers.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const comment = COMMENTS.find(([open]) => src.startsWith(open, i));
    if (comment !== undefined) {
      const [open, close] = comment;
      const end = src.indexOf(close, i + open.length);
      i = end === -1 ? src.length : end + close.length;
      out += close === '\n' ? '\n' : ' ';
      continue;
    }
    const quote = QUOTES.find((q) => src.startsWith(q, i));
    if (quote !== undefined) {
      out += src[i];
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      out += src[i] ?? '';
      i += 1;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Every file under `dir` matching `suffixes`, found by walking. */
function walk(dir, suffixes) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, suffixes);
    if (!entry.isFile()) return [];
    return suffixes.some((s) => entry.name.endsWith(s)) ? [full] : [];
  });
}

const posix = (p) => p.split(sep).join('/');

const count = (code, pattern) => [...code.matchAll(pattern)].length;

/**
 * The per-file rules, each with the two samples that pin its matcher.
 *
 * `catches` are lines the matcher MUST fire on — every one of them is a real
 * shape taken from the tree. `misses` are the near-misses it must not, which is
 * the half that stops a matcher from being widened into noise. The guard
 * asserts both for every rule, and asserts that every rule has both.
 */
export const FILE_RULES = [
  {
    id: 'UT-A1',
    what: 'every assertion in the file is toHaveBeenCalled*',
    // File-level, which is weaker than the rule as written (the rule is per
    // `it(`) and is the honest limit of a regex: finding an `it(` body needs a
    // parser. A file with no other kind of assertion anywhere is the shape the
    // spec's own _Verify:_ line describes, and is what is counted.
    violates: (code) => {
      const expects = count(code, /\bexpect\s*\(/g);
      return expects > 0 && count(code, /\.toHaveBeenCalled/g) >= expects;
    },
    catches: [
      'expect(setDoc).toHaveBeenCalled();\nexpect(logger.info).toHaveBeenCalledTimes(1);',
      'expect(enqueue).not.toHaveBeenCalled();',
    ],
    misses: [
      'expect(setDoc).toHaveBeenCalledWith(ref, doc);\nexpect(result.ok).toBe(true);',
      'expect(items).toEqual([]);',
      // No assertions at all is a different defect and not this one.
      'const x = 1;',
    ],
  },
  {
    id: 'UT-B1',
    what: 'more than 5 vi.mock calls',
    violates: (code) => count(code, /\bvi\.mock\s*\(/g) > 5,
    catches: [Array.from({ length: 6 }, (_, i) => `vi.mock('./m${i}.js');`).join('\n')],
    misses: [
      Array.from({ length: 5 }, (_, i) => `vi.mock('./m${i}.js');`).join('\n'),
      'vi.mocked(setDoc).mockResolvedValue(undefined);',
      'vi.doMock("./a.js"); vi.doMock("./b.js");',
    ],
  },
  {
    id: 'UT-C1',
    what: 'declares a local makeStore instead of importing tests/support/testStore.ts',
    areas: ['apps/web-pwa'],
    violates: (code) => /\b(?:const|let|function)\s+makeStore\b/.test(code),
    catches: [
      'function makeStore<T>(initial: T) {',
      'const makeStore = <T,>(initial: T) => ({ subscribe });',
    ],
    misses: [
      "import { makeStore } from './support/testStore.js';",
      'const store = makeStore(recipes);',
      'const makeStoreFake = () => ({ subscribe });',
    ],
  },
  {
    id: 'UT-C2',
    what: 'hand-rolls makeRecipe instead of the @salt/domain builders',
    violates: (code) => /\b(?:const|let|function)\s+makeRecipe\b/.test(code),
    catches: [
      'function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {',
      'const makeRecipe = (id: string): Recipe => ({ ...emptyRecipe(), id });',
    ],
    misses: [
      "import { emptyRecipe } from '@salt/domain';",
      'const recipe = makeRecipe("r1");',
      'const makeRecipeRow = (r: Recipe) => ({ id: r.id });',
    ],
  },
  {
    id: 'UT-C3',
    what: 'resets document.body.style.pointerEvents, which tests/setup.ts already does',
    areas: ['apps/web-pwa'],
    violates: (code) => /document\.body\.style\.pointerEvents\s*=/.test(code),
    catches: ["document.body.style.pointerEvents = '';", 'document.body.style.pointerEvents = "";'],
    misses: [
      "expect(document.body.style.pointerEvents).toBe('');",
      "el.style.pointerEvents = 'none';",
    ],
  },
  {
    id: 'UT-E4',
    what: 'escapes its package with a ../../ path into packages/ or apps/',
    violates: (code) => /(?:\.\.\/){2,}(?:packages|apps)\//.test(code),
    catches: [
      "import { emptyRecipe } from '../../../../packages/domain/src/index.js';",
      "readFileSync(join(here, '../../apps/web-pwa/src/app.css'));",
    ],
    misses: [
      "import { emptyRecipe } from '@salt/domain';",
      "import { load } from '../../src/lib/recipeService.js';",
      "join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages');",
      // A mention is not an instance — the exact shape this guard's own header
      // and two sibling guard files use to explain UT-E4 in prose.
      '// see ../../../../packages/domain/src/index.js',
    ],
  },
];

/**
 * The area a config rule's samples are written into. Two segments, because a
 * one-segment area would not exercise the path joining.
 */
export const SAMPLE_AREA = 'pkg/thing';

/**
 * The per-area config rules. These are shapes of a project's wiring rather than
 * of a test file, so they are counted over the area itself — but they land in
 * the same per-area, per-rule ceiling map, so one ratchet covers all nine.
 *
 * Their `catches`/`misses` are FILE MAPS rather than snippets — the subject is a
 * directory layout, so a sample has to be one. The guard writes each into a
 * throwaway directory and runs the real matcher over it.
 */
export const AREA_RULES = [
  {
    id: 'UT-G1',
    what: 'has a tsconfig.test.json that the root typecheck script never runs',
    catches: [
      {
        'package.json': '{ "scripts": { "typecheck": "tsc --build" } }',
        'pkg/thing/tsconfig.test.json': '{}',
      },
    ],
    misses: [
      {
        'package.json': '{ "scripts": { "typecheck": "tsc -p pkg/thing/tsconfig.test.json" } }',
        'pkg/thing/tsconfig.test.json': '{}',
      },
      // No config at all is not a violation: UT-G1 binds a directory that HAS
      // one, and a package with no TypeScript tests needs none.
      { 'package.json': '{ "scripts": { "typecheck": "tsc --build" } }' },
    ],
    violations: (area, root) => {
      const config = `${area}/tsconfig.test.json`;
      if (!existsSync(join(root, config))) return [];
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      return (pkg.scripts?.typecheck ?? '').includes(config) ? [] : [config];
    },
  },
  {
    id: 'UT-G3',
    what: 'sets a retry count in its vitest config',
    catches: [{ 'pkg/thing/vitest.config.ts': 'export default { test: { retry: 2 } };' }],
    misses: [
      { 'pkg/thing/vitest.config.ts': "export default { test: { pool: 'threads' } };" },
      // A comment saying the suite has no retries must not read as one.
      { 'pkg/thing/vitest.config.ts': '// no retry here, ever (UT-G3)\nexport default {};' },
      { 'pkg/thing/vitest.config.ts': 'export default { test: { retryOnFailureDisabled: 1 } };' },
    ],
    violations: (area, root) => {
      const config = `${area}/vitest.config.ts`;
      const path = join(root, config);
      if (!existsSync(path)) return [];
      return /\bretry\b/.test(stripComments(readFileSync(path, 'utf8'))) ? [config] : [];
    },
  },
  {
    id: 'UT-G4',
    what: 'has .test-d.ts files with no tsconfig.typetest.json wired into vitest',
    catches: [
      // The config file exists and nothing points vitest at it — the half of
      // UT-G4 that leaves every `expectTypeOf` assertion unrun (#932).
      {
        'pkg/thing/tests/x.types.test-d.ts': 'expectTypeOf(1).toEqualTypeOf<number>();',
        'pkg/thing/tsconfig.typetest.json': '{}',
        'pkg/thing/vitest.config.ts': "export default { test: { name: 'thing' } };",
      },
      // And the other half: vitest is wired, the config it names does not exist.
      {
        'pkg/thing/tests/x.types.test-d.ts': 'expectTypeOf(1).toEqualTypeOf<number>();',
        'pkg/thing/vitest.config.ts':
          "export default { test: { typecheck: { enabled: true, tsconfig: './tsconfig.typetest.json' } } };",
      },
      // A commented-out `enabled: true` must not read as wired — this is #932
      // verbatim: every `expectTypeOf` silently unrun, with the config that
      // would have wired it in sitting right there, disabled.
      {
        'pkg/thing/tests/x.types.test-d.ts': 'expectTypeOf(1).toEqualTypeOf<number>();',
        'pkg/thing/tsconfig.typetest.json': '{}',
        'pkg/thing/vitest.config.ts':
          "// typecheck: { enabled: true, tsconfig: './tsconfig.typetest.json' },\nexport default {};",
      },
    ],
    misses: [
      {
        'pkg/thing/tests/x.types.test-d.ts': 'expectTypeOf(1).toEqualTypeOf<number>();',
        'pkg/thing/tsconfig.typetest.json': '{}',
        'pkg/thing/vitest.config.ts':
          "export default { test: { typecheck: { enabled: true, tsconfig: './tsconfig.typetest.json' } } };",
      },
      // No `.test-d.ts` files: the rule has nothing to bind.
      { 'pkg/thing/tests/x.test.ts': "it('works', () => {});" },
    ],
    violations: (area, root) => {
      const typeTests = walk(join(root, area, 'tests'), ['.test-d.ts']);
      if (typeTests.length === 0) return [];
      const config = join(root, area, 'vitest.config.ts');
      const wired =
        existsSync(join(root, area, 'tsconfig.typetest.json')) &&
        existsSync(config) &&
        /typecheck:\s*\{[^}]*enabled:\s*true/s.test(stripComments(readFileSync(config, 'utf8')));
      return wired ? [] : [`${area}/vitest.config.ts`];
    },
  },
];

/** Every rule id this module enforces, in declaration order. */
export const RULE_IDS = [...FILE_RULES, ...AREA_RULES].map((r) => r.id);

/** Every test file in an area, walked from its `tests/` directory. */
export function testFilesIn(area, root = repoRoot) {
  return walk(join(root, area, 'tests'), ['.test.ts', '.test.mjs']).map((path) => ({
    path: posix(relative(root, path)),
    code: stripComments(readFileSync(path, 'utf8')),
  }));
}

/**
 * Every violation in the repo, as `{ area, rule, file }` rows.
 *
 * One flat list rather than a nested map: the guard groups it, and a flat list
 * is what a failure message needs to name files.
 */
export function scanViolations(root = repoRoot) {
  return unitTestAreas(root).flatMap((area) => {
    const files = testFilesIn(area, root);
    const fromFiles = FILE_RULES.flatMap((rule) =>
      (rule.areas ?? [area]).includes(area)
        ? files
            .filter((f) => rule.violates(f.code))
            .map((f) => ({ area, rule: rule.id, file: f.path }))
        : [],
    );
    const fromArea = AREA_RULES.flatMap((rule) =>
      rule.violations(area, root).map((file) => ({ area, rule: rule.id, file })),
    );
    return [...fromFiles, ...fromArea];
  });
}
