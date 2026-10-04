import type { CanonItem } from '@salt/domain';
import type { CanonItemUnit, ShoppingBehavior } from '@salt/shared-types';
import {
  updateCanonItemAisle,
  updateCanonItemShoppingBehavior,
  updateCanonItemThreshold,
  updateCanonItemUnit,
  updateCanonItemGramsPerItem,
} from '../../lib/canonService.js';

/**
 * The decisions the matching pipeline makes about a canon item — which aisle it
 * belongs to, how it is shopped, the unit it is bought in, and the quantity that
 * counts as a lot — and the ONE place they are written from (issue #872).
 *
 * Two surfaces edit them: the record editor's full field stack, and the
 * catalog's review row, where they are inline value chips (ui-spec-v09 §8.27).
 * Both follow the same commit contract — every field writes through on change or
 * blur, there is no Save button, and blur never discards — which means both need
 * the same no-op guards. A second copy of the threshold guard below is precisely
 * the drift issue #872 exists to end, so it lives here and neither page holds
 * its own.
 *
 * These wrap `canonService` and add nothing to it. Rule 10 already applies: a
 * failed write comes back as a `Failure`, never a throw, so the return here is a
 * three-way answer rather than a boolean — a no-op is not a save, and a caller
 * that flashed "Saved" on a tab-out through an untouched field would be lying.
 */

/** The unit the UI shows for a document that never stored one. */
export const DEFAULT_THRESHOLD_UNIT: CanonItemUnit = 'g';

export type DecisionSave = 'unchanged' | 'saved' | 'failed';

/**
 * Optional busy plumbing. The guard runs BEFORE `onBusy(true)`, so a no-op
 * commit never flickers a spinner — which is the common case, because blur
 * fires on every exit from a field whether or not it was touched.
 */
export type DecisionSaveOptions = { onBusy?: (busy: boolean) => void };

async function commit(
  run: () => Promise<{ kind: string }>,
  options: DecisionSaveOptions | undefined,
): Promise<DecisionSave> {
  options?.onBusy?.(true);
  try {
    const result = await run();
    return result.kind === 'ok' ? 'saved' : 'failed';
  } finally {
    options?.onBusy?.(false);
  }
}

/** `value` is an aisle id, or `''` for the "No aisle" option. */
export function saveCanonAisle(
  item: CanonItem,
  value: string,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  const aisleId = value || null;
  if (aisleId === item.aisleId) return Promise.resolve('unchanged');
  return commit(() => updateCanonItemAisle(item, aisleId), options);
}

export function saveCanonShoppingBehavior(
  item: CanonItem,
  value: string,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  const behavior = value as ShoppingBehavior;
  if (behavior === item.shoppingBehavior) return Promise.resolve('unchanged');
  return commit(() => updateCanonItemShoppingBehavior(item, behavior), options);
}

/**
 * `rawAmount` is whatever is in the number field — empty, or unparseable, means
 * "no threshold". Only the threshold is written: the unit is its own decision
 * (`saveCanonUnit`, issue #1651), and clearing a threshold leaves it alone.
 *
 * Blur fires on every exit from the field, so a no-op edit must not write.
 *
 * `shownUnit` is what the unit control displays beside the number. For an item
 * that never stored a unit that is `DEFAULT_THRESHOLD_UNIT`, and a threshold typed
 * against it stores that unit in the same write — the number was entered as
 * grams, and the threshold is read in the item's unit. An item that has a unit
 * keeps it, whatever is passed here.
 */
export function saveCanonThreshold(
  item: CanonItem,
  rawAmount: string,
  shownUnit: CanonItemUnit,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  const raw = rawAmount.trim();
  const parsed = raw ? parseFloat(raw) : NaN;
  const value = Number.isNaN(parsed) ? undefined : parsed;
  if (value === item.largeQuantityThreshold) return Promise.resolve('unchanged');
  const target =
    value !== undefined && item.unit === undefined ? { ...item, unit: shownUnit } : item;
  return commit(() => updateCanonItemThreshold(target, value), options);
}

/**
 * The unit the item is bought in (issue #1651) — `count` makes its recipe lines
 * read and shop as a count. Independent of the threshold: it can be set on an
 * item with none. `item.unit ?? DEFAULT_THRESHOLD_UNIT` is what the control SHOWS
 * for an item that never stored one, so choosing that is no change.
 */
export function saveCanonUnit(
  item: CanonItem,
  unit: CanonItemUnit,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  if (unit === (item.unit ?? DEFAULT_THRESHOLD_UNIT)) return Promise.resolve('unchanged');
  return commit(() => updateCanonItemUnit(item, unit), options);
}

/**
 * The weight of one item, in grams (issue #1643). Blank clears it. Text that is
 * not a positive number is left unsaved ("unchanged") rather than clearing a
 * stored weight by accident; the domain command refuses one anyway.
 */
export function saveCanonGramsPerItem(
  item: CanonItem,
  rawGrams: string,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  const raw = rawGrams.trim();
  const parsed = raw ? Number(raw) : undefined;
  if (parsed !== undefined && !(Number.isFinite(parsed) && parsed > 0)) {
    return Promise.resolve('unchanged');
  }
  if (parsed === item.gramsPerItem) return Promise.resolve('unchanged');
  return commit(() => updateCanonItemGramsPerItem(item, parsed), options);
}
