// Emits dist/package.json — the package manifest that ships to Cloud Functions.
//
// The esbuild bundle (dist/index.js) inlines everything EXCEPT the
// --external packages (firebase-admin, firebase-functions, sharp). Those, plus
// the two @google-cloud backends firebase-admin leaves optional (see below),
// are the deployed artifact's only real runtime dependencies. sharp is a
// native module (prebuilt binaries) and MUST stay external so `npm install`
// against this manifest fetches the platform-correct binary on the Functions
// runtime. Crucially this manifest must contain NO `workspace:*` deps: Cloud
// Build runs plain `npm install` against it and cannot resolve pnpm's workspace
// protocol (EUNSUPPORTEDPROTOCOL).
//
// firebase.json points functions.source at dist/, so THIS file (not the source
// package.json with its workspace deps) is what gets uploaded.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));

const pick = (name) => {
  const v = src.dependencies?.[name];
  if (!v) throw new Error(`expected ${name} in cloud-functions dependencies`);
  return v;
};

// firebase-admin declares @google-cloud/firestore and @google-cloud/storage as
// OPTIONAL dependencies, and npm SILENTLY SKIPS an optional dependency whose
// `engines` does not match the Node version running the install. Since
// firebase-admin 14.4.0 (2026-09-10) those two require node >= 22, while all
// three deploy workflows run the Firebase CLI — and therefore this predeploy
// build — on Node 20 (the WIF/undici workaround documented in
// .github/workflows/deploy-staging.yml). Result: an install that exits 0 with
// 163 packages instead of 277, and a deploy that dies during codebase analysis
// with "Cannot find module '@google-cloud/firestore'".
//
// Salt is a Firestore app: those two are not optional for us. Promoting them to
// real dependencies makes npm install them whatever Node resolves the tree, and
// turns an engines mismatch back into what it should be — a warning, not a
// silent omission. The ranges are READ FROM the installed firebase-admin rather
// than written here, so a future firebase-admin bump cannot leave them stale.
const adminOptional = () => {
  const adminPkg = JSON.parse(
    readFileSync(resolve(pkgRoot, 'node_modules/firebase-admin/package.json'), 'utf8'),
  );
  const entries = Object.entries(adminPkg.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith('@google-cloud/'),
  );
  if (entries.length === 0) {
    throw new Error('expected @google-cloud/* in firebase-admin optionalDependencies');
  }
  return Object.fromEntries(entries);
};

const deployPkg = {
  name: 'salt-cloud-functions',
  type: 'module',
  // Relative to dist/, which is the deployed source root.
  main: 'index.js',
  // Drives the deployed Node runtime (nodejs22) — must be present.
  engines: src.engines,
  dependencies: {
    'firebase-admin': pick('firebase-admin'),
    'firebase-functions': pick('firebase-functions'),
    sharp: pick('sharp'),
    ...adminOptional(),
  },
  // TEMPORARY upstream workaround (2026-07-30). @firebase/database-compat 2.1.5
  // requires '@firebase/app' at load time in dist/index.standalone.js while
  // declaring it only as an OPTIONAL peer — which npm never installs. So a fresh
  // install of firebase-admin (any 13.x/14.x: it depends on
  // @firebase/database-compat ^2.0.0) yields a tree that throws
  // "Cannot find module '@firebase/app'" the moment firebase-functions pulls in
  // firebase-admin/database. Salt never touches RTDB — the chain is
  // firebase-functions → lib/common/providers/database.js → firebase-admin/database.
  //
  // This manifest is the ONLY install in the repo without a lockfile behind it
  // (Cloud Build and globalSetup.ts both run plain `npm install` against it),
  // which is why it broke while pnpm-lock.yaml — already resolved at 2.1.4 —
  // kept the workspace working. The pin restores that same version, so the
  // deployed tree matches what the workspace builds and tests against.
  //
  // Symptoms if this is ever removed prematurely: the Functions emulator fails
  // to analyze the codebase (no triggers → the e2e container healthcheck never
  // passes), e2e sign-in dies as a misleading "Network error" (the
  // beforeMemberCreated blocking function is killed by the missing module), and
  // deployed functions crash on cold start. Drop the pin once upstream ships a
  // release that installs what it requires.
  overrides: {
    '@firebase/database-compat': '2.1.4',
  },
};

writeFileSync(resolve(pkgRoot, 'dist/package.json'), JSON.stringify(deployPkg, null, 2) + '\n');
console.log(
  `wrote dist/package.json (deploy artifact: ${Object.keys(deployPkg.dependencies).join(', ')})`,
);
