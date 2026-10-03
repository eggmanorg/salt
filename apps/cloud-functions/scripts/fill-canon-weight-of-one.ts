// One-off operator script: give every counted canon item a weight of one
// (issue #1643, Phase 4).
//
// WHY THIS EXISTS — `CanonItem.gramsPerItem` is how the shopping list folds a
// by-weight contribution into a counted row ("Red onion ×6 (900g)") and states
// its weight. Arbitration sets it on each counted item it creates; the counted
// items that predate the field have none, and their rows keep a separate grams
// subtotal until they do. Prod held 43 counted items on 2026-10-02.
//
// WHY ASK THE MODEL, when set-canon-units.ts deliberately did not — that script
// filled a field arbitration had FAILED to set, so asking again repeated the
// failure. This one is a field arbitration did not yet HAVE, and the question is
// exactly the one arbitration now asks a new item (`GRAMS_PER_ITEM_RULE`, shared
// with its Rule 5 so the two cannot define a weight of one differently). Every
// answer is still read by a person before it lands — see the two modes.
//
// ─── Two modes, and the reviewed file between them ──────────────────────────
//
// DEFAULT asks the model ONCE about every target and prints the proposals. With
// `--json <file>` it also writes them. Nothing reaches Firestore.
//
// `--apply --from <file>` writes the REVIEWED file's values and asks no model:
// what lands is exactly what was read, not a second, unreviewed answer. Canon is
// re-read first, and an item that has since been deleted, stopped being counted
// or gained a weight of one (admin, arbitration) is skipped — the decision lives
// in scripts/lib/canonWeightOfOne.ts, where its test can reach it.
//
// Writing to a project whose id names prod additionally needs
// `--confirm production`. Checked BEFORE any write and never after (#1067): the
// gate is the last thing between the plan and the loop, and nothing exits early
// between it and the report.
//
// The write is a PARTIAL update of `gramsPerItem` alone and does not move
// `updatedAt`, for the reasons set-canon-units.ts gives: canon is LWW per whole
// document and `onCanonItemWritten` writes back to it. That trigger fires once
// per item and no-ops — the icon branch keys off `thumbnail`/`iconRequestedAt`
// and the embedding branch returns because `canonEmbeddings/{id}` exists.
//
// NEVER OVERWRITES. Re-running after a successful apply finds no targets.
//
// USAGE (from apps/cloud-functions) — the dry run needs a Gemini key, the apply
// does not:
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd pnpm exec tsx --env-file=.secret.local \
//     scripts/fill-canon-weight-of-one.ts --json /tmp/weights.json
//   … read /tmp/weights.json, edit any value you disagree with …
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd pnpm exec tsx \
//     scripts/fill-canon-weight-of-one.ts --apply --from /tmp/weights.json --confirm production

import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { CanonItemSchema } from '@salt/domain/schemas';
import { planWeightOfOneWrites, proposalsFor, weightOfOneTargets } from './lib/canonWeightOfOne.js';
import type { WeightOfOneProposal } from './lib/canonWeightOfOne.js';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? process.env['GCLOUD_PROJECT'];
if (!projectId) {
  console.error('Set GOOGLE_CLOUD_PROJECT to the target Firebase project id.');
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const apply = process.argv.includes('--apply');
const fromPath = flagValue('--from');
const jsonPath = flagValue('--json');
const confirm = flagValue('--confirm');

if (apply && fromPath === undefined) {
  console.error(
    '--apply writes a reviewed plan: pass --from <file> (written by a dry run with --json).',
  );
  process.exit(1);
}

const useEmulator = Boolean(process.env['FIRESTORE_EMULATOR_HOST']);
initializeApp(useEmulator ? { projectId } : { projectId, credential: applicationDefault() });
const db = getFirestore();

const snapshot = await db.collection('canonItems').get();
const canon: ReturnType<typeof CanonItemSchema.parse>[] = [];
let unparseable = 0;
for (const doc of snapshot.docs) {
  const parsed = CanonItemSchema.safeParse({ id: doc.id, ...doc.data() });
  if (parsed.success) canon.push(parsed.data);
  else unparseable += 1;
}

console.log(`\nproject          ${projectId}`);
console.log(
  `canon items      ${canon.length}${unparseable > 0 ? ` (${unparseable} unparseable)` : ''}`,
);
console.log(`counted          ${canon.filter((c) => c.unit === 'count').length}`);

// ─── Dry run: ask, print, optionally write the plan file ────────────────────

if (!apply) {
  const targets = weightOfOneTargets(canon);
  console.log(`no weight of one ${targets.length}\n`);
  if (targets.length === 0) {
    console.log('Nothing to ask. Nothing written.\n');
    process.exit(0);
  }

  // Imported AFTER initializeApp, as rematch-ingredients.ts does: `resolveModel`
  // reaches Firestore through `getFirestore()`.
  const { z } = await import('genkit');
  const { googleAI } = await import('@genkit-ai/google-genai');
  const { ai } = await import('../src/genkit.js');
  const { resolveModel } = await import('../src/ai/resolveModel.js');
  const { withAiTimeout, AI_TEXT_FLOW_TIMEOUT } = await import('../src/adapters/withAiTimeout.js');
  const { GRAMS_PER_ITEM_RULE } = await import('../src/flows/arbitrateCanon.js');

  const AnswerSchema = z.object({
    items: z.array(z.object({ id: z.string(), gramsPerItem: z.number().nullable() })),
  });
  const prompt = [
    `Each grocery item below is bought by the count in a UK household.`,
    `For each one, give gramsPerItem: ${GRAMS_PER_ITEM_RULE}.`,
    `If an item has no sensible weight for one of it, give null. Answer for every id, using the id exactly as given.`,
    ``,
    ...targets.map((t) => `${t.id}\t${t.name}`),
  ].join('\n');

  const model = await resolveModel('arbitrateCanon');
  // One call for the whole list: ~43 short names, and one answer the operator
  // reads as a table. The text-flow budget, not the 20 s house default — this is
  // a list, not one item.
  const result = await withAiTimeout(
    'fillCanonWeightOfOne',
    () =>
      ai.generate({
        model: googleAI.model(model),
        prompt,
        output: { schema: AnswerSchema },
        config: { temperature: 0 },
      }),
    AI_TEXT_FLOW_TIMEOUT,
  );
  const proposals = proposalsFor(targets, result.output?.items ?? []);

  for (const p of proposals) {
    console.log(
      `  ${p.name.padEnd(34)} ${p.gramsPerItem === null ? '— (no answer)' : `${p.gramsPerItem} g`}`,
    );
  }
  const unanswered = proposals.filter((p) => p.gramsPerItem === null).length;
  console.log(`\nproposed ${proposals.length - unanswered}   no answer ${unanswered}`);

  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify({ projectId, proposals }, null, 2)}\n`);
    console.log(`plan written to ${jsonPath}`);
  }
  console.log(
    '\nDry run. Nothing written to Firestore. Review the plan, then --apply --from it.\n',
  );
  process.exit(0);
}

// ─── Apply: write the reviewed plan ─────────────────────────────────────────

const plan = JSON.parse(readFileSync(fromPath!, 'utf8')) as {
  projectId: string;
  proposals: WeightOfOneProposal[];
};
if (plan.projectId !== projectId) {
  console.error(
    `Plan was made against ${plan.projectId} but GOOGLE_CLOUD_PROJECT is ${projectId}.`,
  );
  process.exit(1);
}

const { write, skip } = planWeightOfOneWrites(canon, plan.proposals);
console.log(`plan             ${plan.proposals.length} proposals`);
console.log(`to write         ${write.length}`);
console.log(`skipped          ${skip.length}\n`);
for (const s of skip) console.log(`  skip  ${s.name.padEnd(34)} ${s.reason}`);
for (const w of write) console.log(`  set   ${w.name.padEnd(34)} ${w.gramsPerItem} g`);

if (/prod/i.test(projectId) && confirm !== 'production') {
  console.error(
    `\n✖ Writing to PRODUCTION needs --confirm production${confirm === undefined ? '' : ` (got "${confirm}")`}. Nothing written.\n`,
  );
  process.exit(1);
}

let written = 0;
for (const { id, name, gramsPerItem } of write) {
  try {
    await db.collection('canonItems').doc(id).update({ gramsPerItem });
    written += 1;
  } catch (err) {
    console.error(`FAILED ${name} (${id})`, err);
  }
}
console.log(`\nSet ${written} of ${write.length}.\n`);
process.exit(written === write.length ? 0 : 1);
