import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { checkItemName, cleanPurchasedFrom, updateItem } from './itemRules.js';

export interface EditFreezerItemInput {
  readonly number: number;
  readonly name: string;
  readonly purchasedFrom: string | null;
  /** The ingredient it is, or `null` for none; left as it is when omitted. */
  readonly canonId?: string | null | undefined;
  /** The recipe it was made from, or `null` for none; left as it is when omitted. */
  readonly recipeId?: string | null | undefined;
  readonly now: string;
}

/**
 * Rename an item, change where it was bought, or change what it links to. Its
 * number, place and count are left alone — the number is written on the bag, a
 * move is `moveFreezerItem` and a recount `setFreezerItemAmount`.
 */
export function editFreezerItem(
  items: readonly FreezerItem[],
  input: EditFreezerItemInput,
): ReadResult<FreezerItem, DomainError> {
  return updateItem(items, input.number, input.now, (item) => {
    const name = checkItemName(input.name);
    if (name.kind !== 'ok') return name;
    return success({
      ...item,
      name: name.value,
      purchasedFrom: cleanPurchasedFrom(input.purchasedFrom),
      canonId: input.canonId === undefined ? item.canonId : input.canonId,
      recipeId: input.recipeId === undefined ? item.recipeId : input.recipeId,
    });
  });
}
