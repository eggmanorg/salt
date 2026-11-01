import type { PackWeight } from '../entities/FreezerItem.js';

/** What a shopping row needs: its amount and the unit it was written in. */
export interface PackNeed {
  readonly amount?: number | undefined;
  readonly unit?: string | undefined;
}

// Each unit a need can be compared in, as its factor to g, ml or a count of
// pieces (issue #1712). A row with no unit is a count ("6" sausages), and so is
// the `count` sentinel product-form rows are written with. Anything else — `lb`,
// `cup`, a container word — has no entry and so no conversion.
interface Measure {
  readonly unit: PackWeight['unit'];
  readonly factor: number;
}

const MEASURES: ReadonlyMap<string, Measure> = new Map(
  (
    [
      ['count', 1, ['', 'count']],
      ['g', 1, ['g', 'gram', 'grams', 'gramme', 'grammes']],
      ['g', 1000, ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms']],
      ['ml', 1, ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters']],
      ['ml', 10, ['cl']],
      ['ml', 100, ['dl']],
      ['ml', 1000, ['l', 'litre', 'litres', 'liter', 'liters']],
    ] as const
  ).flatMap(([unit, factor, words]) => words.map((w): [string, Measure] => [w, { unit, factor }])),
);

// Float noise allowed over a whole pack before rounding up: 1.1 dl converts to
// 110.00000000000001 ml, which must be 11 packs of 10 ml, not 12.
const TOLERANCE = 1e-9;

/**
 * How many packs to start "Use from the freezer" at (issue #1712): the row's
 * need over one pack's weight, rounded UP — fewer would leave the meal short —
 * and never more than the bag holds (`held`), never fewer than one.
 *
 * It starts at 1 whenever the need cannot be compared with the pack: no amount,
 * a unit that is not metric weight, volume or a count, two different kinds —
 * grams against millilitres (there is no density), or a count against either —
 * or a bag with no usable size. Units are matched trimmed and case-insensitively,
 * since a hand-added row keeps the casing it was typed in.
 */
export function packsForNeed(need: PackNeed, packWeight: PackWeight | null, held: number): number {
  const measure = MEASURES.get(need.unit?.trim().toLowerCase() ?? '');
  if (
    measure === undefined ||
    need.amount === undefined ||
    !Number.isFinite(need.amount) ||
    need.amount <= 0 ||
    packWeight === null ||
    !(packWeight.amount > 0) ||
    measure.unit !== packWeight.unit
  ) {
    return 1;
  }
  const packs = Math.ceil((need.amount * measure.factor) / packWeight.amount - TOLERANCE);
  return Math.max(1, Math.min(held, packs));
}
