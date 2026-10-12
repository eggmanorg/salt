import type { FreezerItem } from '../entities/FreezerItem.js';
import { displayAmount } from './displayAmount.js';
import { oldestFirst } from './itemsByShelf.js';

/**
 * The freezer entries a shopping row's ingredient could come out of (issue
 * #1685): those linked to exactly `canonId`, with a pack left to show, oldest
 * first. An exact comparison — no fuzzy matching (#795) — so a row still
 * matching (`canonId: null`) matches nothing until its match lands.
 */
export function freezerStockFor(
  items: readonly FreezerItem[],
  canonId: string | null,
): readonly FreezerItem[] {
  if (canonId === null) return [];
  return oldestFirst(
    items.filter((item) => item.canonId === canonId && displayAmount(item.amount) > 0),
  );
}
