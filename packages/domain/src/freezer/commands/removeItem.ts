import { failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';

export interface RemoveFreezerItemInput {
  readonly number: number;
}

/**
 * The item to delete, or NotFound when this device no longer holds it. Deleting
 * it leaves the config's `highestNumber` alone, so `nextBagNumber` does not
 * offer its number again — short of the stale-copy window in docs/data-model.md
 * → `freezerConfig.highestNumber`. A person can still type it by hand.
 */
export function removeFreezerItem(
  items: readonly FreezerItem[],
  input: RemoveFreezerItemInput,
): ReadResult<FreezerItem, DomainError> {
  const item = items.find((i) => i.number === input.number);
  if (!item) {
    return failure({ kind: 'NotFound', resource: 'freezerItem', id: String(input.number) });
  }
  return success(item);
}
