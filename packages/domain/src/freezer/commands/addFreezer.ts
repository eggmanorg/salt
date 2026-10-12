import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerIdGenerator } from '../ports/FreezerIdGenerator.js';
import { checkFreezerName, checkShelves } from './freezerRules.js';

export interface AddFreezerInput {
  readonly name: string;
  /** Its shelf labels, in order. None is a freezer with no shelves yet. */
  readonly shelves?: readonly string[];
  readonly now: string;
}

/** Add a freezer at the end of the list, with an id minted by `ids`. */
export function addFreezer(
  config: FreezerConfig,
  input: AddFreezerInput,
  ids: FreezerIdGenerator,
): ReadResult<FreezerConfig, DomainError> {
  const name = checkFreezerName(config, input.name, null);
  if (name.kind !== 'ok') return name;
  const shelves = checkShelves(input.shelves ?? []);
  if (shelves.kind !== 'ok') return shelves;
  return success({
    ...config,
    updatedAt: input.now,
    freezers: [
      ...config.freezers,
      { id: ids.newFreezerId(), name: name.value, shelves: shelves.value },
    ],
  });
}
