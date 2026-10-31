import type { PackWeight } from '../entities/FreezerItem.js';

/** What a shopping row needs: its amount and the unit it was written in. */
export interface PackNeed {
  readonly amount?: number | undefined;
  readonly unit?: string | undefined;
}

// Metric units only (issue #1712), each as its factor to g or ml. Anything else —
// a count, `lb`, `cup`, a container word — has no entry and so no conversion.
interface Metric {
  readonly unit: PackWeight['unit'];
  readonly factor: number;
}

const METRIC: ReadonlyMap<string, Metric> = new Map(
  (
    [
      ['g', 1, ['g', 'gram', 'grams', 'gramme', 'grammes']],
      ['g', 1000, ['kg', 'kilo', 'kilos', 'kilogram', 'kilograms']],
      ['ml', 1, ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters']],
      ['ml', 10, ['cl']],
      ['ml', 100, ['dl']],
      ['ml', 1000, ['l', 'litre', 'litres', 'liter', 'liters']],
    ] as const
  ).flatMap(([unit, factor, words]) => words.map((w): [string, Metric] => [w, { unit, factor }])),
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
 * a unit that is not metric weight or volume, grams against millilitres (there
 * is no density), or a bag with no usable weight. Units are matched trimmed and
 * case-insensitively, since a hand-added row keeps the casing it was typed in.
 */
export function packsForNeed(need: PackNeed, packWeight: PackWeight | null, held: number): number {
  const metric = METRIC.get(need.unit?.trim().toLowerCase() ?? '');
  if (
    metric === undefined ||
    need.amount === undefined ||
    !Number.isFinite(need.amount) ||
    need.amount <= 0 ||
    packWeight === null ||
    !(packWeight.amount > 0) ||
    metric.unit !== packWeight.unit
  ) {
    return 1;
  }
  const packs = Math.ceil((need.amount * metric.factor) / packWeight.amount - TOLERANCE);
  return Math.max(1, Math.min(held, packs));
}
