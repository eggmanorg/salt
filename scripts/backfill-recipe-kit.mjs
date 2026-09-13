#!/usr/bin/env node
// One-off: ask what kit every existing recipe needs (issues #882, #954).
//
//   node scripts/backfill-recipe-kit.mjs --project dev     --dry-run
//   node scripts/backfill-recipe-kit.mjs --project dev     --apply
//   node scripts/backfill-recipe-kit.mjs --project dev     --verify
//   node scripts/backfill-recipe-kit.mjs --project staging --apply --redo
//   node scripts/backfill-recipe-kit.mjs --project prod    --apply --redo --confirm production
//
// ─── RUNBOOK: docs/runbooks/recipe-kit-backfill.md ────────────────────────────
//
// Read it before the first run of an environment. The short version, because the
// order is the part that goes wrong: the kit branch of `onRecipeWritten` must be
// DEPLOYED to the environment first. This script does not infer anything — it
// asks — so running it against a project whose functions predate the change you
// are remediating bumps a nonce that the OLD code answers, spending one AI call
// per recipe to reproduce the very defect. `--verify` is how you find that out.
//
// Kit inference shipped as a branch of `onRecipeWritten`, which only fires on a
// WRITE — so every recipe already in the library has no `kit` and would keep none
// until somebody happened to edit it. This is the pass that gives them one, so the
// "You'll need" strip is there from day one rather than appearing a recipe at a
// time over the next year.
//
// SAFE TO RE-RUN. A document that already carries `kitInferredAt` is skipped, so a
// second run reports "0 to ask" and writes nothing.
//
// ─── --redo, and why the skip could not simply be lifted (issue #954) ─────────
//
// #954 changed what a good answer IS: the flow now names the appliance the
// household actually owns instead of generalising it away. Every recipe inferred
// before that carries a generalised label and needs asking AGAIN — which the skip
// above exists to prevent, so `--redo` is the flag that overrides it.
//
// It is not merely a filter change. `kitNeedsInference` declines on its first
// line whenever `kitInferredAt` is present, so re-asking requires the stamp to be
// DELETED, exactly as the `redoRecipeKit` callable does it. That write is built in
// scripts/lib/recipeKitRequest.mjs, whose header carries the reasoning; the
// original #954 remediation attempt reported a clean sweep having re-inferred
// nothing, because bumping the nonce alone is a trigger invocation that declines.
//
// ─── It bumps the nonce; it does NOT call the flow ────────────────────────────
//
// Two shapes were available: call `identifyRecipeKit` from here and PATCH the
// answer in, or stamp `kitRequestedAt` and let the trigger that already exists do
// the work. This does the second, for three reasons:
//
//   1. There would then be two implementations of "infer a recipe's kit" — this
//      one and the trigger's — and they would drift, exactly as the librarian and
//      extraction prompts did. The trigger is the only path in production; a
//      backfill that takes a different one is not testing what ships.
//   2. Genkit, the Gemini key and the model resolver all live in
//      `apps/cloud-functions`. Reaching them from a repo-root script means either
//      a new dependency or a copy of the flow — and issue #882 adds neither
//      (`backfill-recipe-attribution.mjs` takes the same stance about
//      `firebase-admin`).
//   3. Serialised + rate-limited here, one recipe at a time with a pause between,
//      so it is not a stampede: the trigger is per-document and Cloud Run scales
//      out, but a library's worth of AI calls arriving in one second is a spike
//      nobody asked for.
//
// The cost of that choice is that per-recipe reporting is about the REQUEST, not
// the answer: this script tells you the nonce landed, and the trigger's own logs
// (and, on failure, the PostHog report it files) tell you what the model said. It
// is the same bargain the "Redo kit" button in the app makes.
//
// ─── Why a field-level PATCH and not a document `set` ─────────────────────────
//
// Recipes are last-write-wins per WHOLE document (CLAUDE.md → Data model
// conventions), and `onRecipeWritten` writes back to the same document partially
// (`image`, `imageBrief`, and now `kit`). A full-document write from here would
// clobber whatever the trigger had written concurrently. So every write is a REST
// `PATCH` carrying an `updateMask` naming only the kit request fields: at most two
// fields change and nothing else on the document is even sent. The exact mask and
// body come from `planKitRequest` (scripts/lib/recipeKitRequest.mjs).
//
// It deliberately does NOT write `updatedAt` — nothing about the recipe changed in
// any sense a human cares about, and moving `updatedAt` would reorder lists and
// make the client's stale-echo guard treat every recipe as freshly edited.
//
// The write fires `onRecipeWritten` once per recipe, which is the entire point.
// The image branch is unaffected: `imageNeedsGeneration` returns false when an
// image is already set, and also when it was null before and stays null with no
// `imageRequestedAt` bump — which is every document this script touches.
//
// ─── Auth ─────────────────────────────────────────────────────────────────────
//
// Your local `gcloud` active account (`gcloud auth login`), the same credential
// scripts/backfill-recipe-attribution.mjs, export-prod-firestore.mjs and
// restore-firestore.mjs use. Firestore REST rather than the Admin SDK because
// `firebase-admin` belongs to apps/cloud-functions and is not resolvable from the
// repo root.

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { planKitRequest } from './lib/recipeKitRequest.mjs';

// Mirrors scripts/backfill-recipe-attribution.mjs, including the env-var names, so
// the three environments are named the same way wherever they are named.
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
// A special has no method and a placeholder is a photograph and a title, so the
// trigger's kit branch skips them — asking here would be a write that produces
// nothing. Kept as a literal list rather than an import because a repo-root script
// cannot resolve `@salt/domain`; the trigger is the enforcer either way, so the
// worst a drift here can do is skip a kind that would have been skipped anyway.
const COOKABLE_KINDS = new Set(['recipe', 'cocktail']);

// One request every 1.5s. Slow enough that a library-sized run is a trickle rather
// than a spike of concurrent AI calls, fast enough that ~50 recipes takes a minute.
const PAUSE_MS = 1500;

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // Dry run is the DEFAULT: `--apply` is the only thing that writes. The
  // attribution backfill defaults the other way, and this one is deliberately the
  // safer shape — every write here costs an AI call, so an accidental bare run
  // must cost nothing at all.
  const args = { apply: false, verify: false, redo: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--redo') args.redo = true;
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
    '\nUsage: node scripts/backfill-recipe-kit.mjs --project <dev|staging|prod> [--apply] [--verify] [--redo]',
  );
  console.error('       (dry run by default — nothing is written without --apply)');
  console.error(
    '       --verify re-reads the stamp and the stored kit, and reports what is pending',
  );
  console.error('       --redo also asks recipes that already carry kitInferredAt, clearing it');
  console.error('       writing to prod additionally needs --confirm production');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// No default project, deliberately: the environment you are writing to is never
// something this script should assume.
if (!args.project) die('--project is required (dev | staging | prod). There is no default.');
const env = ENVIRONMENTS[args.project];
if (!env) die(`Unknown project "${args.project}". Expected one of: dev, staging, prod.`);
// Contradictory modes (PR #1067 review, blocking finding 1): `--verify` is
// read-only and `--apply` writes. Letting both through fell to the Mode banner's
// ternary, which never looked at `args.verify` — so `--apply --redo --confirm
// production --verify` printed "Mode : APPLY", then the verify block below
// process.exit()s before the confirm gate and the write loop ever run. Nothing
// gets written. Worse, in the pre-remediation state every cookable recipe still
// carries the stamp its PRE-#954 inference left, so the listing reads "done"
// across the board and exits 0 — an operator sees an APPLY banner, a clean sweep
// and a green exit, and walks away from a library that was never touched. Refuse
// the combination outright instead of silently resolving it.
if (args.verify && args.apply) die('--verify cannot be combined with --apply — pick one.');
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

console.log(`Project : ${env.project} (${env.label})`);
console.log(
  `Mode    : ${args.verify ? 'VERIFY — reading only' : args.apply ? 'APPLY — one AI call per recipe' : 'DRY RUN — nothing will be written'}\n`,
);

// ─── Scan ─────────────────────────────────────────────────────────────────────

// The stored kit labels, for `--verify` to print. `kit` is an array of maps and
// only `label` is wanted — `stepIds` is the method's business, not this script's.
// Reading it costs nothing extra: it rides along on the same masked scan.
function labelsOf(doc) {
  return (doc.fields?.kit?.arrayValue?.values ?? [])
    .map((v) => v.mapValue?.fields?.label?.stringValue)
    .filter((label) => typeof label === 'string' && label.length > 0);
}

// Masked to five small fields so a scan of the whole collection stays cheap — the
// recipes themselves (ingredients, prose) are never fetched. `steps` is not
// masked in either: the trigger checks for an empty method itself, and pulling
// every method here to pre-empt it would defeat the point of the mask. That is
// also the limit of what `--verify` can check — it prints the labels for a human
// to read against the method, because judging "does this name the right
// appliance?" needs the method text and the manifest, which is the recipe page's
// job and not a scan's.
async function listRecipes() {
  const docs = [];
  let pageToken = '';
  do {
    const url =
      `${BASE}/recipes?pageSize=300` +
      '&mask.fieldPaths=kitInferredAt&mask.fieldPaths=title&mask.fieldPaths=kind' +
      '&mask.fieldPaths=kit' +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const page = await api(url);
    for (const doc of page.documents ?? []) {
      docs.push({
        id: doc.name.split('/').pop(),
        title: doc.fields?.title?.stringValue ?? '(untitled)',
        // Absent `kind` means `recipe` — the schema defaults it, and 21 of the
        // production recipes predate the field entirely.
        kind: doc.fields?.kind?.stringValue ?? 'recipe',
        // The stamp is the whole of the done/pending question here, unlike the
        // times backfill's: a kit redo DELETES the stamp rather than bumping a
        // nonce past it, and a failed inference leaves it deleted, so a present
        // stamp always answers the latest request. No comparison is needed.
        inferred: doc.fields?.kitInferredAt !== undefined,
        labels: labelsOf(doc),
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
// Read-only, and the answer to the sequencing risk at the head of this file: it
// is how you notice that the functions were never deployed, or that the
// kill-switch is off, rather than reading a clean "asked N" summary and assuming
// the answers landed. Run it after every apply.

if (args.verify) {
  const pending = cookable.filter((r) => !r.inferred);
  for (const r of cookable) {
    const labels = r.labels.length > 0 ? r.labels.join(', ') : '(none)';
    console.log(`  ${r.inferred ? 'done   ' : 'PENDING'}  ${r.title}\n            ${labels}`);
  }
  console.log(`\nCookable recipes  : ${cookable.length}`);
  console.log(`Inferred          : ${cookable.length - pending.length}`);
  console.log(`Still pending     : ${pending.length}${pending.length === 0 ? ' ✔' : ' ✖'}`);
  console.log("\n  Read the labels above against each recipe's method. A named appliance");
  console.log('  the household owns should appear by name, not as its class.');
  // Non-zero while anything is outstanding, so a "did it work" reads off the exit
  // code rather than off the prose above it.
  process.exit(pending.length === 0 ? 0 : 1);
}

const notCookable = recipes.filter((r) => !COOKABLE_KINDS.has(r.kind));
const alreadyDone = args.redo ? [] : cookable.filter((r) => r.inferred);
const toAsk = args.redo ? cookable : cookable.filter((r) => !r.inferred);

console.log(`Recipes found     : ${recipes.length}`);
console.log(`Not cookable      : ${notCookable.length} (skipped — nothing to get out)`);
console.log(
  `Already inferred  : ${alreadyDone.length} (skipped${args.redo ? '' : ' — pass --redo to ask again'})`,
);
console.log(
  `To ask            : ${toAsk.length}${args.redo ? ' (--redo: clearing kitInferredAt)' : ''}\n`,
);

if (toAsk.length === 0) {
  console.log('✔ Nothing to do.');
  process.exit(0);
}

if (!args.apply) {
  for (const r of toAsk) {
    console.log(`  would ask  ${r.id}  ${r.title}`);
    if (args.redo && r.labels.length > 0) console.log(`             now: ${r.labels.join(', ')}`);
  }
  console.log(`\n✔ Dry run: ${toAsk.length} recipe(s) would be asked for a kit list.`);
  console.log('  Nothing was written. Re-run with --apply to do it.');
  process.exit(0);
}

// ─── Confirm (production only) ────────────────────────────────────────────────
//
// A FLAG, never a readline prompt, and that is a scar rather than a preference
// (issue #954 phase 3 context pointers). Run under `!` from a shell or through an
// agent's Bash tool there is no TTY, so a readline question never settles: the
// process prints the entire write plan and then hangs on a top-level await,
// looking exactly like a crash mid-write when in fact nothing has been written at
// all. `scripts/fix-recipe-range-timers.mjs` and `scripts/backfill-recipe-times.mjs`
// take the flag for the same reason; the prompt this replaced is the thing not to
// copy, and backfill-recipe-attribution.mjs still has one.

if (args.project === 'prod') {
  if (args.confirm === undefined) {
    console.error('✖ Writing to PRODUCTION needs confirmation. Nothing written.');
    console.error('  Re-run with the confirmation as a flag:');
    console.error(
      `    node scripts/backfill-recipe-kit.mjs --project prod --apply${args.redo ? ' --redo' : ''} --confirm production`,
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
  // What the trigger's `kitNeedsInference` guard reads: the nonce alone on an
  // ordinary pass, and on `--redo` the nonce plus a DELETE of `kitInferredAt`
  // (expressed as a path in the mask with no value in the body). Both halves and
  // the reasoning are in scripts/lib/recipeKitRequest.mjs.
  const { fieldPaths, fields } = planKitRequest(Date.now(), args.redo);
  const mask = fieldPaths.map((path) => `updateMask.fieldPaths=${path}`).join('&');
  const url = `${BASE}/recipes/${encodeURIComponent(r.id)}?${mask}`;
  try {
    await api(url, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
    asked += 1;
    console.log(`  asked   ${r.id}  ${r.title}`);
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
console.log('  The kit lists land as the trigger answers; watch the function logs for failures.');
process.exitCode = failures.length > 0 ? 1 : 0;
