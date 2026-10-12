import { failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';

export interface RemoveFreezerInput {
  readonly id: string;
  readonly now: string;
}

/**
 * Remove a freezer and its shelves. Unconditional, like `setShelves`, with stock
 * still in it (#1684): the items are neither deleted nor rewritten, and
 * `itemsByShelf` files them under Not placed until someone moves them.
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
