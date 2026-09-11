// Fails the build if dist/node_modules is missing anything the deployed bundle
// needs at runtime. Runs after the dist install, before the artifact ships.
//
// Why this exists: `npm install` exits 0 while silently omitting an OPTIONAL
// dependency whose `engines` does not match the Node version running the
// install. That is exactly how the 2026-09-10 staging deploy broke — the tree
// came out 114 packages short and the failure only surfaced minutes later, as
// "Cannot find module '@google-cloud/firestore'" during Firebase's codebase
// analysis. Nothing in the build noticed. This makes that class of silent
// omission a red build instead of a broken deploy (CLAUDE.md hard rule 12).
//
// Two assertions:
//   1. every dependency declared in the deploy manifest is actually on disk;
//   2. firebase-admin can resolve its own Firestore/Storage backends from where
//      it sits — the transitive case a manifest check alone would miss.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(pkgRoot, 'dist');

const manifest = JSON.parse(readFileSync(resolve(distRoot, 'package.json'), 'utf8'));
const problems = [];

for (const name of Object.keys(manifest.dependencies ?? {})) {
  if (!existsSync(resolve(distRoot, 'node_modules', name, 'package.json'))) {
    problems.push(`declared dependency ${name} is missing from dist/node_modules`);
  }
}

// firebase-admin lazily requires these; a missing one only throws on first use,
// which on Cloud Functions means at deploy-time analysis or cold start.
const adminEntry = resolve(distRoot, 'node_modules/firebase-admin/package.json');
if (existsSync(adminEntry)) {
  const requireFromAdmin = createRequire(adminEntry);
  for (const backend of ['@google-cloud/firestore', '@google-cloud/storage']) {
    try {
      requireFromAdmin.resolve(backend);
    } catch {
      problems.push(`firebase-admin cannot resolve ${backend} from dist/node_modules`);
    }
  }
}

if (problems.length > 0) {
  console.error('verify-deploy-tree: the dist install is incomplete —');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nnpm exits 0 when it skips an optional dependency whose engines do not match\n' +
      `the installing Node (this build ran on ${process.version}). Re-run the build on\n` +
      'the Node version in package.json "engines", or declare the missing package\n' +
      'explicitly in scripts/write-deploy-package.mjs.',
  );
  process.exit(1);
}

console.log('verify-deploy-tree: dist install is complete');
