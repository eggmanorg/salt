import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem, PackWeight } from '../entities/FreezerItem.js';
import { checkItemName, checkPackWeight, cleanOptionalText, updateItem } from './itemRules.js';

export interface EditFreezerItemInput {
  readonly number: number;
  readonly name: string;
  readonly purchasedFrom: string | null;
  /**
   * How big one pack is, in g, ml or a count — required on every edit, so an entry saved
   * before #1712 with none cannot be saved again until one is given.
   */
  readonly packWeight: PackWeight | null;
  /** The notes, blank or `null` for none; left as they are when omitted. */
  readonly notes?: string | null | undefined;
  /** The ingredient it is, or `null` for none; left as it is when omitted. */
  readonly canonId?: string | null | undefined;
  /** The recipe it was made from, or `null` for none; left as it is when omitted. */
  readonly recipeId?: string | null | undefined;
  readonly now: string;
}

/**
 * Rename an item, change where it was bought, its pack size, its notes, or what it
 * links to. Its number, place and count are left alone — the number is written
 * on the bag, a move is `moveFreezerItem` and a recount `setFreezerItemAmount`.
 */
export function editFreezerItem(
  items: readonly FreezerItem[],
  input: EditFreezerItemInput,
): ReadResult<FreezerItem, DomainError> {
  return updateItem(items, input.number, input.now, (item) => {
    const name = checkItemName(input.name);
    if (name.kind !== 'ok') return name;
    const packWeight = checkPackWeight(input.packWeight);
    if (packWeight.kind !== 'ok') return packWeight;
    return success({
      ...item,
      name: name.value,
      purchasedFrom: cleanOptionalText(input.purchasedFrom),
      packWeight: packWeight.value,
      notes: input.notes === undefined ? item.notes : cleanOptionalText(input.notes),
      canonId: input.canonId === undefined ? item.canonId : input.canonId,
      recipeId: input.recipeId === undefined ? item.recipeId : input.recipeId,
    });
  });
}
