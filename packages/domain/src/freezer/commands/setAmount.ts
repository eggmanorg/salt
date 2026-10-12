import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { updateItem } from './itemRules.js';

export interface SetFreezerItemAmountInput {
  readonly number: number;
  /** The packs actually there — a whole number, 0 or more. */
  readonly amount: number;
  readonly now: string;
}

/**
 * Correct an item's count from the edit sheet. Unlike taking packs this states
 * a count, so it is written whole: a take another device made that this one had
 * not yet seen is overwritten (CLAUDE.md, LWW per document).
 */
export function setFreezerItemAmount(
  items: readonly FreezerItem[],
  input: SetFreezerItemAmountInput,
): ReadResult<FreezerItem, DomainError> {
  return updateItem(items, input.number, input.now, (item) => {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT });
    }
    return success({ ...item, amount: input.amount });
  });
}
