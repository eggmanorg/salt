// One-off operator script: find the recipe ingredient lines that should be
// pushed back through the parse + canon-match pipeline (issues #855, #857, #1643).
//
// WHY THIS EXISTS — two prompt fixes landed after the library was already full.
// #855 taught the parser that a juice/zest line buys the FRUIT, and #857 that a
// clove line buys the BULB, in cloves. Every recipe imported before those fixes
// still carries the old parse: "juice of 2 limes" flattened to 90 ml of `lime`,
// "3 cloves garlic" flattened to 9 g of `garlic`. Those lines read as matched and
// buy the wrong thing. This script finds them; it does not fix them.
//
// STRICTLY READ-ONLY. It opens no callable, runs no flow, and writes nothing to
// Firestore. That is not squeamishness: the re-run half of this job is NOT
// read-only even in a dry run, because `canonicaliseRecipeIngredients` mints
// canon items and product forms as a side effect of arbitration. Separating the
// two means the work list can be reviewed before anything is created.
//
// WHAT COUNTS AS A CANDIDATE — the union of three nets. The first two (#855/#857)
// each see lines the other structurally cannot:
//
//   • `ingredientMatchIssue` (@salt/domain, issue #858) — the COMPUTED signal,
//     the same one behind the recipe-list pip. It reports `missing_form` for a
//     line that names something other than the canon item it matched, is measured
//     by mass or volume, and whose canon is sold by the count with no form
//     bridging the two. That is precisely the #855/#857 failure. It is silent on
//     a line that names the canon item itself ("2 tsp garlic, grated" — garlic by
//     weight IS garlic, and arbitration correctly refuses to mint a form for it).
//
//   • a SUBJECT keyword list — deliberately over-inclusive recall. It catches
//     what the computed signal cannot: a line already bound to a plausible but
//     wrong form, and a line whose canon is not `unit: 'count'` at all (the
//     count-ness is itself a thing the pipeline gets to decide, so a corpus
//     predating the fixes may simply not have it yet).
//
// The report prints the cross-tab so the two nets can be judged against each
// other rather than taken on faith.
//
//   • the COUNTED-LINE net (#1643) — a line the data now reads as a count that
//     has never been through the parse that records one, plus `missing_count`.
//     Its own module, scripts/lib/countedLineNet.ts, says what it catches and the
//     absent-versus-null distinction it rests on. It answers a different question
//     from the first two, so it is tallied on its own, and `--net counted`
//     restricts the work list to it: the #855/#857 nets are over-inclusive by
//     design and their run is done, so a #1643 re-read should not re-pay for them.
//
// USAGE (from apps/cloud-functions) — no secrets needed, no AI key needed:
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/scan-rematch-candidates.ts
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx scripts/scan-rematch-candidates.ts --json out.json
//   … only the #1643 counted-line net:
//   GOOGLE_CLOUD_PROJECT=s2-prod-e46bd pnpm exec tsx scripts/scan-rematch-candidates.ts --net counted --json out.json
//
// Against the emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-salt …

import { writeFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ingredientMatchIssue, resolveProductForm } from '@salt/domain';
import type { CanonItem, ProductForm } from '@salt/domain';
import { CanonItemSchema, ProductFormSchema, RecipeSchema } from '@salt/domain/schemas';
import { countedLineReason } from './lib/countedLineNet.js';
import type { CountedLineReason } from './lib/countedLineNet.js';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? process.env['GCLOUD_PROJECT'];
if (!projectId) {
  console.error('Set GOOGLE_CLOUD_PROJECT to the target Firebase project id.');
  process.exit(1);
}

const jsonFlagIndex = process.argv.indexOf('--json');
const jsonPath = jsonFlagIndex === -1 ? null : process.argv[jsonFlagIndex + 1];

const netFlagIndex = process.argv.indexOf('--net');
const net = netFlagIndex === -1 ? null : process.argv[netFlagIndex + 1];
if (net !== null && net !== 'counted') {
  console.error(`--net takes one value, "counted" (got "${String(net)}").`);
  process.exit(1);
}

const useEmulator = Boolean(process.env['FIRESTORE_EMULATOR_HOST']);
initializeApp(useEmulator ? { projectId } : { projectId, credential: applicationDefault() });
const db = getFirestore();

// ─── The subject net ─────────────────────────────────────────────────────────
//
// Over-inclusive on purpose: a false positive costs one line of report, a false
// negative costs a wrong shopping list nobody notices. Ordered — the first match
// wins — so a "chicken thigh" line is reported as chicken, not as a part.
const SUBJECTS: readonly { readonly name: string; readonly test: RegExp }[] = [
  {
    name: 'citrus',
    test: /\b(lemons?|limes?|oranges?|grapefruits?|clementines?|satsumas?|mandarins?|tangerines?|yuzu)\b/i,
  },
  { name: 'garlic', test: /\bgarlic\b/i },
  { name: 'chicken', test: /\bchicken|\bpoussins?\b/i },
  // Bare part words: "4 thighs, skin on" in a recipe whose title carries the
  // bird. Separate from `chicken` so the report does not imply the line said so.
  { name: 'bare-part', test: /\b(thighs?|drumsticks?|wingettes?|breasts?|supremes?)\b/i },
];

function subjectOf(text: string): string | null {
  for (const subject of SUBJECTS) if (subject.test.test(text)) return subject.name;
  return null;
}

function describeQuantity(quantity: unknown): string {
  if (quantity === null || typeof quantity !== 'object') return '—';
  const q = quantity as Record<string, unknown>;
  if (q['type'] === 'single') return String(q['value']);
  if (q['type'] === 'range') return `${String(q['min'])}–${String(q['max'])}`;
  if (q['type'] === 'mixed')
    return `${String(q['whole'])} ${String(q['numerator'])}/${String(q['denominator'])}`;
  return '?';
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

// ─── Read ────────────────────────────────────────────────────────────────────
//
// Every collection is parsed through its real schema with `safeParse`, and an
// unparseable document is COUNTED and named rather than silently dropped — the
// skip-invalid contract is right for a live subscription, but a corpus survey
// that quietly ignored a document would be lying about coverage.

const invalid: string[] = [];

async function readAll<T>(
  collection: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
): Promise<T[]> {
  const snapshot = await db.collection(collection).get();
  const out: T[] = [];
  for (const doc of snapshot.docs) {
    const parsed = schema.safeParse({ id: doc.id, ...doc.data() });
    if (parsed.success) out.push(parsed.data as T);
    else invalid.push(`${collection}/${doc.id}`);
  }
  return out;
}

const [recipes, canonItems, forms] = await Promise.all([
  readAll<ReturnType<typeof RecipeSchema.parse>>('recipes', RecipeSchema),
  readAll<CanonItem>('canonItems', CanonItemSchema),
  readAll<ProductForm>('productForms', ProductFormSchema),
]);

const canonById = new Map(canonItems.map((c) => [c.id, c]));

// ─── Classify ────────────────────────────────────────────────────────────────

interface Candidate {
  readonly recipeId: string;
  readonly recipeTitle: string;
  readonly ingredientId: string;
  readonly rawText: string;
  readonly item: string | null;
  readonly quantity: string;
  readonly unit: string | null;
  readonly matchState: string;
  readonly canonId: string | null;
  readonly canonName: string;
  readonly canonUnit: string;
  readonly formLabel: string | null;
  readonly subject: string | null;
  readonly issue: string | null;
  readonly counted: CountedLineReason | null;
  /** Rendered like `quantity`; `absent` is a line never parsed since #1643. */
  readonly statedCount: string;
}

const candidates: Candidate[] = [];
let lineCount = 0;

for (const recipe of recipes) {
  for (const group of recipe.ingredients) {
    for (const ing of group.items) {
      lineCount += 1;
      const subject = subjectOf(`${ing.rawText} ${ing.parsed?.item ?? ''}`);
      const issue = ingredientMatchIssue(ing, canonById, forms);
      const counted = countedLineReason(ing, canonById, forms);
      if (
        net === 'counted'
          ? counted === null
          : subject === null && issue === null && counted === null
      )
        continue;

      const canon = ing.canonId === null ? undefined : canonById.get(ing.canonId);
      // The same parent guard every other product-form read applies: a form
      // resolving to some OTHER canon is not this line's bridge.
      const form =
        ing.parsed === null ? null : resolveProductForm(ing.parsed.item, forms, canonItems);
      const bridging = form !== null && form.parentCanonId === ing.canonId ? form : null;

      candidates.push({
        recipeId: recipe.id,
        recipeTitle: recipe.title,
        ingredientId: ing.id,
        rawText: ing.rawText,
        item: ing.parsed?.item ?? null,
        quantity: describeQuantity(ing.parsed?.quantity ?? null),
        unit: ing.parsed?.unit ?? null,
        matchState: ing.matchState,
        canonId: ing.canonId,
        canonName: ing.canonId === null ? '—' : (canon?.name ?? '<DANGLING>'),
        canonUnit: canon?.unit ?? '—',
        formLabel: bridging?.label ?? null,
        subject,
        issue,
        counted,
        statedCount:
          ing.parsed?.statedCount === undefined
            ? 'absent'
            : describeQuantity(ing.parsed.statedCount),
      });
    }
  }
}

// ─── The canon-unit gap ──────────────────────────────────────────────────────
//
// `unit` is written onto a canon item by AI arbitration at creation time
// (`matchOrCreate`), so any item that predates the field — or that was reached by
// a plain match rather than an arbitration — simply has none. That matters far
// beyond display: `ingredientMatchIssue` returns `missing_form` only when the
// matched canon is `unit: 'count'`, so a count-sold item with no unit is INVISIBLE
// to the pip however wrong the line above it is.
//
// There is NO deterministic way to fill it. Being the PARENT of a product form
// looks like it should imply `count` — a form's yield reads as "how much of
// `formUnit` ONE parent produces" — but staging disproves it: `Beetroot` (brine)
// and `Mature Cheddar` (slices) are both form parents legitimately sold by mass.
// So every item here is a judgement about how a shop sells the thing, and the
// form-parent split below is reported only because those two are the items whose
// absent unit breaks a form that already exists.
const formParentIds = new Set(forms.map((f) => f.parentCanonId));
const referenceCount = new Map<string, number>();
for (const recipe of recipes)
  for (const group of recipe.ingredients)
    for (const ing of group.items)
      if (ing.canonId !== null)
        referenceCount.set(ing.canonId, (referenceCount.get(ing.canonId) ?? 0) + 1);

const missingUnit = canonItems.filter((c) => c.unit === undefined);
const derivable = missingUnit.filter((c) => formParentIds.has(c.id));
const judgement = missingUnit
  .filter((c) => !formParentIds.has(c.id) && (referenceCount.get(c.id) ?? 0) > 0)
  .sort((a, b) => (referenceCount.get(b.id) ?? 0) - (referenceCount.get(a.id) ?? 0));
const unreferenced = missingUnit.length - derivable.length - judgement.length;

// ─── Report ──────────────────────────────────────────────────────────────────

const countedNet = candidates.filter((c) => c.counted !== null);
const bySubjectOnly = candidates.filter((c) => c.subject !== null && c.issue === null);
const byIssueOnly = candidates.filter((c) => c.subject === null && c.issue !== null);
const byBoth = candidates.filter((c) => c.subject !== null && c.issue !== null);

console.log(`\nproject            ${projectId}`);
console.log(`recipes            ${recipes.length}`);
console.log(`canon items        ${canonItems.length}`);
console.log(`product forms      ${forms.length}`);
console.log(`ingredient lines   ${lineCount}`);
if (invalid.length > 0) {
  console.log(`UNPARSEABLE DOCS   ${invalid.length}  ${invalid.join(', ')}`);
}

console.log(`\n── canon unit gap ${'─'.repeat(55)}`);
console.log(
  `canon items with no unit   ${String(missingUnit.length).padStart(4)} of ${canonItems.length}`,
);
console.log(
  `  derivable (form parent)  ${String(derivable.length).padStart(4)}   ${derivable.map((c) => c.name).join(', ') || '—'}`,
);
console.log(`  judgement, referenced    ${String(judgement.length).padStart(4)}`);
console.log(`  unreferenced, ignorable  ${String(unreferenced).padStart(4)}`);
for (const c of judgement) {
  console.log(`      ${String(referenceCount.get(c.id) ?? 0).padStart(2)}×  ${c.name}`);
}

console.log(`\n── counted-line net (#1643) ${'─'.repeat(46)}`);
console.log(
  `unread                 ${String(countedNet.filter((c) => c.counted === 'unread').length).padStart(4)}   (read as a count, never parsed for one)`,
);
console.log(
  `missing_count          ${String(countedNet.filter((c) => c.counted === 'missing_count').length).padStart(4)}   (counted form, grams only, already re-read)`,
);

console.log(`\n── work list${net === null ? '' : ` (--net ${net})`} ${'─'.repeat(60)}`);
console.log(
  `subject keyword only   ${String(bySubjectOnly.length).padStart(4)}   (computed signal is silent)`,
);
console.log(
  `computed issue only    ${String(byIssueOnly.length).padStart(4)}   (keyword net missed these)`,
);
console.log(`both                   ${String(byBoth.length).padStart(4)}`);
console.log(
  `UNION                  ${String(candidates.length).padStart(4)}   lines across ${new Set(candidates.map((c) => c.recipeId)).size} recipes`,
);

const tally = new Map<string, number>();
for (const c of candidates) {
  const key = `${c.subject ?? '(no keyword)'} × ${c.issue ?? 'no computed issue'}${c.counted === null ? '' : ` · counted ${c.counted}`}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
console.log(`\n── subject × issue ${'─'.repeat(54)}`);
for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${key}`);
}

console.log(`\n── lines ${'─'.repeat(64)}`);
console.log(
  `${'subject'.padEnd(10)}${'issue'.padEnd(14)}${'counted'.padEnd(14)}${'raw text'.padEnd(42)}${'parsed'.padEnd(30)}${'×count'.padEnd(8)}${'→ canon'.padEnd(24)}form`,
);
const sorted = [...candidates].sort(
  (a, b) => a.recipeTitle.localeCompare(b.recipeTitle) || a.rawText.localeCompare(b.rawText),
);
let currentRecipe = '';
for (const c of sorted) {
  if (c.recipeTitle !== currentRecipe) {
    currentRecipe = c.recipeTitle;
    console.log(`\n  ${currentRecipe}`);
  }
  const parsed = `${c.quantity} ${c.unit ?? '·'} ${c.item ?? '·'}`;
  const canon = `${c.canonName} (${c.canonUnit})`;
  console.log(
    `${(c.subject ?? '·').padEnd(10)}${(c.issue ?? '·').padEnd(14)}${(c.counted ?? '·').padEnd(14)}${truncate(c.rawText, 42)}${truncate(parsed, 30)}${truncate(c.statedCount, 8)}${truncate(canon, 24)}${c.formLabel ?? '·'}`,
  );
}

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({ projectId, lineCount, candidates }, null, 2)}\n`);
  console.log(`\nwork list written to ${jsonPath}`);
}

console.log('\nNothing was written. This script only reads.\n');
process.exit(0);
