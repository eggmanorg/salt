import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { Defrost } from '../entities/Defrost.js';

export interface CommitDefrostInput {
  readonly freezerNumber: number;
  readonly name: string;
  /** Where the bag is now, as Kitchen will show it: `Garage · shelf B`. */
  readonly location: string;
  /** The recipe the pack serves — a "make it yourself" row's producer — or null for a hand-added row. */
  readonly recipeId: string | null;
  readonly recipeTitle: string | null;
  /** Whole packs, 1 or more. */
  readonly amount: number;
}

/**
 * The Kitchen item for packs used from the freezer (issue #1685). `existing` is
 * the document already at this id (`defrostDocId(freezerNumber, recipeId)`) as
 * the caller's store holds it, or null.
 *
 * Committing to an id that already exists SUMS the packs: two rows of the same
 * recipe, or two hand-added rows of the same item, are two packs out of the
 * count, and an overwrite would show one. The first commit's `committedAt` is
 * kept, so the item keeps its place among the undated ones; the snapshots
 * (`name`, `location`, `recipeTitle`) take the newer values.
 *
 * The sum is only as fresh as `existing`: a commit on another phone that this
 * one's store has not yet seen is overwritten (document-level LWW).
 */
export function commitDefrost(
  existing: Defrost | null,
  input: CommitDefrostInput,
  now: string,
): ReadResult<Defrost, DomainError> {
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT });
  }
  return success({
    schemaVersion: 1,
    freezerNumber: input.freezerNumber,
    name: input.name,
    location: input.location,
    recipeId: input.recipeId,
    recipeTitle: input.recipeTitle,
    amount: (existing?.amount ?? 0) + input.amount,
    committedAt: existing?.committedAt ?? now,
  });
}
