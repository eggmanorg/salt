import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, Result } from '@salt/shared-types';
import type { CanonItem, ShoppingBehavior, CanonItemUnit } from '../entities/CanonItem.js';

export function setCanonItemShoppingBehavior(
  item: CanonItem,
  shoppingBehavior: ShoppingBehavior,
): Result<CanonItem, DomainError> {
  return success({ ...item, shoppingBehavior });
}

// The weight of one item (issue #1643). `undefined` clears it; a non-positive or
// non-finite value is refused rather than stored, since it would divide a
// combined row's grams by nothing.
export function setCanonItemGramsPerItem(
  item: CanonItem,
  gramsPerItem: number | undefined,
): Result<CanonItem, DomainError> {
  if (gramsPerItem !== undefined && !(Number.isFinite(gramsPerItem) && gramsPerItem > 0)) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_CANON_GRAMS_PER_ITEM });
  }
  const { gramsPerItem: _g, ...base } = item;
  return success({ ...base, ...(gramsPerItem !== undefined ? { gramsPerItem } : {}) } as CanonItem);
}

// The quantity that counts as "a lot" for a `stocked` item, read in the item's
// own `unit`. `undefined` clears it. It changes ONLY the threshold: the unit is
// how the household buys the item, its own decision (issue #1651), and since
// #1643 it decides whether recipe lines read as a count — so clearing a
// threshold must not quietly turn a counted item back into a weighed one.
export function setCanonItemThreshold(
  item: CanonItem,
  largeQuantityThreshold: number | undefined,
): Result<CanonItem, DomainError> {
  // Destructure optional fields so we can re-add them conditionally,
  // avoiding exactOptionalPropertyTypes violations from explicit undefined spread.
  const { largeQuantityThreshold: _l, ...base } = item;
  return success({
    ...base,
    ...(largeQuantityThreshold !== undefined ? { largeQuantityThreshold } : {}),
  } as CanonItem);
}

// The unit the household buys the item in (issue #1651). `undefined` clears it.
// It changes ONLY the unit — never the threshold, and never `gramsPerItem`, which
// is read only while the unit is `count` and so stays harmless when it is not.
export function setCanonItemUnit(
  item: CanonItem,
  unit: CanonItemUnit | undefined,
): Result<CanonItem, DomainError> {
  const { unit: _u, ...base } = item;
  return success({ ...base, ...(unit !== undefined ? { unit } : {}) } as CanonItem);
}
