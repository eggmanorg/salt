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
 * Replace a freezer's shelves. Removal is unconditional: nothing can sit on a
 * shelf until freezer stock exists (#1684), which is where removing an occupied
 * shelf gets its answer.
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
