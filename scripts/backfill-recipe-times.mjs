#!/usr/bin/env node
// One-off: re-estimate how long every existing recipe actually takes (issue #952).
//
//   node scripts/backfill-recipe-times.mjs --project dev     --dry-run
//   node scripts/backfill-recipe-times.mjs --project dev     --apply
//   node scripts/backfill-recipe-times.mjs --project dev     --verify
//   node scripts/backfill-recipe-times.mjs --project staging --apply
//   node scripts/backfill-recipe-times.mjs --project prod    --apply --confirm production
//
// …and the SECOND pass (issue #1210), which selects differently:
//
//   node scripts/backfill-recipe-times.mjs --project dev  --missing-phases --dry-run
//   node scripts/backfill-recipe-times.mjs --project dev  --missing-phases --apply
//
// ─── RUNBOOK: docs/runbooks/recipe-times-backfill.md ──────────────────────────
//
// Read it before the first run of an environment. The short version, because the
// order is the part that goes wrong: the times BRANCH of `onRecipeWritten` must
// be DEPLOYED to the environment first. This script does not estimate anything —
// it asks — so running it against a project whose functions predate #952 phase 2
// bumps a nonce nothing is listening to, and reports a clean sweep having changed
// nothing at all. `--verify` is how you find that out; run it after every apply.
//
// ─── What is wrong, and what this fixes ───────────────────────────────────────
//
// Every recipe authored before #952 phase 1 carries a prep time produced by a
// prompt that never said what a prep time IS. With only "integers in minutes, or
// null" to go on, the model fell back on published-recipe convention — the
// already-weighed counter, no washing up — so Penne all'Arrabbiata claims 5
// minutes to fetch and chop garlic and chilli, open tomatoes, boil a pan and grate
// cheese. Some documents are also arithmetically impossible: Paneer Makhanwala
// stores prep 10, cook 35, total 35.
//
// Phase 1 fixed the authoring paths. Nothing re-asks the recipes already stored,
// which is what this is.
//
// Those three numbers are gone as a SCHEMA — #1233 stopped the trigger writing
// them and #1211 deleted them from `RecipeMetadataSchema`; a recipe states its
// timing as a phase strip now. Documents written before then still carry them,
// inert, until an ordinary save rewrites the document (LWW per whole document,
// CLAUDE.md → Data model conventions). This script neither reads nor writes
// them — #1248, and scripts/lib/recipeTimesVerdict.mjs says why.
//
// SAFE TO RE-RUN. A document that already carries `timesEstimatedAt` is skipped,
// so a second run reports "0 to ask" and writes nothing. An interrupted run
// resumes. `--redo` overrides the skip when a deliberate second pass is wanted
// (after a change to the definition in `recipeFieldRules.ts`, say).
//
// ─── The second pass: the phase strip (issue #1210) ───────────────────────────
//
// #1122 added `metadata.phases` — the strip the recipe page draws a timeline
// from — and the same trigger writes it. The library needs a second sweep for
// it, and `--missing-phases` is that sweep. It differs from the pass above in
// exactly one way, the selection:
//
//   DEFAULT           asks the cookable recipes with no `timesEstimatedAt` stamp
//   --missing-phases  asks the cookable recipes with NO PHASE STRIP, stamp or not
//
// The default pass is never "finished": it re-selects whatever is still
// unstamped each time it runs, including anything authored since the last
// run, so it has to be re-run alongside this one or `--verify`'s pending
// count never clears. Re-running it does not make this flag redundant,
// though — a stamped recipe may still have no strip. A STAMP IS NOT
// EVIDENCE OF A STRIP, and structurally so — `reconcileRecipePhases` leaves
// `phases: []` when a model's answer omits the strip, and the trigger
// stamps `timesEstimatedAt` in that same `update`. An empty strip under a
// fresh stamp is a real outcome.
//
// Selecting on the strip rather than the stamp also keeps the two properties the
// pass above has: it is safe to re-run, and safe to interrupt. And it never
// re-asks a recipe that already has a strip — which matters more than it used to,
// because #1202 shipped a hand editor for the strip before this pass ever runs,
// and a write from here would overwrite a cook's corrections. That is why this is
// a selection mode and not `--redo` over the whole library; `--redo` still means
// what it always meant, and the two flags refuse to run together.
//
// The rule for "has a strip" is `recipePhaseTotals().hasPhases`, restated in
// `scripts/lib/recipePhaseStrip.mjs` and tested there — absent and empty are both
// no strip, and a strip whose minutes sum to zero is a strip.
//
// ─── It bumps the nonce; it does NOT call the flow ────────────────────────────
//
// The same choice `scripts/backfill-recipe-kit.mjs` makes, for the same three
// reasons, and they are worth restating because this script writes to a field a
// user can see:
//
//   1. There would otherwise be two implementations of "how long does this take?"
//      — this one and the trigger's — and they would drift, which is the very
//      failure #952 is about. The trigger's flow interpolates the definition from
//      `recipeFieldRules.ts`, so the backfilled recipes and the newly authored
//      ones are measured against one text.
//   2. Genkit, the Gemini key and the model resolver all live in
//      `apps/cloud-functions` and are not resolvable from a repo-root script.
//      Reaching them means a new dependency or a copy of the flow.
//   3. Serialised and rate-limited here, one recipe at a time with a pause
//      between, so a library's worth of AI calls is a trickle rather than a spike.
//
// The cost is that per-recipe reporting is about the REQUEST, not the answer: this
// tells you the nonce landed. `--verify` is what tells you the answer came back —
// that the recipe is stamped and carries a phase strip.
//
// ─── Why a field-level PATCH and not a document `set` ─────────────────────────
//
// Recipes are last-write-wins per WHOLE document (CLAUDE.md → Data model
// conventions), and `onRecipeWritten` writes back to the same document partially
// (`image`, `imageBrief`, `kit`, and the times branch's `metadata.phases`,
// `metadata.timingSummary` and `timesEstimatedAt`). A full-document
// write from here would clobber whatever had landed concurrently — and a sweep of
// the entire library is the worst possible place to take that risk. So every write
// is a REST `PATCH` carrying `updateMask.fieldPaths=timesRequestedAt` and a
// one-field body: exactly one field changes, and nothing else on the document is
// even sent.
//
// It deliberately does NOT write `updatedAt` or `lastEditedBy`. Nothing about the
// recipe changed in a sense a human authored, and moving `updatedAt` would reorder
// lists and make the client's stale-echo guard treat every recipe as freshly
// edited.
//
// ACCEPTED RISK, stated because it is real (issue #952 → Open Questions): this
// overwrites a time a user hand-tuned in the editor. There is no field that
// distinguishes a hand-tuned number from a generated one, and the issue accepted
// that rather than inventing one.
//
// ─── Auth ─────────────────────────────────────────────────────────────────────
//
// Your local `gcloud` active account (`gcloud auth login`), the same credential
// scripts/backfill-recipe-kit.mjs, backfill-recipe-attribution.mjs and
// restore-firestore.mjs use. Firestore REST rather than the Admin SDK because
// `firebase-admin` belongs to apps/cloud-functions and is not resolvable from the
// repo root.

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { recipeAskedLine } from './lib/recipeAskedLine.mjs';
import { decodeRecipePhases, hasPhaseStrip } from './lib/recipePhaseStrip.mjs';
import { selectRecipesToAsk } from './lib/recipeSelection.mjs';
import { isTimesEstimated } from './lib/recipeTimesEstimated.mjs';
import { recipeTimesVerdict } from './lib/recipeTimesVerdict.mjs';

// Mirrors scripts/backfill-recipe-kit.mjs, including the env-var names, so the
// three environments are named the same way wherever they are named.
const ENVIRONMENTS = {
  prod: {
    label: 'PRODUCTION',
    project: process.env.SALT_PROD_PROJECT ?? 's2-prod-e46bd',
    expects: /prod/i,
  },
  staging: {
    label: 'staging',
    project: process.env.SALT_STAGING_PROJECT ?? 's2-stage-ccb22',
    expects: /stag/i,
  },
  dev: {
    label: 'dev-cloud',
    project: process.env.SALT_DEV_PROJECT ?? 's2-dev-eggman',
    expects: /dev/i,
  },
};

// Only `recipe` and `cocktail` are cookable (packages/domain → capabilities.ts).
// A special is a restaurant and a placeholder is a photograph and a title, so
// neither has a prep time to re-estimate and the trigger's branch skips them —
// asking here would be a write that produces nothing. Kept as a literal list
// rather than an import because a repo-root script cannot resolve `@salt/domain`;
// the trigger is the enforcer either way (it asks `isCookable`), so the worst a
// drift here can do is skip a kind that would have been skipped anyway. This is
// the same bargain, and the same comment, as backfill-recipe-kit.mjs.
const COOKABLE_KINDS = new Set(['recipe', 'cocktail']);

// One request every 1.5s, as the kit backfill uses. Slow enough that a library-
// sized run is a trickle rather than a spike of concurrent AI calls, fast enough
// that ~60 recipes takes a minute and a half.
const PAUSE_MS = 1500;

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // Dry run is the DEFAULT: `--apply` is the only thing that writes. Every write
  // here costs an AI call, so an accidental bare run must cost nothing at all.
  const args = { apply: false, verify: false, redo: false, missingPhases: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--redo') args.redo = true;
    // The second pass (#1210): select on the phase strip, not on the stamp.
    else if (arg === '--missing-phases') args.missingPhases = true;
    else if (arg === '--project') args.project = argv[(i += 1)];
    // Non-interactive confirmation for `--project prod`; see the gate below for
    // why there is no readline prompt anywhere in this file.
    else if (arg === '--confirm') args.confirm = argv[(i += 1)];
    else die(`Unknown argument: ${arg}`);
  }
  return args;
}

function die(message) {
  console.error(`✖ ${message}`);
  console.error(
    '\nUsage: node scripts/backfill-recipe-times.mjs --project <dev|staging|prod> [--apply] [--verify] [--redo] [--missing-phases]',
  );
  console.error('       (dry run by default — nothing is written without --apply)');
  console.error(
    '       --verify re-reads the timesEstimatedAt stamp and the phase strip, and reports what is outstanding',
  );
  console.error('       --redo also asks recipes that already carry timesEstimatedAt');
  console.error(
    '       --missing-phases asks the cookable recipes with no phase strip instead, stamp or not',
  );
  console.error('       (--redo and --missing-phases are mutually exclusive)');
  console.error('       writing to prod additionally needs --confirm production');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// No default project, deliberately: the environment you are writing to is never
// something this script should assume.
if (!args.project) die('--project is required (dev | staging | prod). There is no default.');
// Contradictory selections, so refused rather than silently ranked. `--redo`
// asks EVERY cookable recipe including the ones whose strip a cook corrected by
// hand; `--missing-phases` exists precisely to leave those alone.
if (args.redo && args.missingPhases) {
  die('--redo and --missing-phases select different recipes. Pass one or the other.');
}
const env = ENVIRONMENTS[args.project];
if (!env) die(`Unknown project "${args.project}". Expected one of: dev, staging, prod.`);
// Backstop against a mistyped SALT_*_PROJECT pointing the write somewhere
// unexpected — the same guard restore-firestore.mjs applies.
if (!env.expects.test(env.project)) {
  die(`Project id "${env.project}" does not look like ${args.project}. Refusing to write to it.`);
}

// ─── Firestore REST ───────────────────────────────────────────────────────────

const BASE = `https://firestore.googleapis.com/v1/projects/${env.project}/databases/(default)/documents`;

let token;
try {
  token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
} catch {
  die('Could not get a gcloud access token. Run `gcloud auth login` first.');
}

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const path = url.split('/documents')[1];
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Firestore's REST encoding puts an integer in `integerValue` AS A STRING, a
// non-integer in `doubleValue` as a number, and an explicit null in `nullValue`.
// An ABSENT field and a null one both have to read as null here: a recipe never
// asked by this script carries no `timesRequestedAt` at all, and for every
// purpose this script has ("is it stated?") that is the same answer.
//
// Since #1248 its only callers are the two millisecond stamps below.
function readNumber(field) {
  if (!field) return null;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  return null;
}

// The strip lives in the `metadata` map, which the mask at `listRecipes` already
// fetches — no extra read and no mask change. The decode and the "is this a
// strip?" rule are in scripts/lib/recipePhaseStrip.mjs so they can be tested;
// the header there says why they are a hand-copy.
//
// The retired prep/cook/total minutes used to be decoded out of that same map
// and printed beside every recipe. Nothing has written them since #1233 and
// #1211, so #1248 stopped reading them: scripts/lib/recipeTimesVerdict.mjs holds
// the reasoning, and its test pins that no reference to them comes back here.
function phasesOf(doc) {
  return decodeRecipePhases(doc.fields?.metadata?.mapValue?.fields?.phases);
}

console.log(`Project : ${env.project} (${env.label})`);
console.log(
  `Mode    : ${args.verify ? 'VERIFY — reading only' : args.apply ? 'APPLY — one AI call per recipe' : 'DRY RUN — nothing will be written'}`,
);
if (!args.verify) {
  console.log(
    `Select  : ${args.missingPhases ? 'recipes with NO PHASE STRIP (stamp ignored)' : args.redo ? 'every cookable recipe (--redo)' : 'recipes with no timesEstimatedAt stamp'}`,
  );
}
console.log('');

// ─── Scan ─────────────────────────────────────────────────────────────────────

// Masked to five fields so a scan of the whole collection stays cheap — the
// recipes themselves (ingredients, steps, prose) are never fetched. The trigger
// reads those; this script only ever needs to know which documents to ask about
// and what they say today.
async function listRecipes() {
  const docs = [];
  let pageToken = '';
  do {
    const url =
      `${BASE}/recipes?pageSize=300` +
      '&mask.fieldPaths=timesEstimatedAt&mask.fieldPaths=timesRequestedAt' +
      '&mask.fieldPaths=title&mask.fieldPaths=kind&mask.fieldPaths=metadata' +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const page = await api(url);
    for (const doc of page.documents ?? []) {
      docs.push({
        id: doc.name.split('/').pop(),
        title: doc.fields?.title?.stringValue ?? '(untitled)',
        // Absent `kind` means `recipe` — the schema defaults it, and the oldest
        // production recipes predate the field entirely.
        kind: doc.fields?.kind?.stringValue ?? 'recipe',
        // `timesEstimatedAt >= timesRequestedAt`, not merely "stamped at all"
        // (issue #952 phase 2 review, should-fix 1): on a `--redo` pass, a
        // recipe whose second estimate FAILS keeps its first run's older
        // stamp, which must read as still-pending, never as done.
        estimated: isTimesEstimated(
          readNumber(doc.fields?.timesRequestedAt),
          readNumber(doc.fields?.timesEstimatedAt),
        ),
        // #1210: the second pass selects on this, and `--verify` counts it.
        hasStrip: hasPhaseStrip(phasesOf(doc)),
      });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return docs;
}

const recipes = await listRecipes();
const cookable = recipes.filter((r) => COOKABLE_KINDS.has(r.kind));

// ─── Verify ───────────────────────────────────────────────────────────────────
//
// The closing check for both passes, and the reason it is in this file rather
// than in a human's head: "after the production run, every cookable recipe is
// stamped and carries a phase strip, verified by a re-query of the collection".
// Run it after every apply — including on an environment you believe already
// done, since it is also how you notice the functions were never deployed.
//
// It reports ONLY what a documented run can change, which is the fix in #1248:
// until then it also required `total >= prep + cook` over three fields nothing
// writes any more, so a legacy document could hold the exit code at 1 forever.
// scripts/lib/recipeTimesVerdict.mjs states the verdict and its boundary.

if (args.verify) {
  const { pending, noStrip, ok } = recipeTimesVerdict(cookable);
  for (const r of cookable) {
    console.log(
      `  ${r.estimated ? 'done   ' : 'PENDING'}  ${r.hasStrip ? 'strip   ' : 'NO STRIP'}  ${r.title}`,
    );
  }
  console.log(`\nCookable recipes    : ${cookable.length}`);
  console.log(`Re-estimated        : ${cookable.length - pending.length}`);
  console.log(`Still pending       : ${pending.length}${pending.length === 0 ? ' ✔' : ' ✖'}`);
  console.log(`With a phase strip  : ${cookable.length - noStrip.length}`);
  console.log(`No phase strip      : ${noStrip.length}${noStrip.length === 0 ? ' ✔' : ' ✖'}`);
  if (pending.length > 0) {
    console.error('\n✖ These have no answered estimate (the default pass asks exactly these):');
    for (const r of pending) console.error(`    ${r.id}  ${r.title}`);
  }
  if (noStrip.length > 0) {
    console.error('\n✖ These have no phase strip (--missing-phases asks exactly these):');
    for (const r of noStrip) console.error(`    ${r.id}  ${r.title}`);
  }
  // Non-zero on ANY failing condition, so a CI-style "did it work" reads off the
  // exit code rather than off the prose above it. Note what 0 does and does not
  // claim: every cookable recipe in THIS project is stamped and carries a strip.
  // It says nothing about the other two environments, and nothing about whether
  // a strip is any good — only that one is stored.
  process.exit(ok ? 0 : 1);
}

const notCookable = recipes.filter((r) => !COOKABLE_KINDS.has(r.kind));

// Three selections, sharing everything downstream of here. `--missing-phases`
// sits BESIDE the stamp-keyed skip rather than replacing it: the default pass is
// still the #952 one and still means what it meant, and the header says why the
// second pass cannot be keyed on the stamp. The decision itself is pinned in
// scripts/lib/recipeSelection.mjs (issue #1210 review, blocking 2) — an inverted
// arrow here would silently ask the recipes that already have a strip instead of
// the ones that don't.
const { alreadyDone, toAsk } = selectRecipesToAsk(cookable, {
  missingPhases: args.missingPhases,
  redo: args.redo,
});

console.log(`Recipes found     : ${recipes.length}`);
console.log(`Not cookable      : ${notCookable.length} (skipped — a special has no prep time)`);
console.log(
  args.missingPhases
    ? `Already has strip : ${alreadyDone.length} (skipped — never re-asked, so a hand-edited strip stands)`
    : `Already estimated : ${alreadyDone.length} (skipped${args.redo ? '' : ' — pass --redo to ask again'})`,
);
console.log(`To ask            : ${toAsk.length}\n`);

if (toAsk.length === 0) {
  console.log('✔ Nothing to do.');
  process.exit(0);
}

if (!args.apply) {
  for (const r of toAsk) console.log(`  would ask  ${r.id}  ${r.title}`);
  console.log(`\n✔ Dry run: ${toAsk.length} recipe(s) would be re-estimated.`);
  console.log('  Nothing was written. Re-run with --apply to do it.');
  process.exit(0);
}

// ─── Confirm (production only) ────────────────────────────────────────────────
//
// A FLAG, never a readline prompt, and that is a scar rather than a preference
// (issue #952 → Phase 2 context pointers). Run under `!` from a shell or through
// an agent's Bash tool there is no TTY, so a readline question never settles: the
// process prints the entire write plan and then hangs on a top-level await,
// looking exactly like a crash mid-write when in fact nothing has been written at
// all. `scripts/fix-recipe-range-timers.mjs` takes the flag for the same reason;
// backfill-recipe-attribution.mjs's prompt is the thing not to copy.

if (args.project === 'prod') {
  if (args.confirm === undefined) {
    console.error(`✖ Writing to PRODUCTION needs confirmation. Nothing written.`);
    console.error('  Re-run with the confirmation as a flag:');
    console.error(
      `    node scripts/backfill-recipe-times.mjs --project prod --apply --confirm production`,
    );
    process.exit(1);
  }
  if (args.confirm !== 'production') {
    console.error(`✖ --confirm must be exactly "production" (got "${args.confirm}").`);
    process.exit(1);
  }
  console.log(`Confirmed via --confirm: asking ${toAsk.length} recipe(s) in ${env.project}.\n`);
}

// ─── Write ────────────────────────────────────────────────────────────────────

let asked = 0;
const failures = [];
for (const r of toAsk) {
  const url = `${BASE}/recipes/${encodeURIComponent(r.id)}?updateMask.fieldPaths=timesRequestedAt`;
  try {
    await api(url, {
      method: 'PATCH',
      // The nonce the trigger's `timesNeedEstimate` guard reads. Firestore's REST
      // encoding wants integers as strings; the field is a plain number on read.
      body: JSON.stringify({ fields: { timesRequestedAt: { integerValue: String(Date.now()) } } }),
    });
    asked += 1;
    console.log(recipeAskedLine(r));
  } catch (err) {
    // Keep going: one unwritable document must not strand the rest, and the run is
    // re-runnable, so anything that fails here is simply picked up next time.
    failures.push({ id: r.id, message: err.message });
    console.error(`  FAILED  ${r.id}  ${r.title} — ${err.message}`);
  }
  await sleep(PAUSE_MS);
}

console.log(
  `\n✔ ${env.project}: asked ${asked}, skipped ${alreadyDone.length + notCookable.length}, failed ${failures.length}.`,
);
console.log('  The new times land as the trigger answers — allow a minute or two, then:');
console.log(`    node scripts/backfill-recipe-times.mjs --project ${args.project} --verify`);
process.exitCode = failures.length > 0 ? 1 : 0;
