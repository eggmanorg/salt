import type { FreezerItem } from '../entities/FreezerItem.js';

/**
 * The lowest positive bag number no item in `items` carries — so a number freed
 * by a removal is offered again before the count climbs. `items` is what the
 * calling device holds; order does not matter.
 */
export function nextFreeNumber(items: readonly FreezerItem[]): number {
  const used = new Set(items.map((i) => i.number));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}
