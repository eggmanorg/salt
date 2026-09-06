#!/usr/bin/env node
// One-off (issue #1281): lift every stored stage environment from the bare
// `{ celsius: n }` it has held since #806 to the discriminated
// `{ temperature: { kind: 'fixed', celsius: n }, equipmentId: null }` the narrowed
// schema requires.
//
//   node scripts/migrate-stage-temperature.mjs --project dev     --dry-run
//   node scripts/migrate-stage-temperature.mjs --project staging --apply
//   node scripts/migrate-stage-temperature.mjs --project prod    --apply
//
// Writing to prod asks you to type "production". Where stdin is not a terminal
// (a Claude Code `!` command, CI, anything piped) type it as a flag instead:
//   node scripts/migrate-stage-temperature.mjs --project prod --apply --confirm production
//
// ─── RUN THIS BEFORE THE SCHEMA SHIPS ────────────────────────────────────────
//
// The new schema carries NO legacy branch, deliberately (see
// schemas/process.ts): a `z.union` holding a bare-number variant forever is code
// every future reader must understand, to serve a handful of documents that could
// be fixed once. The consequence is the #1122 ordering — this runs first, and an
// environment it has not reached fails validation and takes its formula screen
// down as a corruption Failure.
//
// TWO COLLECTIONS, and the second is the one that is easy to forget:
//   - `formulas/{recipeId}`.process[]  — the recipe's own stages
//   - `batches/{batchId}`.stages[]     — `BatchStageSchema` EXTENDS
//     `ProcessStageSchema`, so a frozen run carries the same environment shape.
//
// SAFE TO RE-RUN: a stage already carrying `temperature` is left alone, so a
// second pass reports nothing to do and writes nothing.
//
// Field-level PATCH on the raw REST tree, and `updatedAt` deliberately untouched
// — both for the reasons scripts/fix-recipe-range-timers.mjs states in full.
//
// Auth: your local `gcloud` active account (`gcloud auth login`).

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { migrateStagesNode, needsWrite } from './lib/stageTemperatureMigration.mjs';

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

// The two collections and the array field each keeps its stages in.
const TARGETS = [
  { collection: 'formulas', field: 'process' },
  { collection: 'batches', field: 'stages' },
];

function die(message) {
  console.error(`✖ ${message}`);
  console.error(
    '\nUsage: node scripts/migrate-stage-temperature.mjs --project <dev|staging|prod> (--dry-run | --apply)' +
      '\n       add --confirm production to write to prod without an interactive prompt',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--project') args.project = argv[(i += 1)];
    else if (arg === '--confirm') args.confirm = argv[(i += 1)];
    else die(`Unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.project) die('--project is required (dev | staging | prod). There is no default.');
const env = ENVIRONMENTS[args.project];
if (!env) die(`Unknown project "${args.project}". Expected one of: dev, staging, prod.`);
if (!env.expects.test(env.project)) {
  die(`Project id "${env.project}" does not look like ${args.project}. Refusing to write to it.`);
}
if (args.dryRun && args.apply) die('Pass either --dry-run or --apply, not both.');
if (!args.dryRun && !args.apply) die('Pass --dry-run to preview, or --apply to write.');

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
console.log(`Mode    : ${args.dryRun ? 'DRY RUN — nothing will be written' : 'WRITE'}\n`);

async function listDocs(collection, field) {
  const docs = [];
  let pageToken = '';
  do {
    const url =
      `${BASE}/${collection}?pageSize=300&mask.fieldPaths=${field}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const page = await api(url);
    for (const doc of page.documents ?? []) {
      docs.push({ id: doc.name.split('/').pop(), node: doc.fields?.[field] });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return docs;
}

const planned = [];
const unreadable = [];
let scanned = 0;

for (const target of TARGETS) {
  const docs = await listDocs(target.collection, target.field);
  scanned += docs.length;
  for (const doc of docs) {
    const outcomes = migrateStagesNode(doc.node);
    outcomes.forEach((outcome, index) => {
      if (outcome === 'unreadable') {
        unreadable.push(`${target.collection}/${doc.id} stage ${index + 1}`);
      }
    });
    if (needsWrite(outcomes)) {
      planned.push({
        ...target,
        id: doc.id,
        node: doc.node,
        count: outcomes.filter((o) => o === 'migrated').length,
      });
    }
  }
  console.log(`${target.collection.padEnd(9)} scanned ${docs.length}`);
}

const stageCount = planned.reduce((total, d) => total + d.count, 0);
console.log(`\nDocuments scanned : ${scanned}`);
console.log(`Documents to fix  : ${planned.length}`);
console.log(`Stages to lift    : ${stageCount}\n`);

for (const doc of planned) {
  console.log(`  ${doc.collection}/${doc.id} — ${doc.count} stage(s)`);
}

if (unreadable.length) {
  console.log('\n  Left alone (an environment with neither shape — decide by hand):');
  for (const where of unreadable) console.log(`      ${where}`);
}

if (stageCount === 0) {
  console.log('\n✔ Nothing to do.');
  process.exit(0);
}

if (args.dryRun) {
  console.log(`\n✔ Dry run: ${stageCount} stage(s) across ${planned.length} document(s).`);
  console.log('  Nothing was written.');
  process.exit(0);
}

if (args.project === 'prod') {
  if (args.confirm !== undefined) {
    if (args.confirm !== 'production') {
      console.error(`✖ --confirm must be exactly "production" (got "${args.confirm}").`);
      console.error('  Nothing written.');
      process.exit(1);
    }
    console.log(`\nConfirmed via --confirm: lifting ${stageCount} stage(s) in ${env.project}.\n`);
  } else if (!process.stdin.isTTY) {
    console.error('\n✖ Writing to PRODUCTION needs confirmation, and stdin is not a terminal');
    console.error('  so there is nothing to type into. Nothing was written.\n');
    console.error('  Re-run in an interactive terminal, or pass the confirmation as a flag:');
    console.error(
      '    node scripts/migrate-stage-temperature.mjs --project prod --apply --confirm production',
    );
    process.exit(1);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`\nType "production" to lift ${stageCount} stage(s) in ${env.project}: `, (a) => {
        rl.close();
        resolve(a.trim());
      }),
    );
    if (answer !== 'production') {
      console.error('✖ Not confirmed. Nothing written.');
      process.exit(1);
    }
    console.log('');
  }
}

let migrated = 0;
const failures = [];
for (const doc of planned) {
  const url = `${BASE}/${doc.collection}/${encodeURIComponent(doc.id)}?updateMask.fieldPaths=${doc.field}`;
  try {
    await api(url, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [doc.field]: doc.node } }),
    });
    migrated += doc.count;
    console.log(`  lifted ${doc.count} stage(s)  ${doc.collection}/${doc.id}`);
  } catch (err) {
    // Keep going: one unwritable document must not strand the rest, and the run
    // is re-runnable, so anything failing here is picked up next time.
    failures.push({ id: doc.id, message: err.message });
    console.error(`  FAILED  ${doc.collection}/${doc.id} — ${err.message}`);
  }
}

console.log(`\n✔ ${env.project}: lifted ${migrated} stage(s), failed ${failures.length}.`);
process.exit(failures.length > 0 ? 1 : 0);
