// One-off operator script: add two curated matchers to two EXISTING
// `kitchenTools` documents. Nothing else.
//
// WHY THIS EXISTS — issue #1460, folded into #1465. `kitchenToolForKitLabel`
// refuses a single-word winning phrase for a kit label that exactly names one
// of the household's manifest accessories (see that function's header comment
// for the full rule). Running both `origin/main`'s and this branch's resolvers
// over production's real vocabulary showed the regression concretely: the
// labels "Egg Whisk" and "Glass Mixing Bowl" drew `kit-icons/whisk.webp` and
// `kit-icons/bowl.webp` on `origin/main`, and draw nothing on this branch,
// because `kitchenTools/whisk` and `kitchenTools/bowl` were seeded with only
// their bare single-word label and no matcher long enough to satisfy the new
// rule's second condition.
//
// The fix is the same curation act the seed table already made for its own
// `whisk` and `ladle` rows (`scripts/kitchen-tool-vocabulary.mjs`): add the
// phrase that names the accessory as an extra matcher on the LIVE document.
//
// WHY NOT THE SEEDER — `seed-kitchen-tools.mjs --apply` `.set()`s the whole
// document (label, thumbnail, iconRequestedAt, schemaVersion, createdAt,
// updatedAt included) and regenerates the drawing. That is the right shape for
// minting or re-drawing a tool; it is the wrong shape for adding one word to
// an array on a document that is otherwise exactly right. This script issues a
// field-masked `.update({ matchers })` instead, so nothing else on either
// document moves.
//
// WHY `updatedAt` IS NOT TOUCHED — `apps/web-pwa/src/lib/kitchenToolService.ts`
// uses `iconRequestedAt ?? updatedAt` as the icon cache-bust nonce. `whisk` has
// no `iconRequestedAt`, so bumping `updatedAt` for a matchers-only change would
// needlessly bust every browser's cached whisk icon for bytes that did not
// change. `.update()` never touches a field it is not given, so this is true by
// construction rather than by care.
//
// THE DECISION LAYER — which two documents, which two matchers, and whether a
// given document already has its matcher — lives in the pure, tested
// `scripts/lib/kitchenToolAccessoryMatchers.ts` (docs/one-shot-scripts.md's
// split). This file is the disposable half: read, plan, print, write behind
// `--write`.
//
// A FUTURE RE-SEED SUPERSEDES THIS FILE. Once the seed table's own curated
// `whisk`/`egg whisk` and `ladle`/`soup ladle` rows are live on every
// environment via `seed-kitchen-tools.mjs --apply`, these two targets are
// redundant and this script can be deleted.
//
// SAFE BY DEFAULT — dry run (prints every target's before/after `matchers` and
// an explicit "no writes made" line) unless `--write`. No readline prompt of
// any kind: a non-TTY session cannot answer one, and this repo has an
// established failure where a readline production gate hangs forever after
// printing its whole write plan (docs/one-shot-scripts.md §3). `--write` is the
// only gate.
//
// NEVER CREATES A DOCUMENT. A target that does not exist on the target project
// (`dev` may not have these ids) is reported with a warning and skipped.
//
// IDEMPOTENT. A matcher already present is left alone — re-running this script
// against an already-fixed document reports nothing to write for it.
//
// USAGE (from apps/cloud-functions) — needs ADC only, same convention as
// prune-instance-named-kitchen-tools.ts:
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/fix-kitchen-tool-accessory-matchers.ts
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/fix-kitchen-tool-accessory-matchers.ts --write
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd  pnpm exec tsx scripts/fix-kitchen-tool-accessory-matchers.ts --write

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  KITCHEN_TOOL_MATCHER_FIXUPS,
  planKitchenToolMatcherFixups,
} from './lib/kitchenToolAccessoryMatchers.js';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
if (!projectId) {
  console.error('GOOGLE_CLOUD_PROJECT is required (e.g. s2-stage-ccb22)');
  process.exit(1);
}
const write = process.argv.includes('--write');

initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore();

async function main(): Promise<void> {
  console.log(
    `\n${projectId}: checking ${KITCHEN_TOOL_MATCHER_FIXUPS.length} kitchenTools document(s)\n`,
  );

  const existing = new Map<string, readonly string[]>();
  for (const { id } of KITCHEN_TOOL_MATCHER_FIXUPS) {
    const snap = await db.collection('kitchenTools').doc(id).get();
    if (snap.exists) {
      const matchers = (snap.get('matchers') as string[] | undefined) ?? [];
      existing.set(id, matchers);
    }
  }

  const steps = planKitchenToolMatcherFixups(KITCHEN_TOOL_MATCHER_FIXUPS, existing);

  for (const step of steps) {
    if (!step.found) {
      console.warn(
        `  WARN  kitchenTools/${step.id} does not exist on ${projectId} — skipping. ` +
          'This script never creates a document.',
      );
      continue;
    }
    if (step.alreadyPresent) {
      console.log(
        `  SKIP  kitchenTools/${step.id} already has "${step.matcher}" — matchers: ${JSON.stringify(step.before)}`,
      );
      continue;
    }
    console.log(`  ${write ? 'WRITE' : 'PLAN'}  kitchenTools/${step.id}`);
    console.log(`          before: ${JSON.stringify(step.before)}`);
    console.log(`          after:  ${JSON.stringify(step.after)}`);
  }

  const toWrite = steps.filter((s) => s.needsWrite);

  if (!write) {
    console.log(
      `\n${toWrite.length} document(s) would be updated. no writes made — re-run with --write to apply.\n`,
    );
    return;
  }

  for (const step of toWrite) {
    // `needsWrite` is only ever true for a found document (see
    // `planKitchenToolMatcherFixups`), so `after` is never null here — this
    // guard is for the type checker, not a runtime path this loop can take.
    if (!step.after) continue;
    // Field-masked: only `matchers` moves. `label`, `thumbnail`,
    // `iconRequestedAt`, `schemaVersion`, `createdAt` and `updatedAt` are
    // untouched, deliberately — see the header comment.
    await db
      .collection('kitchenTools')
      .doc(step.id)
      .update({ matchers: [...step.after] });
    console.log(`  updated kitchenTools/${step.id}`);
  }

  console.log(`\n${toWrite.length} document(s) updated.\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
