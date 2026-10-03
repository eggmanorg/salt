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

export function setCanonItemThreshold(
  item: CanonItem,
  largeQuantityThreshold: number | undefined,
  unit: CanonItemUnit | undefined,
): Result<CanonItem, DomainError> {
  // Destructure optional fields so we can re-add them conditionally,
  // avoiding exactOptionalPropertyTypes violations from explicit undefined spread.
  const { largeQuantityThreshold: _l, unit: _u, ...base } = item;
  return success({
    ...base,
    ...(largeQuantityThreshold !== undefined ? { largeQuantityThreshold } : {}),
    ...(unit !== undefined ? { unit } : {}),
  } as CanonItem);
}
