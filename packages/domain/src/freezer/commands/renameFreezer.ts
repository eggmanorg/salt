import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { checkFreezerName, updateFreezer } from './freezerRules.js';

export interface RenameFreezerInput {
  readonly id: string;
  readonly name: string;
  readonly now: string;
}

/** Give a freezer a new name. Its id is untouched — stock will point at it. */
export function renameFreezer(
  config: FreezerConfig,
  input: RenameFreezerInput,
): ReadResult<FreezerConfig, DomainError> {
  return updateFreezer(config, input.id, input.now, (freezer) => {
    const name = checkFreezerName(config, input.name, freezer.id);
    if (name.kind !== 'ok') return name;
    return success({ ...freezer, name: name.value });
  });
}
