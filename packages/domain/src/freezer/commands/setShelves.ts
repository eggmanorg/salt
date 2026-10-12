import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { checkShelves, updateFreezer } from './freezerRules.js';

export interface SetShelvesInput {
  readonly id: string;
  /** The freezer's whole shelf list, in order — adding and removing a shelf are both this. */
  readonly shelves: readonly string[];
  readonly now: string;
}

/**
 * Replace a freezer's shelves. Removing or relabelling a shelf is unconditional,
 * with stock still on it (#1684): the items keep the old label, and
 * `itemsByShelf` files them under Not placed until someone moves them.
 */
export function setShelves(
  config: FreezerConfig,
  input: SetShelvesInput,
): ReadResult<FreezerConfig, DomainError> {
  return updateFreezer(config, input.id, input.now, (freezer) => {
    const shelves = checkShelves(input.shelves);
    if (shelves.kind !== 'ok') return shelves;
    return success({ ...freezer, shelves: shelves.value });
  });
}
