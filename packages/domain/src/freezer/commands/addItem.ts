import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { checkItemName, checkPlace, cleanPurchasedFrom } from './itemRules.js';

export interface AddFreezerItemInput {
  /** The bag number — usually `nextFreeNumber(items)`, or one typed over it. */
  readonly number: number;
  readonly name: string;
  readonly freezerId: string;
  /** One of the freezer's shelves, or `null` for a freezer with none. */
  readonly shelf: string | null;
  /** How many packs, a whole number of at least one. */
  readonly amount: number;
  /** Where it was bought. Optional; blank is none. */
  readonly purchasedFrom?: string | null;
  /** The ingredient it is, if one was picked. Optional. */
  readonly canonId?: string | null;
  /** The recipe it was made from, if one was picked. Optional. */
  readonly recipeId?: string | null;
  readonly now: string;
}

/**
 * A new item, or the refusal. The number must be a positive whole number that
 * no item in `items` carries — `items` is what THIS device holds, so the check
 * cannot see an item another device added while one of them was offline
 * (docs/data-model.md → `freezerItems/{number}`).
 */
export function addFreezerItem(
  items: readonly FreezerItem[],
  config: FreezerConfig,
  input: AddFreezerItemInput,
): ReadResult<FreezerItem, DomainError> {
  if (!Number.isInteger(input.number) || input.number < 1) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_NUMBER });
  }
  if (items.some((i) => i.number === input.number)) {
    return failure({ kind: 'ValidationError', code: ErrorCode.FREEZER_NUMBER_IN_USE });
  }
  const name = checkItemName(input.name);
  if (name.kind !== 'ok') return name;
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT });
  }
  const place = checkPlace(config, input.freezerId, input.shelf);
  if (place.kind !== 'ok') return place;
  return success({
    schemaVersion: 1,
    number: input.number,
    name: name.value,
    freezerId: place.value.freezerId,
    shelf: place.value.shelf,
    amount: input.amount,
    canonId: input.canonId ?? null,
    recipeId: input.recipeId ?? null,
    purchasedFrom: cleanPurchasedFrom(input.purchasedFrom),
    addedAt: input.now,
    updatedAt: input.now,
  });
}
