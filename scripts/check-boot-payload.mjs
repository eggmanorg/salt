#!/usr/bin/env node
// Boot-payload guard (issue #813).
//
// Everything the PWA must download before it can paint anything: the entry
// script in `dist/index.html` plus every file it `modulepreload`s. #813 took that
// from 599 kB gzipped to 479 kB by removing two libraries that had no business
// being there — the whole Lucide icon library (1,764 icons to draw ~70) and the
// browser OpenTelemetry SDK (~58 kB for a tracer idle until the first tap) — and
// by making Leaflet load only when the location picker is actually rendered.
//
// Nothing else in CI would notice any of that coming back. Each regression is a
// one-line change with NO visible symptom: swap a subpath import for the
// `@lucide/svelte` barrel, re-export one OTel-typed value from the observability
// barrel as a value rather than a type, or move Leaflet's `import` back to module
// scope. The app looks and behaves identically; it is just slower to open, on
// every first load and after every PWA update.
//
// Run against a built `apps/web-pwa/dist` (CI builds first — that build step is
// itself worth having: a Vite build break currently cannot surface until deploy).
//
//   node scripts/check-boot-payload.mjs
//
// Three rules, because a single size ceiling cannot do both jobs. Loose enough
// not to trip on ordinary growth is loose enough to swallow the ~15 kB gz OTel
// chunk; tight enough to catch that is tight enough to fail on a normal feature.
// So: the ceiling catches gross regressions, and two content markers catch the
// specific libraries by name, at any size.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO_ROOT, 'apps/web-pwa/dist');
const ASSETS = join(DIST, 'assets');

// Gzipped ceiling for the whole boot graph. Measured at 479.47 kB on the #813
// production build, so this leaves ~20 kB of headroom for ordinary growth.
// Raising it is a deliberate act: say in the PR what got bigger and why.
//
// Raised 500 -> 501 in #1076 (issue #940), authorised by Daniel ("bump the
// ceiling and merge 940") rather than assumed. Pre-#940 headroom against the
// old 500 KB ceiling was already down to 706 B (baseline fda5e56a measured
// 499.31 kB gz); #940's write-coalescing work added +785 B of boot-graph
// code — mealPlanService +397 B (the coalescer itself), dateFormat +274 B (a
// new shared module replacing ten inline Intl.DateTimeFormat builders, also
// reused by five lazy call sites), MealDayEditor +93 B (id-indexed recipe
// lookup), recipeService +21 B (recipesById derived store) — pushing the
// measured total to 500.11 kB, over the old ceiling by ~113 B. None of it is
// accidental eager import, dead code, or test-only leakage; every byte is
// #940 feature code reached through MealPlanWeekPage/MealDayEditor, both
// already in the eager boot graph before this PR. 501 KB clears the observed
// 500.09-500.11 kB CI jitter with a deliberately small (~0.9 KB) margin —
// not rounded up for comfort, so the gate stays tight.
//
// Raised 501 -> 505 in #1297, authorised by Daniel. Nothing of ours grew: the
// dependabot production-minor-patch group took posthog-js 1.422.5 -> 1.427.2
// (+3949 B gz in /assets/posthog.js) and @lucide/svelte 1.35.0 -> 1.41.0
// (+758 B gz across the shopping-cart icon, Icon.js and chevron-down), for a
// measured 496.77 -> 501.43 kB. Per-chunk attribution confirmed no new eager
// import of ours and no chunk moving into the boot graph. The #1076 margin was
// too thin to survive a routine SDK bump — 505 KB restores ~3.6 KB so the next
// one does not fail this gate on third-party bytes alone. If this recurs, the
// fix is not another raise: posthog.js is ~90 kB gz, the second-largest thing
// in the boot graph, and analytics has no business loading before first paint.
//
// Raised 505 -> 510 in #1512 (2026-09-21), authorised by Daniel ("raise the
// boot-payload ceiling by a small amount, then do the chat-save-gate
// consolidation", 2026-09-20). Nothing of ours grew here either: measured fresh
// against a build of 8e7dc971, the boot graph is 503.66 kB gz — 1.34 kB of
// headroom under the old 505 KB ceiling. That margin is the problem. It is
// already thicker than the #1076 raise left (~0.9 kB) yet still far thinner
// than the +4.66 kB a single routine dependency bump consumed at #1297 — the
// #1297 comparison is what carries the argument — and in campaign #1486 it
// failed twice on edges unrelated to their own weight: adding one
// `featureGate.js` import to the eager `chatService.ts` re-chunked Rollup's
// output enough to tip the total to 505.06 kB — 60 B over — which is why that
// consolidation was reverted in 071d2807 rather than shipped. 510 KB gives
// ~6.3 kB over today's baseline: enough for that consolidation (measured at
// +0.16 kB against the current dependency graph, where the September attempt saw
// +1.35 kB — chunking, not code, is what varies) plus one more #1297-sized
// third-party shock. It is sized to that stated need, not rounded up, and it is
// not a licence for eager-bundle growth: the OTel/Leaflet/CF-schema content
// markers below still catch the named libraries at any ceiling. The standing
// advice from #1297 is unchanged — the next raise should be refused in favour of
// getting posthog.js (~90 kB gz) out of the boot graph.
const BOOT_GZIP_CEILING_KB = 510;

// Raw (un-gzipped) ceiling for the settings page's own chunk. Leaflet is 145 kB
// and Phase 2 moved it out; the chunk measured 34.4 kB after, against 183.7 kB
// before. This is what notices Leaflet drifting back to module scope in
// LocationMapField.svelte — that regression never touches the boot graph, so the
// rules above cannot see it.
const APP_SETTINGS_RAW_CEILING_KB = 60;

// Literal strings that survive minification, so the check does not depend on
// chunk names or sourcemaps:
//   - `@opentelemetry/api` keys its global registry off
//     `Symbol.for('opentelemetry.js.api.' + VERSION)`.
//   - Leaflet writes the `leaflet-container` class onto every map root.
const OTEL_MARKER = 'opentelemetry.js.api';
const LEAFLET_MARKER = 'leaflet-container';

// `@salt/domain`'s `package.json` declares `"sideEffects": false` — CLAUDE.md
// Hard Rule 1 ("Domain is pure… No side effects") written where Rollup can act
// on it. That declaration is what lets Rollup drop a `z.object(...)` schema
// export it cannot otherwise prove is side-effect-free, so only the ~34 schemas
// `web-pwa` actually names survive into the boot graph instead of all ~70 in
// the barrel. The claim behind it — CLAUDE.md Rule 12 — has no test that can
// see it: `sideEffects` is bundler-only metadata, invisible to vitest and to
// `tsc`. This is that claim's mechanical pin. `FindKitchenNotesInputSchema`
// (`packages/domain/src/schemas/findKitchenNotes.ts`) is named only by the
// chef-tool flow in `apps/cloud-functions/src/flows/chefChat.ts` — never by
// any `apps/web-pwa` module — so its prose has no legitimate way into a
// browser bundle. If it turns up here, either the `sideEffects` declaration
// was removed/weakened (a real module-level side effect forcing that is a
// correctness fix, not a reason to drop the guard silently) or something in
// `web-pwa` started reaching a cloud-functions-only schema; either way the
// whole ~70-schema barrel is likely being retained again, the way it was
// before this guard existed.
// KEYED ON A SCHEMA FIELD NAME, NOT A `.describe()` SENTENCE. findKitchenNotes.ts's
// own header tells readers to edit every `.describe()` string "as prompt work, not
// as comments" — so a marker built from that prose would silently stop guarding the
// next time someone did exactly that, with nothing here to notice. `totalNotes` is
// a Zod object-literal property key (`FindKitchenNotesOutputSchema.totalNotes`),
// not prompt text: a minifier does not rename object property keys (Zod reads
// `.shape` off them by name at runtime, so doing so would break the schema), and
// renaming the field itself is a structural change that already breaks the
// handler, the exported type and every test touching it — far too loud to happen
// as an incidental prompt edit. Confirmed nowhere else in the repo (`grep -rn
// totalNotes`) so a hit here cannot be some unrelated feature's field of the same
// name.
const CF_ONLY_SCHEMA_MARKER = 'totalNotes';

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exitCode = 1;
}

if (!existsSync(DIST)) {
  console.error(`✖ No build found at ${DIST}.\n  Run \`pnpm --filter @salt/web-pwa build\` first.`);
  process.exit(1);
}

// ── The boot graph ────────────────────────────────────────────────────────────
// index.html's entry <script type="module"> plus every <link rel="modulepreload">
// it declares. That is precisely the set the browser fetches before first paint;
// route chunks and other dynamic imports are deliberately NOT in it.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const hrefs = new Set();
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) hrefs.add(m[1]);
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) hrefs.add(m[1]);

const boot = [];
for (const href of hrefs) {
  const file = join(DIST, href.replace(/^\//, ''));
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file);
  boot.push({ href, bytes, gzip: gzipSync(bytes).length });
}

if (boot.length === 0) {
  console.error('✖ Parsed no boot-graph files out of dist/index.html — has the build changed?');
  process.exit(1);
}

const totalGzip = boot.reduce((sum, f) => sum + f.gzip, 0);
const kb = (n) => (n / 1024).toFixed(2);

console.log(`Boot graph: ${boot.length} files, ${kb(totalGzip)} kB gzipped`);
for (const f of [...boot].sort((a, b) => b.gzip - a.gzip).slice(0, 5)) {
  console.log(`  ${kb(f.gzip)} kB gz  ${f.href}`);
}

// ── Rule 1: total size ────────────────────────────────────────────────────────
if (totalGzip > BOOT_GZIP_CEILING_KB * 1024) {
  fail(
    `Boot payload is ${kb(totalGzip)} kB gzipped, over the ${BOOT_GZIP_CEILING_KB} kB ceiling.\n` +
      `  Every first open and every PWA update pays this. Find what grew (the list above is\n` +
      `  sorted by size), or raise BOOT_GZIP_CEILING_KB in this script and justify it in the PR.`,
  );
}

// ── Rule 2: neither SDK back in the boot graph ────────────────────────────────
for (const { href, bytes } of boot) {
  const text = bytes.toString('utf8');
  if (text.includes(OTEL_MARKER)) {
    fail(
      `The OpenTelemetry SDK is back in the boot graph (${href}).\n` +
        `  It must be reached only by the dynamic import in browserTracer.ts. The usual cause is\n` +
        `  observability's barrel re-exporting a VALUE from browserTracerImpl.js instead of a type.`,
    );
  }
  if (text.includes(LEAFLET_MARKER)) {
    fail(
      `Leaflet is in the boot graph (${href}).\n` +
        `  It belongs in an on-demand chunk, loaded by LocationMapField.svelte's onMount.`,
    );
  }
  if (text.includes(CF_ONLY_SCHEMA_MARKER)) {
    fail(
      `A cloud-functions-only @salt/domain schema is in the boot graph (${href}).\n` +
        `  The findKitchenNotes schemas are named only by apps/cloud-functions' chefChat flow, so\n` +
        `  this means packages/domain/package.json lost its "sideEffects": false (or stopped\n` +
        `  being true of the code) and Rollup is retaining the whole ~70-schema barrel again.`,
    );
  }
}

// ── Rule 3: Leaflet stays out of the settings-page chunk ──────────────────────
const appSettingsChunks = readdirSync(ASSETS).filter(
  (f) => f.startsWith('AppSettingsPage-') && f.endsWith('.js'),
);

if (appSettingsChunks.length === 0) {
  fail(
    `No AppSettingsPage-*.js chunk found in dist/assets.\n` +
      `  This check exists to keep Leaflet out of it; if the page was renamed or its chunking\n` +
      `  changed, point this rule at the new chunk rather than deleting it.`,
  );
} else {
  for (const name of appSettingsChunks) {
    const bytes = readFileSync(join(ASSETS, name));
    const text = bytes.toString('utf8');
    console.log(`Settings chunk: ${name} — ${kb(bytes.length)} kB raw`);
    if (text.includes(LEAFLET_MARKER)) {
      fail(
        `Leaflet is bundled into ${name}.\n` +
          `  LocationMapField.svelte must import it inside onMount (\`await import('leaflet')\`),\n` +
          `  never at module scope — otherwise the settings page carries 145 kB it may never use.`,
      );
    }
    if (bytes.length > APP_SETTINGS_RAW_CEILING_KB * 1024) {
      fail(
        `${name} is ${kb(bytes.length)} kB, over the ${APP_SETTINGS_RAW_CEILING_KB} kB ceiling.\n` +
          `  Something heavy moved into the settings page's own chunk.`,
      );
    }
  }
}

if (process.exitCode) {
  console.error('Boot-payload check FAILED.');
} else {
  console.log('\n✔ Boot-payload check passed.');
}
