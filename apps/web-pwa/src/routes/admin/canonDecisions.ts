import type { CanonItem } from '@salt/domain';
import type { CanonItemUnit, ShoppingBehavior } from '@salt/shared-types';
import {
  updateCanonItemAisle,
  updateCanonItemShoppingBehavior,
  updateCanonItemThreshold,
  updateCanonItemGramsPerItem,
} from '../../lib/canonService.js';

/**
 * The three decisions the matching pipeline makes about a canon item — which
 * aisle it belongs to, how it is shopped, and the quantity that counts as a lot
 * — and the ONE place they are written from (issue #872).
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
 * "no threshold", which also clears the unit.
 *
 * The guard is the subtle one. Blur fires on every exit from the field, so a
 * no-op edit must not write. `item.unit ?? DEFAULT_THRESHOLD_UNIT` is what the
 * unit control actually SHOWS for a document that never stored one — comparing
 * against the bare `item.unit` would read that default as a change and write on
 * every single blur.
 */
export function saveCanonThreshold(
  item: CanonItem,
  rawAmount: string,
  unit: CanonItemUnit,
  options?: DecisionSaveOptions,
): Promise<DecisionSave> {
  const raw = rawAmount.trim();
  const parsed = raw ? parseFloat(raw) : NaN;
  const value = Number.isNaN(parsed) ? undefined : parsed;
  const nextUnit = value !== undefined ? unit : undefined;
  const storedUnit = item.unit ?? DEFAULT_THRESHOLD_UNIT;
  if (value === item.largeQuantityThreshold && (value === undefined || nextUnit === storedUnit)) {
    return Promise.resolve('unchanged');
  }
  return commit(() => updateCanonItemThreshold(item, value, nextUnit), options);
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
