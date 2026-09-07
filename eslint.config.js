import { readdirSync } from 'node:fs';

import boundaries from 'eslint-plugin-boundaries';
import tsParser from '@typescript-eslint/parser';
import svelteParser from 'svelte-eslint-parser';
import playwright from 'eslint-plugin-playwright';
import sonarjs from 'eslint-plugin-sonarjs';

// Element definitions used by eslint-plugin-boundaries.
const ELEMENTS = [
  {
    type: 'shared-types',
    pattern: ['packages/shared-types/**', '@salt/shared-types'],
  },
  {
    type: 'domain',
    pattern: ['packages/domain/**', '@salt/domain'],
  },
  {
    type: 'firebase-sync',
    pattern: ['packages/adapters/firebase-sync/**', '@salt/firebase-sync'],
  },
  {
    type: 'observability',
    pattern: ['packages/adapters/observability/**', '@salt/observability'],
  },
  {
    type: 'ui-components',
    pattern: ['packages/ui-components/**', '@salt/ui-components'],
  },
  {
    type: 'web-pwa',
    pattern: ['apps/web-pwa/**', '@salt/web-pwa'],
  },
  {
    type: 'cloud-functions',
    pattern: ['apps/cloud-functions/**', '@salt/cloud-functions'],
  },
  {
    type: 'storybook',
    pattern: ['apps/storybook/**', '@salt/storybook'],
  },
];

// Import specifier patterns that must never appear in certain layers.
const FIREBASE_PKGS = ['firebase', 'firebase/*', 'firebase-admin', 'firebase-admin/*'];
// Browser storage packages forbidden everywhere — Firestore's persistentLocalCache is the offline layer.
const INDEXEDDB_PKGS = ['idb', 'idb/*', 'idb-keyval', 'idb-keyval/*', 'dexie', 'dexie/*'];
// PostHog SDKs may be imported only inside @salt/observability, which wraps
// them behind the ErrorReporting / MatchLogging ports (browser posthog-js on
// the default subpath, posthog-node on /server). Everything else — apps
// included — depends on those ports, never the SDK directly. depcruise's
// no-posthog-outside-observability closes the same gap over the resolved tree.
const POSTHOG_PKGS = ['posthog-js', 'posthog-js/*', 'posthog-node', 'posthog-node/*'];
const POSTHOG_MESSAGE =
  'PostHog SDK imports (posthog-js / posthog-node) are only allowed in @salt/observability. Depend on the @salt/observability ports (default subpath in web-pwa, /server in cloud-functions) instead.';
const SALT_APP_IMPORTS = [
  '@salt/web-pwa',
  '@salt/web-pwa/*',
  '@salt/cloud-functions',
  '@salt/cloud-functions/*',
  '@salt/storybook',
  '@salt/storybook/*',
];

// UI-primitive libraries. web-pwa must reach these only through
// @salt/ui-components (Rule 7) — a direct import bypasses the wrapper layer.
// ui-components itself owns these deps and imports them directly.
const UI_PRIMITIVE_PKGS = [
  'bits-ui',
  'bits-ui/*',
  'shadcn-svelte',
  'shadcn-svelte/*',
  'melt-ui',
  'melt-ui/*',
  '@melt-ui/svelte',
  '@melt-ui/*',
];
const UI_PRIMITIVE_MESSAGE =
  'UI primitives (bits-ui / shadcn-svelte / melt-ui) must be imported via @salt/ui-components, never directly (Rule 7).';

// Node built-ins + browser storage globals forbidden in @salt/domain: the domain
// layer is pure (no I/O, no Node, no browser APIs). `node:*` covers the modern
// prefix; the bare names cover the legacy specifier form.
const NODE_BUILTIN_PKGS = [
  'node:*',
  'fs',
  'fs/*',
  'path',
  'os',
  'crypto',
  'util',
  'stream',
  'child_process',
  'http',
  'https',
  'net',
  'zlib',
  'events',
];
const DOMAIN_NODE_MESSAGE =
  '@salt/domain is pure — no Node built-ins or I/O. Move platform code into an adapter.';
// Node built-ins restricted by EXACT NAME rather than by pattern, because a
// pattern would also match a relative import (a `group` is matched with
// gitignore semantics, so a bare segment matches ANYWHERE in the specifier).
// `process` is the one that bites: `packages/domain/src/process/` is a real
// domain module (the stage model, issue #806), and as a pattern `'process'`
// rejected `./process/index.js` with a message about Node built-ins. `paths`
// means "this exact specifier", which is what "the Node builtin" actually is.
// `node:process` is still covered by the `node:*` pattern above.
const NODE_BUILTIN_NAMES = [{ name: 'process', message: DOMAIN_NODE_MESSAGE }];
const DOMAIN_BROWSER_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'navigator',
];
const DOMAIN_BROWSER_GLOBALS_MESSAGE =
  '@salt/domain is pure — no browser APIs. Move platform code into an adapter.';

// Stage 1–4 / stage 5 internals that must only be reached via findClosestMatch
// (or, in domain itself, matchOrCreate). Apps must never call these directly.
// @salt/firebase-sync — the SDK entry points that exist exactly once (issue #928).
//
// `onSnapshot`, `getFunctions` and `httpsCallable` are how a live read and a
// callable are STARTED, and the package spent most of its life with 14 copies of
// the first and 30 of the last two. Each copy was free to answer a corrupt
// document differently, forward a raw error or not, forget `success()`, or omit
// the client timeout its Cloud Function needed — and every one of those actually
// happened (#928 findings B2-008, B2-009, B2-010, B2-014, B2-015). Collapsing
// them onto three helpers fixed the instances; this is what stops the next copy,
// because a copy is now a lint error rather than a code-review catch.
//
// The three helpers below are the exemption, granted by SCOPE (they are excluded
// from the block carrying this rule) rather than by an allowlist inside it. A
// module that genuinely needs its own entry point carries an `eslint-disable`
// with the reason written AT THE LINE — `init.ts`'s emulator wiring is the one
// such case today — so a fourth exemption is visible in a diff instead of buried
// in a config array.
// The restrictions every file in the package carries, helpers included. Named
// once because two config blocks below need the identical list — see the second
// block for why it cannot simply be inherited.
// (`forbidGroup` is a function declaration, so it is hoisted above this line.)
const FIREBASE_SYNC_PATTERNS = [
  ...forbidGroup(SALT_APP_IMPORTS, 'Adapters must not import from apps.'),
  ...forbidGroup(INDEXEDDB_PKGS, 'Browser storage (IndexedDB) imports are forbidden.'),
  ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
  ...forbidGroup(
    ['@salt/observability', '@salt/observability/*'],
    'Adapters must not import each other. Compose them at the application layer.',
  ),
];

const FIREBASE_SYNC_HELPERS = [
  'packages/adapters/firebase-sync/src/subscribeCollection.ts',
  'packages/adapters/firebase-sync/src/subscribeDocument.ts',
  'packages/adapters/firebase-sync/src/callFunction.ts',
];

const FIREBASE_SYNC_SDK_ENTRY_POINTS = [
  {
    name: 'firebase/firestore',
    importNames: ['onSnapshot'],
    message:
      'Start a live read through subscribeCollection.ts or subscribeDocument.ts, not onSnapshot directly (issue #928). Those two own the parse loop, the rejection log and the onError contract; a fifteenth private listener is free to diverge on all three.',
  },
  {
    name: 'firebase/functions',
    importNames: ['getFunctions', 'httpsCallable'],
    message:
      'Call a Cloud Function through callFunction.ts, not httpsCallable directly (issue #928). It owns the region, the traceparent payload field, the client timeout and classifyCallableError; a thirty-first private wrapper is free to forget any of them.',
  },
];

// Canon stage internals. These three constants are consumed by four `files:`
// blocks below and by nothing else, and every one of those blocks scopes to
// `apps/**` or to an app's `__boundary_tests__` fixture. That scope is
// deliberate, and worth stating because it is easy to over-read (issue #971).
//
// What this rule guarantees, stated at its real width (issue #1269): neither app
// can IMPORT a single stage — not by name off `@salt/domain`, not by deep
// subpath. That is a real boundary and the two fixtures assert it.
//
// It does NOT guarantee that an app never evaluates a stage's logic, and the
// stronger reading ("neither app can reach past `findClosestMatch` into a single
// stage") is false today. `normaliseName` is unrestricted and on the canon
// barrel, so `apps/cloud-functions/src/flows/canonicaliseRecipeIngredients.ts`
// re-types stage 1 by hand as `normaliseName(c.name) === normaliseName(target)`
// when it builds `canonIdByNormalisedName` — legally, and for a reason the
// pipeline cannot serve (it needs a name→id map over the batch's candidate list,
// not a match verdict). An import rule cannot see an expression, and no rule
// keyed on a specifier ever could.
//
// It also does not, and structurally cannot, guarantee anything inside
// `packages/domain/src/canon` itself. In there the stages are ordinary siblings
// imported by relative path, which a `no-restricted-imports` rule keyed on
// `@salt/domain` cannot see. So this rule was never what kept stages 1 and 3
// honest with each other — the agreement test in
// `packages/domain/tests/canon/findClosestMatch.test.ts` is: it holds stages 1
// and 3 to the same verdict on every case in its table, so if the exact-name
// predicate ever drifts between them, that test goes red. It detects future
// divergence — it was green against the duplication itself and cannot claim to
// have caught that. What both halves genuinely share is `normaliseName`, which
// is single-sourced and is where every folding decision actually lives.
//
// Adding `packages/domain/**` here would be a different guard for a different
// problem (another domain module reaching into canon's internals cross-package)
// and was deliberately left to its own issue rather than smuggled into #971.
// The list is still kept complete — an honest enumeration of the stages, for
// the same reason as the derived-module-list note below (issue #914).
const STAGE_INTERNAL_NAMES = [
  'exactNameMatch',
  'tokenMatch',
  'stringSimilarity',
  'synonymMatch',
  'embedMatch',
];
const STAGE_INTERNAL_SUBPATHS = [
  '@salt/domain/**/queries/exactNameMatch*',
  '@salt/domain/**/queries/tokenMatch*',
  '@salt/domain/**/queries/stringSimilarity*',
  '@salt/domain/**/queries/synonymMatch*',
  '@salt/domain/**/queries/embedMatch*',
];
const STAGE_INTERNAL_MESSAGE =
  'Stage 1–5 internals (exactNameMatch, tokenMatch, stringSimilarity, synonymMatch, embedMatch) must not be called directly from apps. Use findClosestMatch (which composes stages 1–4) or call the matchOrCreateCanon CF.';

function forbidGroup(pkgs, message) {
  return pkgs.map((g) => ({ group: [g], message }));
}

// Domain submodules, DERIVED from the directory listing rather than listed by
// hand (issue #914). A hand-maintained list silently loses coverage the moment
// somebody scaffolds a module and forgets to add its name here — which is
// exactly what happened: five names were listed while packages/domain/src held
// twenty-one directories, so sixteen modules were covered by neither the
// cross-module subpath rule nor the coordinator rule. Deriving makes the guard
// structural: a new directory is a module the moment it exists, and the only
// way out is to name it in DOMAIN_NON_MODULE_DIRS below, which is a visible,
// reviewable act rather than an omission.
//
// Everything under packages/domain/src IS a module except these:
//   - schemas       the @salt/domain/schemas subpath — shared zod shapes every
//                   module reads, not a module with internals of its own.
//   - prompts       the @salt/domain/prompts subpath (#934) — model-facing prose
//                   that two packages must state and that rule 6 leaves nowhere
//                   else to live. Exported constants, exactly like schemas: no
//                   entities/ports/commands/queries internals to protect.
//   - coordinators  has its own config block below, with the inverse rule
//                   (coordinators may reach across modules; modules may not
//                   reach into coordinators). Treating it as a module would
//                   forbid a coordinator from importing its own siblings.
//   - __boundary_tests__  deliberate-violation fixtures; globally ignored.
const DOMAIN_SRC_DIR = new URL('./packages/domain/src/', import.meta.url);
const DOMAIN_NON_MODULE_DIRS = new Set([
  'schemas',
  'prompts',
  'coordinators',
  '__boundary_tests__',
]);
const DOMAIN_MODULES = readdirSync(DOMAIN_SRC_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !DOMAIN_NON_MODULE_DIRS.has(entry.name))
  .map((entry) => entry.name)
  .sort();
// Subfolders that constitute a domain module's internals. Cross-module
// subpath imports into these are forbidden — go through the module index.
const DOMAIN_INTERNAL_SUBFOLDERS = ['entities', 'ports', 'commands', 'queries'];

function crossModuleSubpathPatterns(modules) {
  const patterns = [];
  for (const mod of modules) {
    for (const sub of DOMAIN_INTERNAL_SUBFOLDERS) {
      patterns.push(`**/${mod}/${sub}`);
      patterns.push(`**/${mod}/${sub}/**`);
    }
  }
  return patterns;
}

const COORDINATOR_PATTERNS = ['**/coordinators', '**/coordinators/**'];

const DOMAIN_BASE_PATTERNS = [
  ...forbidGroup(
    SALT_APP_IMPORTS,
    'Packages must not import from apps. Apps are leaf nodes in the dependency graph.',
  ),
  ...forbidGroup(
    FIREBASE_PKGS,
    'Firebase SDK imports are only allowed in @salt/firebase-sync. Use the domain port instead.',
  ),
  ...forbidGroup(
    INDEXEDDB_PKGS,
    'Browser storage (IndexedDB) imports are forbidden — use the Firestore persistent cache instead.',
  ),
  ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
  ...forbidGroup(NODE_BUILTIN_PKGS, DOMAIN_NODE_MESSAGE),
  ...forbidGroup(
    [
      '@salt/firebase-sync',
      '@salt/firebase-sync/*',
      '@salt/observability',
      '@salt/observability/*',
      '@salt/ui-components',
      '@salt/ui-components/*',
    ],
    '@salt/domain may only import @salt/shared-types from the workspace.',
  ),
];

// Browser + Node globals forbidden in @salt/domain (pure layer). Applied via
// no-restricted-globals on the domain catch-all block; not overridden by the
// per-module/coordinator blocks (they only set no-restricted-imports).
const DOMAIN_RESTRICTED_GLOBALS = [
  ...DOMAIN_BROWSER_GLOBALS.map((name) => ({ name, message: DOMAIN_BROWSER_GLOBALS_MESSAGE })),
  { name: 'process', message: DOMAIN_NODE_MESSAGE },
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/storybook-static/**',
      '**/coverage/**',
      '**/.svelte-kit/**',
      '**/__boundary_tests__/**',
      '**/.boundary-tests/**',
      // Linked worktrees are duplicate checkouts of this same repo — linting
      // them is pure waste AND actively harmful. Measured on 2026-08-11 (eslint
      // 10.8.0): 6340 of 7542 files linted came from here, 84% of every run,
      // 30s vs 10s scoped. Worse, a stale worktree whose node_modules no longer
      // resolves a plugin fails `pnpm lint` on a clean main with errors like
      // "Definition for rule 'playwright/no-wait-for-timeout' was not found",
      // pointing at code the author never touched — a deterministic local-only
      // red that CI (which checks out fresh) never reproduces.
      // NB: this regressed with eslint 10's flat-config CLI glob resolution —
      // a leading dot used not to be matched by `**`, which is why the
      // identically-shaped `format:check` prettier glob still surfaces nothing
      // from here and needs no equivalent entry.
      '**/.claude/worktrees/**',
    ],
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
  },

  // .svelte files: parse the component with svelte-eslint-parser and its
  // <script lang="ts"> block with the TS parser, so `import` statements inside
  // <script> are visible to no-restricted-imports / boundaries. Only the parser
  // is wired in (not eslint-plugin-svelte's rule set) — the goal is import-graph
  // enforcement, not Svelte style linting (issue #413). The boundary rule blocks
  // below extend their globs to `.{ts,svelte}` so a <script> import cannot
  // bypass the layer contract.
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
    },
  },

  // e2e Playwright specs: mechanise the NF-spec flake rules via the plugin's
  // flat/recommended set — errors on the correctness rules (missing-playwright-await,
  // prefer-web-first-assertions, no-networkidle, no-focused-test, valid-*), warns on
  // style. no-eval is OFF — the window.__e2e bridge runs via page.evaluate. The two
  // legit negative-hold waitForTimeouts carry inline eslint-disable + NF-A2 reasons.
  {
    files: ['apps/web-pwa/e2e/**/*.ts'],
    plugins: { playwright },
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-eval': 'off',
    },
  },

  // boundaries: file-path-based import graph enforcement (packages only — apps are leaf nodes)
  {
    files: ['packages/**/*.{ts,svelte}'],
    plugins: { boundaries },
    settings: { 'boundaries/elements': ELEMENTS },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'shared-types', allow: [] },
            { from: 'domain', allow: ['shared-types'] },
            { from: 'firebase-sync', allow: ['domain', 'shared-types'] },
            { from: 'observability', allow: ['domain', 'shared-types'] },
            { from: 'ui-components', allow: [] },
            {
              from: 'web-pwa',
              allow: ['shared-types', 'domain', 'firebase-sync', 'observability', 'ui-components'],
            },
            {
              from: 'cloud-functions',
              allow: ['shared-types', 'domain', 'observability'],
            },
          ],
        },
      ],
    },
  },

  // Generic default: packages and boundary-test fixtures must not import apps.
  {
    files: ['packages/**/*.{ts,svelte}', '**/.boundary-tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbidGroup(
            SALT_APP_IMPORTS,
            'Packages must not import from apps. Apps are leaf nodes in the dependency graph.',
          ),
        },
      ],
    },
  },

  // @salt/domain — catch-all: must not import firebase, IndexedDB, Node built-ins,
  // or anything outside shared-types, and must not touch browser/Node globals.
  // Per-module and coordinator rules below override no-restricted-imports for
  // files within those scopes, but no-restricted-globals (set only here) still
  // applies to them.
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: NODE_BUILTIN_NAMES, patterns: DOMAIN_BASE_PATTERNS },
      ],
      'no-restricted-globals': ['error', ...DOMAIN_RESTRICTED_GLOBALS],
    },
  },

  // Per-module rules: each domain module may only import the published index
  // of sibling modules, never their internals. Modules must not depend on
  // coordinators.
  ...DOMAIN_MODULES.map((mod) => ({
    files: [`packages/domain/src/${mod}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTIN_NAMES,
          patterns: [
            ...DOMAIN_BASE_PATTERNS,
            ...forbidGroup(
              crossModuleSubpathPatterns(DOMAIN_MODULES.filter((m) => m !== mod)),
              'Cross-module subpath imports are forbidden. Import the sibling module via its published index (e.g. "../canon"), not its internals.',
            ),
            ...forbidGroup(
              COORDINATOR_PATTERNS,
              'Domain modules must not depend on coordinators. Coordinators depend on modules, not the other way around.',
            ),
          ],
        },
      ],
    },
  })),

  // Coordinators: may import any module's published surface, but never
  // another module's internals.
  {
    files: ['packages/domain/src/coordinators/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTIN_NAMES,
          patterns: [
            ...DOMAIN_BASE_PATTERNS,
            ...forbidGroup(
              crossModuleSubpathPatterns(DOMAIN_MODULES),
              'Coordinators must import only the published index of each module, never their internals (entities/ports/commands/queries).',
            ),
          ],
        },
      ],
    },
  },

  // @salt/shared-types — must not import any other @salt/* package.
  {
    files: ['packages/shared-types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidGroup(SALT_APP_IMPORTS, 'Packages must not import from apps.'),
            ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
            ...forbidGroup(
              [
                '@salt/domain',
                '@salt/domain/*',
                '@salt/firebase-sync',
                '@salt/firebase-sync/*',
                '@salt/observability',
                '@salt/observability/*',
                '@salt/ui-components',
                '@salt/ui-components/*',
              ],
              '@salt/shared-types must not import any other @salt/* package.',
            ),
          ],
        },
      ],
    },
  },

  // @salt/firebase-sync — must not import IndexedDB packages or sibling adapters.
  {
    files: ['packages/adapters/firebase-sync/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FIREBASE_SYNC_PATTERNS }],
    },
  },

  // @salt/firebase-sync, minus the three helpers — the SDK entry points that
  // exist exactly once. See FIREBASE_SYNC_SDK_ENTRY_POINTS above for why.
  //
  // A SECOND block rather than a `paths` added to the one above, because
  // `no-restricted-imports` is replaced wholesale by the last config that sets
  // it: the helpers match only the first block and keep every restriction it
  // carries, while everything else matches this one and gets those restrictions
  // plus the entry-point paths. Hence `FIREBASE_SYNC_PATTERNS` is repeated here
  // — dropping it would silently un-restrict IndexedDB, PostHog and the sibling
  // adapter for the whole package.
  {
    files: ['packages/adapters/firebase-sync/**/*.ts'],
    ignores: FIREBASE_SYNC_HELPERS,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: FIREBASE_SYNC_PATTERNS, paths: FIREBASE_SYNC_SDK_ENTRY_POINTS },
      ],
    },
  },

  // @salt/observability — must not import Firebase SDKs, IndexedDB, or sibling adapters.
  {
    files: ['packages/adapters/observability/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidGroup(SALT_APP_IMPORTS, 'Adapters must not import from apps.'),
            ...forbidGroup(
              FIREBASE_PKGS,
              'Firebase SDK imports are only allowed in @salt/firebase-sync.',
            ),
            ...forbidGroup(INDEXEDDB_PKGS, 'Browser storage (IndexedDB) imports are forbidden.'),
            ...forbidGroup(
              ['@salt/firebase-sync', '@salt/firebase-sync/*'],
              'Adapters must not import each other. Compose them at the application layer.',
            ),
          ],
        },
      ],
    },
  },

  // @salt/ui-components — must not import Firebase SDKs or browser storage packages.
  {
    files: ['packages/ui-components/**/*.{ts,svelte}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidGroup(FIREBASE_PKGS, 'UI components must not import Firebase SDKs.'),
            ...forbidGroup(
              INDEXEDDB_PKGS,
              'UI components must not import browser storage (IndexedDB) packages.',
            ),
            ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
          ],
        },
      ],
    },
  },

  // Boundary-test fixtures: apply the same restrictions as their target layer.
  // (no-restricted-globals is inherited from the domain catch-all block above.)
  {
    files: ['packages/domain/src/__boundary_tests__/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTIN_NAMES,
          patterns: [
            ...forbidGroup(
              FIREBASE_PKGS,
              'Firebase SDK imports are only allowed in @salt/firebase-sync.',
            ),
            ...forbidGroup(INDEXEDDB_PKGS, 'Browser storage (IndexedDB) imports are forbidden.'),
            ...forbidGroup(NODE_BUILTIN_PKGS, DOMAIN_NODE_MESSAGE),
            ...forbidGroup(SALT_APP_IMPORTS, 'Packages must not import from apps.'),
          ],
        },
      ],
    },
  },

  {
    files: ['packages/shared-types/src/__boundary_tests__/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidGroup(SALT_APP_IMPORTS, 'Packages must not import from apps.'),
            ...forbidGroup(
              [
                '@salt/domain',
                '@salt/domain/*',
                '@salt/firebase-sync',
                '@salt/firebase-sync/*',
                '@salt/observability',
                '@salt/observability/*',
                '@salt/ui-components',
                '@salt/ui-components/*',
              ],
              '@salt/shared-types must not import any other @salt/* package.',
            ),
          ],
        },
      ],
    },
  },

  // The firebase-sync fixtures re-declare what they are proving, because this
  // block is the LAST config to set `no-restricted-imports` for these files and
  // therefore replaces the package blocks above wholesale. `paths` is here for
  // the same reason it is up there: `no-raw-listener.ts` proves the SDK
  // entry-point rule errors, and a fixture that config never reaches would
  // report nothing and fail as "expected a lint error but got none" — which is
  // exactly how this was caught.
  {
    files: ['packages/adapters/firebase-sync/src/__boundary_tests__/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FIREBASE_SYNC_SDK_ENTRY_POINTS,
          patterns: [
            ...forbidGroup(SALT_APP_IMPORTS, 'Packages must not import from apps.'),
            ...forbidGroup(INDEXEDDB_PKGS, 'Browser storage (IndexedDB) imports are forbidden.'),
            ...forbidGroup(
              ['@salt/observability', '@salt/observability/*'],
              'Adapters must not import each other.',
            ),
          ],
        },
      ],
    },
  },

  // Cloud Functions boundary-test fixtures: enforce CF-specific import restrictions.
  {
    files: ['apps/cloud-functions/src/__boundary_tests__/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // `paths` is exact-match; `patterns` uses minimatch with matchBase:true
          // which would over-match (e.g. forbidding the default subpath would
          // also forbid /server).
          paths: [
            {
              name: '@salt/observability',
              message:
                'Cloud Functions must not import the default @salt/observability subpath (browser posthog-js SDK). Use @salt/observability/server instead.',
            },
          ],
          patterns: [
            ...forbidGroup(STAGE_INTERNAL_SUBPATHS, STAGE_INTERNAL_MESSAGE),
            {
              group: ['@salt/domain', '@salt/domain/*'],
              importNames: STAGE_INTERNAL_NAMES,
              message: STAGE_INTERNAL_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // web-pwa boundary-test fixtures: enforce that internal subpaths of sibling
  // adapters are never imported directly — only the published package root.
  // Includes .svelte fixtures so the <script> import path is exercised (#413).
  {
    files: ['apps/web-pwa/src/__boundary_tests__/**/*.{ts,svelte}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@salt/observability/server',
              message:
                'web-pwa must not import @salt/observability/server (posthog-node + Node OTel). Use the default @salt/observability subpath.',
            },
          ],
          patterns: [
            ...forbidGroup(UI_PRIMITIVE_PKGS, UI_PRIMITIVE_MESSAGE),
            ...forbidGroup(
              ['@salt/firebase-sync/src', '@salt/firebase-sync/src/**'],
              'web-pwa must not import firebase-sync internals. Use the published package root (@salt/firebase-sync) only.',
            ),
            ...forbidGroup(STAGE_INTERNAL_SUBPATHS, STAGE_INTERNAL_MESSAGE),
            {
              group: ['@salt/domain', '@salt/domain/*'],
              importNames: STAGE_INTERNAL_NAMES,
              message: STAGE_INTERNAL_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Apps (production code): must not call canon stage internals directly.
  // findClosestMatch (stages 1–4) and matchOrCreate are the only allowed entry points.
  // Also enforces the observability subpath split: web-pwa uses the default
  // subpath, cloud-functions uses /server.
  {
    files: ['apps/web-pwa/src/**/*.{ts,svelte}'],
    ignores: ['**/__boundary_tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@salt/observability/server',
              message:
                'web-pwa must not import @salt/observability/server (posthog-node + Node OTel). Use the default @salt/observability subpath.',
            },
          ],
          patterns: [
            ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
            ...forbidGroup(UI_PRIMITIVE_PKGS, UI_PRIMITIVE_MESSAGE),
            ...forbidGroup(STAGE_INTERNAL_SUBPATHS, STAGE_INTERNAL_MESSAGE),
            {
              group: ['@salt/domain', '@salt/domain/*'],
              importNames: STAGE_INTERNAL_NAMES,
              message: STAGE_INTERNAL_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/cloud-functions/src/**/*.ts'],
    ignores: ['**/__boundary_tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@salt/observability',
              message:
                'Cloud Functions must not import the default @salt/observability subpath (browser posthog-js SDK). Use @salt/observability/server instead.',
            },
          ],
          patterns: [
            ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
            ...forbidGroup(STAGE_INTERNAL_SUBPATHS, STAGE_INTERNAL_MESSAGE),
            {
              group: ['@salt/domain', '@salt/domain/*'],
              importNames: STAGE_INTERNAL_NAMES,
              message: STAGE_INTERNAL_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // @salt/storybook — a dev-only UI-components Storybook.
  // Layer map: storybook → ui-components ONLY. It must reach UI primitives through
  // @salt/ui-components (Rule 7) and must not pull in any other @salt/* package,
  // Firebase, browser storage, or the PostHog SDK. Apps are leaf nodes, so this
  // is enforced via no-restricted-imports (not boundaries/element-types).
  {
    files: ['apps/storybook/src/**/*.{ts,svelte}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidGroup(SALT_APP_IMPORTS, 'Apps are leaf nodes — do not import another app.'),
            ...forbidGroup(UI_PRIMITIVE_PKGS, UI_PRIMITIVE_MESSAGE),
            ...forbidGroup(FIREBASE_PKGS, 'storybook must not import Firebase SDKs.'),
            ...forbidGroup(INDEXEDDB_PKGS, 'Browser storage (IndexedDB) imports are forbidden.'),
            ...forbidGroup(POSTHOG_PKGS, POSTHOG_MESSAGE),
            ...forbidGroup(
              [
                '@salt/shared-types',
                '@salt/shared-types/*',
                '@salt/domain',
                '@salt/domain/*',
                '@salt/firebase-sync',
                '@salt/firebase-sync/*',
                '@salt/observability',
                '@salt/observability/*',
              ],
              'storybook is a UI showcase — it may import @salt/ui-components only.',
            ),
          ],
        },
      ],
    },
  },

  // Preventive duplication check: a function whose body is identical to one
  // already written (issue #912).
  //
  // WARN, never error, and that is load-bearing rather than timid. `pnpm lint`
  // is bare `eslint "**/*.{ts,js,svelte}"` with no `--max-warnings`, so a
  // warning reaches the editor and the CI log without failing a build — which
  // is the only way to switch this on over an existing backlog without
  // red-lighting PRs that did not create it. IF A FUTURE CHANGE ADDS
  // `--max-warnings` TO THAT SCRIPT, THIS RULE MUST BE REVISITED FIRST: it
  // would start blocking every PR on duplication that predates it. Promotion to
  // `error` is a deliberate, separate decision for once the backlog is clear.
  //
  // `.svelte` files are in scope: svelte-eslint-parser exposes `<script>`
  // blocks to the same rules, so the cook pages are covered.
  //
  // Scoped to first-party source only. Tests are excluded because
  // arrange/assert repetition across cases is desirable — the same reason
  // `.jscpd.json` excludes them — and `scripts/` is outside the layer map.
  {
    files: [
      'packages/*/src/**/*.{ts,svelte}',
      'packages/adapters/*/src/**/*.ts',
      'apps/*/src/**/*.{ts,svelte}',
    ],
    ignores: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**', '**/__boundary_tests__/**'],
    plugins: { sonarjs },
    rules: {
      'sonarjs/no-identical-functions': 'warn',
    },
  },
];
