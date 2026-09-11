// How a QUANTITY reads, in one place (issue #933) — the sibling of
// `durationDisplay.ts`, and it exists for the same reason: three surfaces had
// their own copy of a five-character formatter, and one of them had quietly
// drifted.
//
// NOTHING HERE DERIVES A QUANTITY. That is not a style preference, it is the
// invariant the retired copies broke. The one arithmetic expression below,
// `formatDoughAmount`'s total, is DELEGATED to the domain's `doughAmountGrams`
// rather than written here, which is the same rule stated precisely: a screen may
// print a figure, and the expression that produces it lives in exactly one place. `routes/batches/batchDisplay.ts` and
// `RecipeBakeBatchSheet.svelte` both said `${grams} g`; `FormulaPage.svelte` said
// `${roundGrams(grams)} g`. So the same float rendered `1234.56 g` on two screens
// and `1235 g` on a third, and nothing failed.
//
// The fix is NOT an option flag — a `{ round }` parameter on a formatter this
// small is the same fork with a longer signature. Rounding is the domain's job
// and it has exactly one authority for it (`roundGrams`,
// `packages/domain/src/formula/rounding.ts`), so the screen that wants a rounded
// figure rounds at the CALL, where it can be seen:
//
//   formatGrams(roundGrams(asWrittenDoughGrams))
//
// which is also the shape every other gram on those screens already had — the
// batch totals arrive pre-rounded from the freeze, which is why their copies
// never needed it.

// `tests/sharedHelperGuard.test.ts` is what keeps this the only one: it walks the
// whole of `src` and fails on a second declaration of this name.

import { doughAmountGrams, roundGrams } from '@salt/domain';

/** A gram figure, already rounded by whoever decided what the number is. */
export function formatGrams(grams: number): string {
  return `${grams} g`;
}

/**
 * A dough weight in the unit a baker would say it: grams under a kilo, kilos over.
 *
 * "1.8 kg" rather than "1800 g" — the only unit choice in this module, and it is a
 * choice of WORDS, not a conversion anyone computes with. At most one decimal, and
 * a trailing `.0` is dropped, so 2000 g reads "2 kg".
 */
export function formatDoughWeight(grams: number): string {
  if (grams < 1000) return formatGrams(grams);
  const kilos = (grams / 1000).toFixed(1);
  return `${kilos.endsWith('.0') ? kilos.slice(0, -2) : kilos} kg`;
}

/**
 * What a declared dough amount reads as, on all four surfaces that say it: the
 * bake sheet, the formula screen, a batch's page and the list of runs.
 *
 * "2 × 900 g — 1.8 kg of dough", or just "1.4 kg of dough" when there is one of
 * them, because "1 × 1400 g — 1.4 kg" says the same thing twice.
 *
 * The total comes from the domain's `doughAmountGrams`, which is the same single
 * expression `solveFormula` resolved a target yield through and `freezeBatch` froze
 * as `usableGrams`. That is what stops this line disagreeing with the figures
 * beside it — see this module's header on why a second copy of an expression is
 * the failure mode, not the duplication itself.
 *
 * BOTH figures are rounded here, and the per-unit one only became able to need it
 * with issue #1325: "five rolls out of this dough" divides a dough total by a
 * count, and 867 ÷ 7 is 123.85714285714286. An amount is a stored number that other
 * things compute with, so it stays exact; a SENTENCE is read, so it rounds — at the
 * call, through the one authority, exactly as this module's header prescribes. The
 * two figures can then differ by the per-row rounding `rounding.ts` already declines
 * to reconcile (7 × 124 g is 868, not 867), and the total is the true one.
 */
export function formatDoughAmount(amount: { count: number; unitDoughGrams: number }): string {
  const total = formatDoughWeight(roundGrams(doughAmountGrams(amount)));
  if (amount.count === 1) return `${total} of dough`;
  return `${amount.count} × ${formatGrams(roundGrams(amount.unitDoughGrams))} — ${total} of dough`;
}
