import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { checkItemName, cleanPurchasedFrom, updateItem } from './itemRules.js';

export interface EditFreezerItemInput {
  readonly number: number;
  readonly name: string;
  readonly purchasedFrom: string | null;
  readonly now: string;
}

/**
 * Rename an item or change where it was bought. Its number, place and count are
 * left alone — the number is written on the bag, and a move is `moveFreezerItem`.
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
    });
  });
}
