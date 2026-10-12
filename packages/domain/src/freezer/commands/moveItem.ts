import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { checkPlace, updateItem } from './itemRules.js';

export interface MoveFreezerItemInput {
  readonly number: number;
  readonly freezerId: string;
  /** One of the freezer's shelves, or `null` for a freezer with none. */
  readonly shelf: string | null;
  readonly now: string;
}

/**
 * Put an item on another shelf or in another freezer. Only `freezerId` and
 * `shelf` change; the number — the document id — stays, because it is written on
 * the bag. This is also how an item leaves Not placed.
 */
export function moveFreezerItem(
  items: readonly FreezerItem[],
  config: FreezerConfig,
  input: MoveFreezerItemInput,
): ReadResult<FreezerItem, DomainError> {
  return updateItem(items, input.number, input.now, (item) => {
    const place = checkPlace(config, input.freezerId, input.shelf);
    if (place.kind !== 'ok') return place;
    return success({ ...item, ...place.value });
  });
}
