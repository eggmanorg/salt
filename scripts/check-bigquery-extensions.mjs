#!/usr/bin/env node
// Proves the six Firestore → BigQuery export instances are configured with
// settings the extension actually understands.
//
// The property being pinned is stated in prose in
// `infra/bigquery-export/extensions/bq-export-batch-observations.env:15-22` and
// in that directory's README: `WILDCARD_IDS=true` is what makes an observation
// attributable to its run, and the extension reads the value literally. Until
// this script existed nothing made that true — an unrecognised value is not an
// install-time error, it is silently replaced by the declared default, so a
// wrong setting was invisible in review, in CI, and on the install that went to
// production. It happened once (PR #1424, `WILDCARD_IDS=yes`) and a person was
// the only thing that caught it.
//
// The rules, and the one limit this check cannot close, are in
// scripts/lib/bigqueryExtensionEnv.mjs.
//
// STATIC AND OFFLINE, absolutely. This reads three things off disk and contacts
// nothing. It must never invoke `firebase` — a whole-manifest
// `firebase deploy --only extensions` reconciles EVERY instance and restarts
// its function whether anything changed or not, and `--force` on a partial
// manifest deletes the instances it omits (infra/bigquery-export/README.md).
// Nor may it fetch the schema: the vendored copy under vendor/ is the pinned
// version's, where the registry's is whatever is published now.
//
// Run: pnpm bqext:check   (wired into ci.yml's `static` job)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditExtensionManifest,
  parseEnvFile,
  parseExtensionParams,
} from './lib/bigqueryExtensionEnv.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const infraDir = path.join(repoRoot, 'infra', 'bigquery-export');
const envDir = path.join(infraDir, 'extensions');
const vendorDir = path.join(infraDir, 'vendor');

const manifest = JSON.parse(readFileSync(path.join(infraDir, 'firebase.json'), 'utf8'));

const vendored = readdirSync(vendorDir).filter((file) => file.endsWith('.extension.yaml'));
if (vendored.length !== 1) {
  console.error(
    `BigQuery extension check failed: expected exactly one vendored *.extension.yaml in ` +
      `infra/bigquery-export/vendor/, found ${vendored.length}. A version bump REPLACES the ` +
      `vendored schema; it does not add a second one beside it.`,
  );
  process.exit(1);
}

const { id, version, params } = parseExtensionParams(
  readFileSync(path.join(vendorDir, vendored[0]), 'utf8'),
);

const envFiles = readdirSync(envDir)
  .filter((file) => file.endsWith('.env'))
  .sort()
  .map((file) => ({
    name: path.posix.join('infra/bigquery-export/extensions', file),
    instance: file.slice(0, -'.env'.length),
    parsed: parseEnvFile(readFileSync(path.join(envDir, file), 'utf8')),
  }));

const problems = auditExtensionManifest({
  manifest,
  envFiles,
  params,
  pinnedVersion: { id, version },
});

if (problems.length === 0) {
  console.log(
    `BigQuery extension config OK — ${envFiles.length} instances against ${id}@${version}, ` +
      `${params.size} declared parameters.`,
  );
  process.exit(0);
}

console.error(
  `BigQuery extension check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`,
);
for (const problem of problems) console.error(`  ${problem}\n`);
process.exit(1);
