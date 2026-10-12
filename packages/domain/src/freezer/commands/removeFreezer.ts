import { failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';

export interface RemoveFreezerInput {
  readonly id: string;
  readonly now: string;
}

/**
 * Remove a freezer and its shelves. Unconditional, like `setShelves`: what
 * happens to stock on a removed freezer is #1684's to decide once stock exists.
 */
export function removeFreezer(
  config: FreezerConfig,
  input: RemoveFreezerInput,
): ReadResult<FreezerConfig, DomainError> {
  if (!config.freezers.some((f) => f.id === input.id)) {
    return failure({ kind: 'NotFound', resource: 'freezer', id: input.id });
  }
  return success({
    ...config,
    updatedAt: input.now,
    freezers: config.freezers.filter((f) => f.id !== input.id),
  });
}
