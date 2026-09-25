// One-off operator script: push stale ingredient lines back through the parse +
// canon-match pipeline (issues #855, #857, #861).
//
// The ACTUATOR half of a two-script pipeline. Selection lives in
// scripts/scan-rematch-candidates.ts, which writes a work list with `--json`;
// this reads that file and re-runs the lines in it. Kept apart on purpose: the
// scan is free and read-only, this one costs money and mutates, and a human
// reads the work list in between. It also means "what did we decide to fix" is a
// reviewable artefact rather than a predicate buried in the thing doing the
// fixing.
//
//   pnpm exec tsx scripts/scan-rematch-candidates.ts --json /tmp/work.json
//   … read /tmp/work.json …
//   pnpm exec tsx --env-file=.secret.local scripts/rematch-ingredients.ts --from /tmp/work.json
//
// ─── The two modes, and why the default one is not just "--apply minus writes" ─
//
// DEFAULT (parse only) is genuinely read-only: it runs `parseRecipeIngredients`
// and prints the stored parse beside the parse today's prompt produces. Nothing
// is written anywhere. This is the mode that answers "did the prompt fix change
// what these lines mean", which is the question worth asking before spending
// anything.
//
// `--apply` runs the WHOLE pipeline and writes. It cannot be rehearsed, because
// `canonicaliseRecipeIngredients` mints canon items and product forms as a side
// effect of arbitration — a "dry run" of that half would still create documents.
// So there is deliberately no third mode pretending otherwise: either you are
// parsing, or you are changing the database.
//
// ─── Shape of the work ───────────────────────────────────────────────────────
//
// Per recipe: every affected line is parsed CONCURRENTLY (they are independent
// one-line prompts), then all of that recipe's lines go through canonicalise in a
// SINGLE call. That matters — the canonicalise flow lists the whole canon
// collection twice per invocation, so one call per line would read canon 2N times
// for no benefit. Recipes are processed one at a time; the whole job is ~34
// recipes × 2 AI round-trips, a few minutes.
//
// ─── Safety ──────────────────────────────────────────────────────────────────
//
// • The recipe is RE-READ immediately before writing and lines are re-matched by
//   ingredient id AND rawText. A line edited since the scan is skipped, not
//   overwritten — the same guard the per-row rematch in RecipeViewPage applies.
// • The write is a PARTIAL update of `ingredients` alone. Recipes are LWW per
//   whole document and `onRecipeWritten` writes back `image`/`imageBrief`, so a
//   full-document write from here could clobber a concurrent trigger write.
// • `updatedAt` is deliberately NOT moved: re-matching is not an edit a human
//   made, and moving it would reorder the recipe list and make the client's
//   stale-echo guard treat every recipe as freshly edited.
// • `onRecipeWritten` fires per updated recipe and does nothing: an ingredients
//   change is not a create, does not clear `image`, and does not bump
//   `imageRequestedAt`, so `imageNeedsGeneration` returns false. No hero is
//   regenerated.
// • A per-line failure is logged and that line left exactly as it was; it never
//   aborts the run.
//
// NOT IDEMPOTENT. Every run costs AI calls and the model may answer differently
// (temperature is 0, but the canon and form catalogues it reads will have moved).
// Re-running is safe but not free, and is not guaranteed to be a no-op.
//
// USAGE (from apps/cloud-functions) — needs a real Gemini key, hence --env-file:
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx --env-file=.secret.local \
//     scripts/rematch-ingredients.ts --from /tmp/work.json
//   … then, to actually change things:
//   GOOGLE_CLOUD_PROJECT=s2-stage-ccb22 pnpm exec tsx --env-file=.secret.local \
//     scripts/rematch-ingredients.ts --from /tmp/work.json --apply
//   … and to try a single recipe first:
//   … --from /tmp/work.json --apply --limit 1

import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { RecipeSchema } from '@salt/domain/schemas';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? process.env['GCLOUD_PROJECT'];
if (!projectId) {
  console.error('Set GOOGLE_CLOUD_PROJECT to the target Firebase project id.');
  process.exit(1);
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const fromPath = flagValue('--from');
if (fromPath === undefined) {
  console.error('Pass --from <work-list.json> (produced by scan-rematch-candidates.ts --json).');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const limitRaw = flagValue('--limit');
const limit = limitRaw === undefined ? Infinity : Number(limitRaw);

const useEmulator = Boolean(process.env['FIRESTORE_EMULATOR_HOST']);
initializeApp(useEmulator ? { projectId } : { projectId, credential: applicationDefault() });
const db = getFirestore();

// Imported AFTER initializeApp: the flows reach Firestore through `getFirestore()`
// at call time, but keeping the order explicit means nobody has to check that
// again the next time a flow grows a module-level side effect.
const { parseRecipeIngredientsFlow } = await import('../src/flows/parseRecipeIngredients.js');
const { canonicaliseRecipeIngredientsFlow } =
  await import('../src/flows/canonicaliseRecipeIngredients.js');

interface WorkItem {
  readonly recipeId: string;
  readonly recipeTitle: string;
  readonly ingredientId: string;
  readonly rawText: string;
  readonly item: string | null;
  readonly quantity: string;
  readonly unit: string | null;
  readonly canonName: string;
}

const workList = JSON.parse(readFileSync(fromPath, 'utf8')) as {
  projectId: string;
  candidates: WorkItem[];
};

if (workList.projectId !== projectId) {
  console.error(
    `Work list was scanned against ${workList.projectId} but GOOGLE_CLOUD_PROJECT is ${projectId}.`,
  );
  process.exit(1);
}

// Group by recipe so each recipe is one canonicalise call and one write.
const byRecipe = new Map<string, WorkItem[]>();
for (const c of workList.candidates) {
  const existing = byRecipe.get(c.recipeId);
  if (existing) existing.push(c);
  else byRecipe.set(c.recipeId, [c]);
}

const recipeIds = [...byRecipe.keys()].slice(0, limit);

console.log(`\nproject     ${projectId}`);
console.log(`work list   ${workList.candidates.length} lines across ${byRecipe.size} recipes`);
console.log(
  `this run    ${recipeIds.length} recipes${limit === Infinity ? '' : ` (--limit ${limit})`}`,
);
console.log(
  `mode        ${apply ? 'APPLY — writes recipes, mints canon and forms' : 'parse only — writes nothing'}\n`,
);

let changed = 0;
let unchanged = 0;
let failed = 0;
let skipped = 0;
let keptForNullQuantity = 0;
let written = 0;

interface ParsedLine {
  readonly work: WorkItem;
  readonly parsed: Record<string, unknown>;
}

for (const recipeId of recipeIds) {
  const lines = byRecipe.get(recipeId) ?? [];
  console.log(`── ${lines[0]?.recipeTitle ?? recipeId}`);

  // Parse every affected line of this recipe at once — independent one-line
  // prompts, so there is nothing to serialise.
  const settled = await Promise.all(
    lines.map(async (work): Promise<ParsedLine | null> => {
      try {
        const groups = await parseRecipeIngredientsFlow({ rawText: work.rawText });
        const parsed = groups[0]?.items[0]?.parsed;
        if (!parsed) {
          console.log(`   FAILED (no parse)  ${work.rawText}`);
          return null;
        }
        return { work, parsed: parsed as unknown as Record<string, unknown> };
      } catch (err) {
        console.log(`   FAILED ${work.rawText}\n           ${String(err)}`);
        return null;
      }
    }),
  );

  const parsedLines = settled.filter((s): s is ParsedLine => s !== null);
  failed += lines.length - parsedLines.length;

  for (const { work, parsed } of parsedLines) {
    const before = `${work.quantity} ${work.unit ?? '·'} ${work.item ?? '·'}`;
    const after = `${describeQuantity(parsed['quantity'])} ${(parsed['unit'] as string) ?? '·'} ${(parsed['item'] as string) ?? '·'}`;
    if (before === after) {
      unchanged += 1;
      console.log(`   same       ${work.rawText.slice(0, 46).padEnd(46)} ${after}`);
    } else {
      changed += 1;
      console.log(`   CHANGED    ${work.rawText.slice(0, 46).padEnd(46)} ${before}  →  ${after}`);
    }
  }

  if (!apply || parsedLines.length === 0) continue;

  // One canonicalise call for the whole recipe. Results come back in input order.
  let results: unknown[];
  try {
    // No `recipeId`, so the content arm: the bare array, and no recipe write.
    const answer = await canonicaliseRecipeIngredientsFlow({
      items: parsedLines.map(({ work, parsed }) => ({
        rawName: String(parsed['item'] ?? work.rawText),
        rawText: work.rawText,
      })),
    });
    results = Array.isArray(answer) ? answer : answer.results;
  } catch (err) {
    console.log(`   CANONICALISE FAILED — recipe left untouched\n     ${String(err)}`);
    failed += parsedLines.length;
    continue;
  }

  // Re-read immediately before writing: the work list may be minutes old, and a
  // line edited since the scan must be left alone rather than overwritten.
  const snapshot = await db.collection('recipes').doc(recipeId).get();
  const current = RecipeSchema.safeParse({ id: snapshot.id, ...snapshot.data() });
  if (!current.success) {
    console.log('   SKIPPED — recipe no longer parses');
    skipped += parsedLines.length;
    continue;
  }

  const updateById = new Map<string, { parsed: unknown; canonId: string | null; ok: boolean }>();
  parsedLines.forEach(({ work, parsed }, i) => {
    const result = results[i] as
      { kind: 'ok'; value: { item: { id: string } } } | { kind: 'err' } | undefined;
    if (result === undefined) return;
    // A BACKFILL MUST NOT DESTROY DATA. The parse is an AI call, and an AI call
    // is not reproducible even at temperature 0 — the same line yields "5 g lemon
    // zest" on one run and no quantity at all on the next. Improving 30 lines is
    // no justification for silently emptying one: a line with no amount puts
    // nothing on the shopping list, and the original number is gone.
    //
    // So the trade is refused wherever it arises. A line that HAD an amount keeps
    // the one it has unless the new parse also has one; everything else about the
    // re-parse (the item name, the unit, the canon match — the whole point of the
    // pass) is discarded with it, because a quantity and its unit are one fact and
    // splicing half of each together would invent a reading neither parse gave.
    // Re-running later is free and may well come back with a number.
    // The work list stores a rendered quantity, and `describeQuantity` renders a
    // null one as an em dash — so that string, not null, is what "no amount" looks
    // like here. Nine of prod's 79 lines are already in that state.
    const hadQuantity = work.quantity !== '—' && work.quantity.trim() !== '';
    const hasQuantity = (parsed as Record<string, unknown>)['quantity'] != null;
    if (hadQuantity && !hasQuantity) {
      console.log(
        `   KEPT       ${work.rawText.slice(0, 46).padEnd(46)} new parse had no quantity`,
      );
      keptForNullQuantity += 1;
      return;
    }
    updateById.set(work.ingredientId, {
      parsed,
      canonId: result.kind === 'ok' ? result.value.item.id : null,
      ok: result.kind === 'ok',
    });
  });

  let touched = 0;
  const ingredients = current.data.ingredients.map((group) => ({
    ...group,
    items: group.items.map((ing) => {
      const update = updateById.get(ing.id);
      if (update === undefined) return ing;
      const work = lines.find((l) => l.ingredientId === ing.id);
      if (work === undefined || ing.rawText !== work.rawText) {
        skipped += 1;
        return ing; // edited since the scan — leave it exactly as it is
      }
      touched += 1;
      return {
        ...ing,
        parsed: update.parsed,
        canonId: update.canonId,
        matchState: update.ok ? ('matched' as const) : ('failed' as const),
      };
    }),
  }));

  if (touched === 0) {
    console.log('   nothing to write');
    continue;
  }

  try {
    await db.collection('recipes').doc(recipeId).update({ ingredients });
    written += 1;
    console.log(`   written    ${touched} line(s)`);
  } catch (err) {
    console.log(`   WRITE FAILED\n     ${String(err)}`);
    failed += touched;
  }
}

function describeQuantity(quantity: unknown): string {
  if (quantity === null || quantity === undefined || typeof quantity !== 'object') return '—';
  const q = quantity as Record<string, unknown>;
  if (q['type'] === 'single') return String(q['value']);
  if (q['type'] === 'range') return `${String(q['min'])}–${String(q['max'])}`;
  if (q['type'] === 'mixed')
    return `${String(q['whole'])} ${String(q['numerator'])}/${String(q['denominator'])}`;
  return '?';
}

console.log(
  `\nparse changed ${changed}   unchanged ${unchanged}   failed ${failed}   skipped ${skipped}` +
    `   kept (no new quantity) ${keptForNullQuantity}`,
);
console.log(
  apply
    ? `recipes written ${written}\n`
    : '\nParse only. Nothing written. Re-run with --apply to canon-match and save.\n',
);
process.exit(0);
