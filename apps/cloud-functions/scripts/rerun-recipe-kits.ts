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
// `STAMP_TIMEOUT_MS` IS DERIVED, NOT PICKED (PR #1483 review, blocking 1). It is
// `AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS` — the trigger's own 300s function
// quota, the same constant `onRecipeWritten` is registered with — plus headroom
// for eventarc delivery and a cold start, neither counted inside that 300s. A
// wait shorter than the host's own budget gives up on a merely-slow-but-
// -successful inference before the system generating the answer does, which is
// actively harmful, not merely early: the report line for that recipe would show
// the PRE-RUN kit as "no change", the run would start a second inference on the
// next recipe while the first is technically still allowed to be running, and a
// resume would then skip the recipe (it stamped, just after we gave up) so
// nothing ever revisits it. Deriving from the same constant the trigger is
// registered with means the two cannot drift apart the way an independently
// chosen number can.
//
// HOW "DONE" IS DECIDED, and its actual boundary (PR #1483 review, blocking 2).
// The completion test compares the stamp's VALUE against `requestedAt` — the
// instant this run asked the trigger to run again, reused from the
// `kitRequestedAt` nonce already written in the same update — not merely its
// PRESENCE. Presence alone is falsified by this repo's documented whole-document
// LWW clobber (CLAUDE.md → Data model conventions): a client `setDoc` composed
// from a copy of the recipe taken before this run's update still carries the
// OLD `kitInferredAt`, and if a stale copy like that lands between our update
// and the trigger's write, presence alone reads it as "done" — recording a
// recipe as re-run that never was, while the real inference is still in flight
// behind us. A value comparison cannot be fooled that way: a restored old stamp
// is provably older than `requestedAt`, so it stays on the "not yet" branch.
// What a value comparison does NOT protect against, stated rather than rounded
// up: a stale `setDoc` landing AFTER we have already observed a genuine fresh
// stamp can still clobber the document back to the old kit and the old stamp,
// closing the trigger's guard on it permanently. No completion test run from
// here can prevent that — it is the same whole-document-LWW contract that
// governs every concurrent write to every recipe in this app, not a defect
// particular to this script, and re-solving it would mean wiring conflict
// resolution into `packages/domain`, which CLAUDE.md rule 1 says nothing does
// today.
//
// AN INFERENCE THAT FAILS LEAVES NO STAMP — deliberately, so a redo can retry
// (see `RecipeSchema.kitInferredAt`). After `STAMP_TIMEOUT_MS` such a recipe is
// warned about on the console, marked NEVER STAMPED in the report and left; the
// run then moves on. A resumed run re-targets it, because it still carries no
// fresh stamp. Note the two are indistinguishable from here: a failed inference
// and one that is merely slower than the timeout look the same, and both are
// answered the same way.
//
// FOUR STATES MAKE THE TRIGGER DECLINE AND NEVER STAMP (PR #1483 review,
// should-fix 4) — not-cookable, no-steps, the `devSettings/singleton` kill
// switch, and a document that fails the trigger handler's own FULL
// `RecipeSchema.safeParse`. All four are otherwise indistinguishable from a
// failed inference from here, and all four are permanent, so three are filtered
// before they can cost a `STAMP_TIMEOUT_MS` wait: not-cookable and no-steps are
// `planKitRerun` skip reasons (the pure half, using the same `isCookable`
// predicate `maybeInferKit` reads) and are named in the report as declined-by-
// guard entries; the kill switch is a pre-flight read that refuses `--write`
// outright when it is off; and a recipe failing the full schema is read for
// its title/kit only (never targeted) and named in the report separately —
// see `readRecipes` below.
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
// `--limit` is how a first cautious pass is taken on a new environment (a
// positive integer — a negative or fractional value is a usage error, not a
// weird-but-valid slice).
//
// THE REPORT IS THE POINT, and it is written after EVERY recipe, not only once
// at the end (PR #1483 review, blocking 3): the whole file is rewritten to disk
// each time an outcome is added, so an interrupt, a thrown `.update()` on a
// recipe deleted mid-run, or a bad `--out` directory loses at most the recipe in
// flight, never the record of the ones already done. That before/after record is
// unrecoverable once lost — Firestore holds no soft-delete or tombstone the
// script could re-read it from — so the resume feature and the evidence feature
// have to agree, and only writing incrementally makes that true. `--out`
// (defaulted per project and start instant) is what each recipe's kit said
// before, what it says now, and which lines gained a link — plus, since the same
// review (should-fix 5, extended to should-fix 4), every document this run
// could NOT act on and why: one failing even the narrow read, one failing the
// full schema, and one the trigger's own guards decline (not-cookable or
// no-steps). The issue's own acceptance is a spot-check of recipes using the
// Magimix, the rice cooker and a named pan; this file is what that check
// reads, and it is meant to hold every recipe the run touched or excluded, not
// only the successes.
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

import { rename, writeFile } from 'node:fs/promises';

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { equipmentEntrySubjectName } from '@salt/domain';
import { DevSettingsSchema, RecipeSchema } from '@salt/domain/schemas';
import type { EquipmentItemDoc } from '@salt/domain/schemas';

import { AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS } from '../src/adapters/withAiTimeout.js';
import { readEquipmentItems } from '../src/flows/equipmentContext.js';
import { diffKitEntries, planKitRerun } from './lib/kitRerunPlan.js';
import type { KitDiff, KitLink, RecipeKitSnapshot } from './lib/kitRerunPlan.js';

// Eventarc delivery latency plus, on a cold instance, container start — neither
// is counted inside the trigger's own `AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS`
// clock, which starts only once the function body runs. Generous rather than
// measured, the same posture `AI_TRIGGER_RECORDING_HEADROOM_MS` takes for its
// own margin.
const TRIGGER_DELIVERY_HEADROOM_MS = 60_000;
/**
 * How long one recipe's inference is waited for before it is called timed out.
 * Derived from the trigger's own function quota, not picked independently — see
 * this file's header, blocking finding 1.
 */
const STAMP_TIMEOUT_MS = AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS * 1000 + TRIGGER_DELIVERY_HEADROOM_MS;
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
const rawLimit = numericFlag('--limit');
// A positive integer, or a usage error (PR #1483 review, should-fix 7 —
// `--limit -1` used to silently drop the LAST target instead of erroring, and
// `--limit 1.5` used to silently slice to 1).
if (rawLimit !== null && (!Number.isInteger(rawLimit) || rawLimit <= 0)) {
  console.error(`--limit must be a positive whole number, got "${rawLimit}"`);
  process.exit(1);
}
const limit = rawLimit;
const startedAt = Date.now();
const outPath = flagValue('--out') ?? `./kit-rerun-${projectId}-${startedAt}.md`;

initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore();

// A PICK of the three fields this script reads, rather than the whole
// `RecipeSchema` — but ONLY as a fallback for reporting, not for targeting (PR
// #1483 review, should-fix 4). `readRecipes` below tries the full schema first;
// this pick exists so a document that fails it can still be named by title in
// the report rather than lumped in with `unreadable`. Picked from the shared
// schema rather than re-declared, so the kit entry's link shape cannot drift
// from what the flow writes.
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

/** A recipe named only by id and title — enough to point an operator at it. */
interface NamedRecipe {
  readonly id: string;
  readonly title: string;
}

async function readRecipes(): Promise<{
  snapshots: readonly RecipeKitSnapshot[];
  /** Failed even the narrow title/kit pick — nothing here is readable at all. */
  unreadable: readonly string[];
  /**
   * Has a non-empty kit but fails the FULL `RecipeSchema` — the same parse
   * `onRecipeWritten`'s handler runs before any branch runs (PR #1483 review,
   * should-fix 4). The trigger will decline these forever regardless of what
   * this script does, so they are read for the report but never targeted.
   */
  neverTriggers: readonly NamedRecipe[];
}> {
  const snap = await db.collection('recipes').get();
  const snapshots: RecipeKitSnapshot[] = [];
  const unreadable: string[] = [];
  const neverTriggers: NamedRecipe[] = [];
  for (const doc of snap.docs) {
    const full = RecipeSchema.safeParse(doc.data());
    if (full.success) {
      snapshots.push({
        id: doc.id,
        title: full.data.title,
        kit: full.data.kit.map((entry) => ({ label: entry.label, equipment: entry.equipment })),
        kitInferredAt: full.data.kitInferredAt ?? null,
        kind: full.data.kind,
        stepCount: full.data.steps.length,
      });
      continue;
    }
    const narrow = KitReadSchema.safeParse(doc.data());
    if (!narrow.success) {
      unreadable.push(doc.id);
      continue;
    }
    if (narrow.data.kit.length > 0) {
      neverTriggers.push({ id: doc.id, title: narrow.data.title });
    }
    // A narrow-readable recipe with an EMPTY kit that fails the full schema is
    // left out of both lists: it was never in scope (an empty kit is left alone
    // regardless — see `planKitRerun`) and naming it would be noise about a
    // pre-existing shape problem this run has no stake in.
  }
  snapshots.sort((a, b) => a.title.localeCompare(b.title));
  return { snapshots, unreadable, neverTriggers };
}

/** Why the wait for a fresh stamp ended. */
type StampWaitResult =
  | { readonly status: 'stamped'; readonly kit: RecipeKitSnapshot['kit'] }
  | { readonly status: 'timeout' }
  | { readonly status: 'not-found' };

/**
 * Poll one recipe until its `kitInferredAt` reads at or after `requestedAt`, the
 * document is confirmed gone, or `deadline` passes.
 *
 * VALUE, not presence (PR #1483 review, blocking 2 — see this file's header for
 * the full reasoning and its stated boundary). A document that merely fails
 * today's narrow parse is NOT treated as gone: only a confirmed-missing
 * `doc.exists === false` ends the wait early. A transient parse failure — a
 * concurrent edit briefly leaving the document in some other shape — keeps
 * polling to the deadline instead of silently dropping the recipe from the
 * report before it settles (PR #1483 review, should-fix 6).
 *
 * TWO CLOCKS feed that comparison, not one (PR #1483 review): `requestedAt` is
 * `Date.now()` on the operator's laptop, taken by the caller before this
 * function is invoked; `kitInferredAt` is a separate `Date.now()` stamped
 * inside the Cloud Function (`onRecipeWritten.ts`). The comparison assumes the
 * two clocks agree closely enough to matter and never verifies that they do.
 * It still fails conservatively: a server clock running behind the laptop's
 * can only make a genuine completion read as "not yet" — delaying detection
 * until `deadline`, then timing out — never the reverse. A lagging clock
 * cannot make the trigger stamp a value that satisfies `>= requestedAt`
 * before it has actually run.
 */
async function waitForStamp(
  id: string,
  requestedAt: number,
  deadline: number,
): Promise<StampWaitResult> {
  for (;;) {
    const doc = await db.collection('recipes').doc(id).get();
    if (!doc.exists) return { status: 'not-found' };
    const parsed = KitReadSchema.safeParse(doc.data());
    if (
      parsed.success &&
      parsed.data.kitInferredAt !== undefined &&
      parsed.data.kitInferredAt >= requestedAt
    ) {
      return {
        status: 'stamped',
        kit: parsed.data.kit.map((entry) => ({ label: entry.label, equipment: entry.equipment })),
      };
    }
    if (Date.now() >= deadline) return { status: 'timeout' };
    await sleep(POLL_MS);
  }
}

/**
 * Reads the per-environment recipe-generation kill switch this script's
 * inferences ride on, the same one `onRecipeWritten`'s `isRecipeImageGenerationEnabled`
 * reads (PR #1483 review, should-fix 4). Checked ONCE, up front, rather than
 * left to be discovered recipe by recipe: with it off, every targeted recipe
 * would time out and stamp nothing, and a `--write` run would burn the whole
 * list's worth of `STAMP_TIMEOUT_MS` waits for zero writes. Fails OPEN — a
 * missing doc or an unexpected shape both read as enabled — mirroring the
 * trigger's own fail-open default exactly, so this preflight can never refuse a
 * run the trigger itself would have allowed.
 */
async function killSwitchDisabled(): Promise<boolean> {
  const snap = await db.collection('devSettings').doc('singleton').get();
  if (!snap.exists) return false;
  const parsed = DevSettingsSchema.safeParse(snap.data());
  if (!parsed.success) return false;
  return !parsed.data.recipeImageGenerationEnabled;
}

interface Outcome {
  readonly id: string;
  readonly title: string;
  readonly status: 'stamped' | 'timeout' | 'not-found';
  readonly before: RecipeKitSnapshot['kit'];
  /** `null` unless `status === 'stamped'` — nothing fresh was ever read. */
  readonly after: RecipeKitSnapshot['kit'] | null;
  /** `null` unless `status === 'stamped'`. */
  readonly diff: KitDiff | null;
}

function renderReport(
  outcomes: readonly Outcome[],
  items: readonly EquipmentItemDoc[],
  unreadable: readonly string[],
  neverTriggers: readonly NamedRecipe[],
  declinedByGuards: readonly NamedRecipe[],
): string {
  const stampedChanged = outcomes.filter((o) => o.status === 'stamped' && o.diff!.changed).length;
  const timedOut = outcomes.filter((o) => o.status === 'timeout').length;
  const vanished = outcomes.filter((o) => o.status === 'not-found').length;
  const lines: string[] = [
    `# Kit re-run — ${projectId}`,
    '',
    `Started ${new Date(startedAt).toISOString()} (epoch ${startedAt}).`,
    `${outcomes.length} recipe(s) attempted, ${stampedChanged} with a changed kit, ` +
      `${timedOut} timed out, ${vanished} vanished mid-run.`,
    '',
  ];

  // Excluded up front, in the SAME file the spot-check reads — not only on
  // stdout (PR #1483 review, should-fix 5, extended to should-fix 4's
  // full-schema case): a gap here is exactly the gap the narrow-pick comment in
  // `readRecipes` says it exists to avoid.
  if (unreadable.length > 0 || neverTriggers.length > 0 || declinedByGuards.length > 0) {
    lines.push('## Excluded — never targeted');
    lines.push('');
    if (unreadable.length > 0) {
      lines.push(
        `${unreadable.length} document(s) failed validation on even title/kit — nothing was read ` +
          `or written for them: ${unreadable.map((id) => `\`recipes/${id}\``).join(', ')}.`,
      );
      lines.push('');
    }
    if (neverTriggers.length > 0) {
      lines.push(
        `${neverTriggers.length} recipe(s) have a non-empty kit but fail the recipe's FULL schema — ` +
          `the same parse \`onRecipeWritten\`'s handler runs before any branch. The trigger will ` +
          `decline these forever regardless of this script; targeting them would only clear their ` +
          `stamp and burn the wait timeout. Fix their shape, then re-run:`,
      );
      for (const entry of neverTriggers) {
        lines.push(`- ${entry.title} (\`recipes/${entry.id}\`)`);
      }
      lines.push('');
    }
    if (declinedByGuards.length > 0) {
      lines.push(
        `${declinedByGuards.length} recipe(s) have a non-empty kit but fail one of the trigger's ` +
          `own two guards — \`isCookable(kind)\`, or a step count of zero — the same pair ` +
          `\`maybeInferKit\` checks before it calls the model. The trigger will decline these ` +
          `for as long as their shape stands, so they are read for this report but never ` +
          `targeted. A zero step count is missing method text — add steps in place and ` +
          `re-run. A non-cookable kind (\`special\` or \`placeholder\`) is not something an ` +
          `edit can fix: \`kind\` is immutable and no surface in the app changes it once a ` +
          `recipe exists (packages/domain/src/recipe/queries/capabilities.ts), so these stay ` +
          `on this list for as long as their kit does:`,
      );
      for (const entry of declinedByGuards) {
        lines.push(`- ${entry.title} (\`recipes/${entry.id}\`)`);
      }
      lines.push('');
    }
  }

  for (const outcome of outcomes) {
    lines.push(`## ${outcome.title}`);
    lines.push('');
    const marker =
      outcome.status === 'stamped'
        ? ''
        : outcome.status === 'timeout'
          ? ' — **NEVER STAMPED**'
          : ' — **VANISHED MID-RUN**';
    lines.push(`\`recipes/${outcome.id}\`${marker}`);
    lines.push('');

    if (outcome.status === 'not-found') {
      lines.push(
        'The document could not be read after our update — deleted, or a concurrent write left it ' +
          'in a shape that never resolved before the deadline. Cannot confirm whether the kit was ' +
          're-run; nothing here should be treated as the current state.',
      );
      lines.push('');
      continue;
    }
    if (outcome.status === 'timeout') {
      lines.push(
        `No fresh stamp after ${STAMP_TIMEOUT_MS / 1000}s. The line below is the PRE-RUN kit — an ` +
          'inference may still complete later and this file will not reflect it. A resumed run ' +
          '(`--since`) re-targets this recipe.',
      );
      lines.push('');
      lines.push(`  before: ${outcome.before.map((e) => e.label).join(' · ') || '(empty)'}`);
      lines.push('');
      continue;
    }

    const diff = outcome.diff!;
    if (!diff.changed) {
      lines.push('No change — same labels, same links.');
      lines.push('');
      continue;
    }
    for (const change of diff.relinked) {
      lines.push(
        `- **re-linked** "${change.label}": ${describeLink(change.before, items)} → ` +
          `${describeLink(change.after, items)}`,
      );
    }
    for (const entry of diff.removed) {
      lines.push(`- **gone** "${entry.label}" (${describeLink(entry.equipment, items)})`);
    }
    for (const entry of diff.added) {
      lines.push(`- **new** "${entry.label}" (${describeLink(entry.equipment, items)})`);
    }
    lines.push(`- ${diff.unchanged} line(s) unchanged`);
    lines.push('');
    lines.push(`  before: ${outcome.before.map((e) => e.label).join(' · ') || '(empty)'}`);
    lines.push(`  after:  ${outcome.after!.map((e) => e.label).join(' · ') || '(empty)'}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const [{ snapshots, unreadable, neverTriggers }, items] = await Promise.all([
    readRecipes(),
    readEquipmentItems(db, 'rerun-recipe-kits'),
  ]);

  console.log(
    `\n${projectId}: ${snapshots.length} recipe(s) read, ${items.length} equipment record(s)\n`,
  );
  for (const id of unreadable) {
    console.warn(`  WARN  recipes/${id} failed validation on title/kit — skipped, nothing written`);
  }
  for (const entry of neverTriggers) {
    console.warn(
      `  WARN  recipes/${entry.id} ("${entry.title}") has a kit but fails the full recipe schema — ` +
        `the trigger will always decline it; excluded from targeting`,
    );
  }

  const steps = planKitRerun(snapshots, since);
  const allTargets = steps.filter((step) => step.skip === null);
  const targets = limit === null ? allTargets : allTargets.slice(0, limit);

  // Collected here rather than in `readRecipes` because the reason only exists
  // once `planKitRerun` has run — and threaded into the report because stdout
  // scrolls past while the report file is the artifact the spot-check reads
  // (issue #1517). Note the boundary: the report is only written under
  // `--write`, and only from inside the per-target loop below, so a run with no
  // targets at all still leaves this list unwritten — the same limit the two
  // existing exclusion lists already have.
  const declinedByGuards: NamedRecipe[] = [];

  for (const step of steps) {
    if (step.skip === 'empty-kit') continue; // the common, uninteresting case
    if (step.skip === 'not-cookable' || step.skip === 'no-steps') {
      declinedByGuards.push({ id: step.id, title: step.title });
      console.log(`  SKIP  ${step.title} — ${step.skip}, the trigger would decline it`);
    }
    if (step.skip === 'already-rerun') {
      console.log(`  SKIP  ${step.title} — already re-run (--since ${since})`);
    }
  }
  for (const step of targets) {
    console.log(`  ${write ? 'REDO' : 'PLAN'}  ${step.title}  (${step.before.length} line(s))`);
  }

  console.log(
    `\n${steps.filter((s) => s.skip === 'empty-kit').length} recipe(s) have no kit and are left alone; ` +
      `${steps.filter((s) => s.skip === 'not-cookable' || s.skip === 'no-steps').length} the trigger ` +
      `would decline; ${steps.filter((s) => s.skip === 'already-rerun').length} already re-run; ` +
      `${targets.length} to re-run` +
      (limit !== null && allTargets.length > targets.length
        ? ` (--limit ${limit} of ${allTargets.length})`
        : ''),
  );

  // Cheap, and checked before either the dry-run print returns or --write spends
  // an hour timing out (PR #1483 review, should-fix 4): with the switch off,
  // EVERY targeted recipe below would time out and stamp nothing.
  if (await killSwitchDisabled()) {
    console.warn(
      `\nWARN  devSettings/singleton has recipeImageGenerationEnabled=false in ${projectId} — ` +
        `onRecipeWritten's kit branch declines before it ever calls the model, so every recipe ` +
        `targeted above would time out and stamp nothing.`,
    );
    if (write) {
      console.error('Re-enable it before running --write. Nothing was written.\n');
      process.exit(1);
    }
  }

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
    const requestedAt = Date.now();
    await db
      .collection('recipes')
      .doc(step.id)
      .update({ kitInferredAt: FieldValue.delete(), kitRequestedAt: requestedAt });

    const result = await waitForStamp(step.id, requestedAt, requestedAt + STAMP_TIMEOUT_MS);

    let outcome: Outcome;
    if (result.status === 'not-found') {
      console.warn(
        `          WARN  recipes/${step.id} is gone — cannot confirm the kit was re-run`,
      );
      outcome = {
        id: step.id,
        title: step.title,
        status: 'not-found',
        before: step.before,
        after: null,
        diff: null,
      };
    } else if (result.status === 'timeout') {
      console.warn(
        `          WARN  no fresh stamp after ${STAMP_TIMEOUT_MS / 1000}s — inference probably failed ` +
          `(or declined silently — see the kill-switch and schema notes above). A resumed run re-targets it.`,
      );
      outcome = {
        id: step.id,
        title: step.title,
        status: 'timeout',
        before: step.before,
        after: null,
        diff: null,
      };
    } else {
      const diff = diffKitEntries(step.before, result.kit);
      console.log(
        `          ${diff.changed ? 'changed' : 'unchanged'} — ` +
          `${diff.relinked.length} re-linked, ${diff.added.length} new, ${diff.removed.length} gone`,
      );
      outcome = {
        id: step.id,
        title: step.title,
        status: 'stamped',
        before: step.before,
        after: result.kit,
        diff,
      };
    }
    outcomes.push(outcome);

    // Rewritten after EVERY recipe, not only once at the end (PR #1483 review,
    // blocking 3): the record for the recipes already done must survive an
    // interrupt or a throw on a later one, because their "before" cannot be
    // reconstructed once the trigger has overwritten it.
    //
    // Write-then-rename, not a truncate-in-place `writeFile(outPath, ...)`
    // (PR #1485 line 5): this file is the evidence for an irreversible decision,
    // so an ENOSPC or a signal landing mid-write must never leave a shortened
    // `outPath` behind. `rename()` on the same filesystem is atomic; the
    // half-written state can only ever be the `.tmp` file.
    const tmpPath = `${outPath}.tmp`;
    await writeFile(
      tmpPath,
      renderReport(outcomes, items, unreadable, neverTriggers, declinedByGuards),
      'utf8',
    );
    await rename(tmpPath, outPath);

    await sleep(SETTLE_MS);
  }

  const incomplete = outcomes.filter((outcome) => outcome.status !== 'stamped');
  const changed = outcomes.filter((o) => o.status === 'stamped' && o.diff!.changed).length;
  console.log(
    `\n${outcomes.length - incomplete.length} recipe(s) re-run, ${changed} changed. ` +
      `Before/after written to ${outPath}.`,
  );
  if (incomplete.length > 0) {
    console.warn(
      `${incomplete.length} did not complete (timed out or vanished): ` +
        `${incomplete.map((o) => o.title).join(', ')}. Re-run with --since ${startedAt} to retry just those.`,
    );
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
