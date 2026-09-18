// One-off operator script: ask the kit flow again, once, for every recipe that
// has a kit — so a recipe stored before #1470 gains the links that say which of
// the household's things each line means.
//
// WHY THIS EXISTS — issue #1465, Phase 4. Until #1470 a kit entry was WORDS and
// nothing else, and every surface re-derived "which of your things is this" from
// those words on every draw. That derivation is what fails for families: "Tefal
// non-stick 28cm" contains no word of "Frying Pans", and no token rule can find
// it. #1470 made the flow record the answer at write time; this script is how the
// ~66 recipes already in production come to carry it. Without it the guessing
// code has to stay forever and old recipes never recognise a family member.
//
// IT NEVER CALLS THE MODEL AND NEVER WRITES A `kit` ARRAY. It does exactly what
// the "Redo kit" button does — clears `kitInferredAt` and bumps `kitRequestedAt`
// in one masked `.update()` — and lets `onRecipeWritten`'s kit branch do the
// inference and the write. Both halves are needed and neither is optional; see
// `redoRecipeKit.ts`'s header for why clearing the stamp alone is a no-op on a
// recipe whose inference previously failed. A partial `.update()` rather than a
// `setDoc` for the same reason that callable gives: a whole-document write would
// LWW-clobber whatever the trigger is concurrently writing.
//
// RATE LIMITED BY WAITING, NOT BY A TIMER. Recipes are processed strictly one at
// a time, and each one is polled until the trigger stamps `kitInferredAt` again
// before the next is touched. That is the rate limit, and its boundary is
// `STAMP_TIMEOUT_MS`: up to that point exactly one inference of ours is in
// flight, and only a recipe that times out can leave one running behind us. So
// ~66 recipes cost ~66 serial text-model calls rather than ~66 concurrent ones,
// with the overlap bounded by however many time out. `SETTLE_MS` is a small gap
// after each, not the mechanism.
//
// HOW "DONE" IS DECIDED, and its actual boundary. The update DELETES
// `kitInferredAt`, so the field being present again can only have been written
// after that update landed — no clock comparison, no skew assumption between this
// machine and the function's. What that does NOT distinguish is a stamp written
// by a CONCURRENT edit of the same recipe by somebody using the app. That is a
// benign collision (the kit was re-inferred either way) and it is the only case
// where "done" means something slightly different from "done by us".
//
// AN INFERENCE THAT FAILS LEAVES NO STAMP — deliberately, so a redo can retry
// (see `RecipeSchema.kitInferredAt`). After `STAMP_TIMEOUT_MS` such a recipe is
// warned about on the console, marked NEVER STAMPED in the report and left; the
// run then moves on. A resumed run re-targets it, because it still carries no
// fresh stamp. Note the two are indistinguishable from here: a failed inference
// and one that is merely slower than the timeout look the same, and both are
// answered the same way.
//
// RESUMABLE. `--write` prints its own start instant; re-running with
// `--since <that number>` skips every recipe already stamped at or after it. An
// interrupted run therefore costs the recipes it did not reach, not all of them
// again. Same mechanism `RecipeSchema.timesEstimatedAt` describes for the #952
// backfill.
//
// SAFE BY DEFAULT — dry run (prints the whole plan and an explicit "no writes
// made" line) unless `--write`. NO READLINE PROMPT OF ANY KIND: a non-TTY session
// cannot answer one, and this repo has an established failure where a production
// confirm gate hangs forever after printing its whole write plan
// (docs/one-shot-scripts.md §3, issue #1067). `--write` is the only gate, and
// `--limit` is how a first cautious pass is taken on a new environment.
//
// THE REPORT IS THE POINT. Every `--write` run writes a before/after label diff
// to a markdown file (`--out`, defaulted per project and start instant) — what
// each recipe's kit said before, what it says now, and which lines gained a link.
// The issue's own acceptance is a spot-check of recipes using the Magimix, the
// rice cooker and a named pan; this file is what that check reads.
//
// THE DECISION LAYER — which recipes are in scope, and what counts as a change —
// lives in the pure, tested `scripts/lib/kitRerunPlan.ts` (docs/one-shot-scripts.md
// §2 split). This file is the disposable half: read, plan, print, write behind
// `--write`, poll, report.
//
// USAGE (from apps/cloud-functions) — needs ADC only, same convention as
// prune-instance-named-kitchen-tools.ts. Environments in order, dry run first
// each time:
//   GOOGLE_CLOUD_PROJECT=s2-dev-eggman  pnpm exec tsx scripts/rerun-recipe-kits.ts
//   GOOGLE_CLOUD_PROJECT=s2-dev-eggman  pnpm exec tsx scripts/rerun-recipe-kits.ts --write
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/rerun-recipe-kits.ts
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/rerun-recipe-kits.ts --write
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd  pnpm exec tsx scripts/rerun-recipe-kits.ts
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd  pnpm exec tsx scripts/rerun-recipe-kits.ts --write --limit 1
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd  pnpm exec tsx scripts/rerun-recipe-kits.ts --write
// Resume an interrupted run (the start instant is printed by the run itself):
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd  pnpm exec tsx scripts/rerun-recipe-kits.ts --write --since 1758240000000
//
// AFTERWARDS. Confirming the production run is what unblocks deleting
// `groupKitByEquipment`'s two word-based passes — the issue's point of no return,
// and deliberately a separate PR.

import { writeFile } from 'node:fs/promises';

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { equipmentEntrySubjectName } from '@salt/domain';
import { RecipeSchema } from '@salt/domain/schemas';
import type { EquipmentItemDoc } from '@salt/domain/schemas';

import { readEquipmentItems } from '../src/flows/equipmentContext.js';
import { diffKitEntries, planKitRerun } from './lib/kitRerunPlan.js';
import type { KitDiff, KitLink, RecipeKitSnapshot } from './lib/kitRerunPlan.js';

/** How long one recipe's inference is waited for before it is called timed out. */
const STAMP_TIMEOUT_MS = 180_000;
/** How often the recipe is re-read while waiting. */
const POLL_MS = 3_000;
/** A gap after each completed recipe. Courtesy, not the rate limit — see header. */
const SETTLE_MS = 2_000;

const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
if (!projectId) {
  console.error('GOOGLE_CLOUD_PROJECT is required (e.g. s2-stage-ccb22)');
  process.exit(1);
}

const argv = process.argv.slice(2);
const write = argv.includes('--write');

function flagValue(name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return value;
}

function numericFlag(name: string): number | null {
  const raw = flagValue(name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number, got "${raw}"`);
    process.exit(1);
  }
  return value;
}

const since = numericFlag('--since');
const limit = numericFlag('--limit');
const startedAt = Date.now();
const outPath = flagValue('--out') ?? `./kit-rerun-${projectId}-${startedAt}.md`;

initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore();

// A PICK of the three fields this script reads, rather than the whole
// `RecipeSchema`: a recipe that fails some UNRELATED field's validation is still
// one whose kit needs re-running, and skipping it would silently leave a gap the
// report claims does not exist. Picked from the shared schema rather than
// re-declared, so the kit entry's link shape cannot drift from what the flow
// writes. Firestore is a trust boundary and this is a `.safeParse`
// (CLAUDE.md → Zod conventions); a document that fails even this narrow parse is
// named in a WARN and skipped, never re-run blind.
const KitReadSchema = RecipeSchema.pick({ title: true, kit: true, kitInferredAt: true });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The words a human recognises for a link, from the live manifest. */
function describeLink(link: KitLink | null, items: readonly EquipmentItemDoc[]): string {
  if (link === null) return 'no link';
  const item = items.find((candidate) => candidate.id === link.itemId);
  if (!item) return `dangling item ${link.itemId}`;
  if (link.accessoryId === null) return item.name;
  const accessory = item.accessories.find((candidate) => candidate.id === link.accessoryId);
  if (!accessory) return `${item.name} → dangling entry ${link.accessoryId}`;
  return equipmentEntrySubjectName(item, accessory);
}

async function readRecipes(): Promise<{
  snapshots: readonly RecipeKitSnapshot[];
  unreadable: readonly string[];
}> {
  const snap = await db.collection('recipes').get();
  const snapshots: RecipeKitSnapshot[] = [];
  const unreadable: string[] = [];
  for (const doc of snap.docs) {
    const parsed = KitReadSchema.safeParse(doc.data());
    if (!parsed.success) {
      unreadable.push(doc.id);
      continue;
    }
    snapshots.push({
      id: doc.id,
      title: parsed.data.title,
      kit: parsed.data.kit.map((entry) => ({ label: entry.label, equipment: entry.equipment })),
      kitInferredAt: parsed.data.kitInferredAt ?? null,
    });
  }
  snapshots.sort((a, b) => a.title.localeCompare(b.title));
  return { snapshots, unreadable };
}

/** Read one recipe's kit as it stands now. Null when the document has vanished. */
async function readKitNow(
  id: string,
): Promise<{ kit: RecipeKitSnapshot['kit']; stamped: boolean } | null> {
  const doc = await db.collection('recipes').doc(id).get();
  if (!doc.exists) return null;
  const parsed = KitReadSchema.safeParse(doc.data());
  if (!parsed.success) return null;
  return {
    kit: parsed.data.kit.map((entry) => ({ label: entry.label, equipment: entry.equipment })),
    stamped: parsed.data.kitInferredAt !== undefined,
  };
}

interface Outcome {
  readonly id: string;
  readonly title: string;
  readonly stamped: boolean;
  readonly before: RecipeKitSnapshot['kit'];
  readonly after: RecipeKitSnapshot['kit'];
  readonly diff: KitDiff;
}

function renderReport(outcomes: readonly Outcome[], items: readonly EquipmentItemDoc[]): string {
  const lines: string[] = [
    `# Kit re-run — ${projectId}`,
    '',
    `Started ${new Date(startedAt).toISOString()} (epoch ${startedAt}).`,
    `${outcomes.length} recipe(s) re-run, ` +
      `${outcomes.filter((o) => o.diff.changed).length} with a changed kit, ` +
      `${outcomes.filter((o) => !o.stamped).length} that never stamped.`,
    '',
  ];

  for (const outcome of outcomes) {
    lines.push(`## ${outcome.title}`);
    lines.push('');
    lines.push(`\`recipes/${outcome.id}\`${outcome.stamped ? '' : ' — **NEVER STAMPED**'}`);
    lines.push('');
    if (!outcome.diff.changed) {
      lines.push('No change — same labels, same links.');
      lines.push('');
      continue;
    }
    for (const change of outcome.diff.relinked) {
      lines.push(
        `- **re-linked** "${change.label}": ${describeLink(change.before, items)} → ` +
          `${describeLink(change.after, items)}`,
      );
    }
    for (const entry of outcome.diff.removed) {
      lines.push(`- **gone** "${entry.label}" (${describeLink(entry.equipment, items)})`);
    }
    for (const entry of outcome.diff.added) {
      lines.push(`- **new** "${entry.label}" (${describeLink(entry.equipment, items)})`);
    }
    lines.push(`- ${outcome.diff.unchanged} line(s) unchanged`);
    lines.push('');
    lines.push(`  before: ${outcome.before.map((e) => e.label).join(' · ') || '(empty)'}`);
    lines.push(`  after:  ${outcome.after.map((e) => e.label).join(' · ') || '(empty)'}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const [{ snapshots, unreadable }, items] = await Promise.all([
    readRecipes(),
    readEquipmentItems(db, 'rerun-recipe-kits'),
  ]);

  console.log(
    `\n${projectId}: ${snapshots.length} recipe(s) read, ${items.length} equipment record(s)\n`,
  );
  for (const id of unreadable) {
    console.warn(`  WARN  recipes/${id} failed validation on title/kit — skipped, nothing written`);
  }

  const steps = planKitRerun(snapshots, since);
  const allTargets = steps.filter((step) => step.skip === null);
  const targets = limit === null ? allTargets : allTargets.slice(0, limit);

  for (const step of steps) {
    if (step.skip === 'empty-kit') continue; // the common, uninteresting case
    if (step.skip === 'already-rerun') {
      console.log(`  SKIP  ${step.title} — already re-run (--since ${since})`);
    }
  }
  for (const step of targets) {
    console.log(`  ${write ? 'REDO' : 'PLAN'}  ${step.title}  (${step.before.length} line(s))`);
  }

  console.log(
    `\n${steps.filter((s) => s.skip === 'empty-kit').length} recipe(s) have no kit and are left alone; ` +
      `${steps.filter((s) => s.skip === 'already-rerun').length} already re-run; ` +
      `${targets.length} to re-run` +
      (limit !== null && allTargets.length > targets.length
        ? ` (--limit ${limit} of ${allTargets.length})`
        : ''),
  );

  if (!write) {
    console.log(
      `\ndry run — nothing written. Re-run with --write to ask the kit flow again ` +
        `for ${targets.length} recipe(s), one at a time.\n`,
    );
    return;
  }

  console.log(
    `\nstart instant ${startedAt} — resume an interrupted run with --since ${startedAt}\n`,
  );

  const outcomes: Outcome[] = [];
  for (const [index, step] of targets.entries()) {
    console.log(`  [${index + 1}/${targets.length}] ${step.title}`);
    await db
      .collection('recipes')
      .doc(step.id)
      .update({ kitInferredAt: FieldValue.delete(), kitRequestedAt: Date.now() });

    // Presence alone is the completion test, and it is sound because the update
    // above deleted the field — see the header for what it does and does not
    // distinguish.
    const deadline = Date.now() + STAMP_TIMEOUT_MS;
    let current = await readKitNow(step.id);
    while (Date.now() < deadline && current !== null && !current.stamped) {
      await sleep(POLL_MS);
      current = await readKitNow(step.id);
    }

    if (current === null) {
      console.warn(`          WARN  recipes/${step.id} is gone or unreadable — skipped`);
      continue;
    }
    if (!current.stamped) {
      console.warn(
        `          WARN  no stamp after ${STAMP_TIMEOUT_MS / 1000}s — inference probably failed. ` +
          `A resumed run re-targets it.`,
      );
    }

    const diff = diffKitEntries(step.before, current.kit);
    outcomes.push({
      id: step.id,
      title: step.title,
      stamped: current.stamped,
      before: step.before,
      after: current.kit,
      diff,
    });
    console.log(
      `          ${diff.changed ? 'changed' : 'unchanged'} — ` +
        `${diff.relinked.length} re-linked, ${diff.added.length} new, ${diff.removed.length} gone`,
    );
    await sleep(SETTLE_MS);
  }

  await writeFile(outPath, renderReport(outcomes, items), 'utf8');

  const stalled = outcomes.filter((outcome) => !outcome.stamped);
  console.log(
    `\n${outcomes.length} recipe(s) re-run, ${outcomes.filter((o) => o.diff.changed).length} changed. ` +
      `Before/after written to ${outPath}.`,
  );
  if (stalled.length > 0) {
    console.warn(
      `${stalled.length} never stamped: ${stalled.map((o) => o.title).join(', ')}. ` +
        `Re-run with --since ${startedAt} to retry just those.`,
    );
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
