import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';
import { updateItem } from './itemRules.js';

export interface TakeFreezerPacksInput {
  readonly number: number;
  /** How many packs to take — a whole number, 1 or more. The page takes one. */
  readonly count: number;
  readonly now: string;
}

export interface TakenPacks {
  /**
   * What to add to the stored `amount`: `-count`, or less when fewer are left,
   * and `0` when none are. The adapter applies it as a field transform, so two
   * devices taking at once both count.
   */
  readonly delta: number;
  /** The item as this device should show it straight away. */
  readonly item: FreezerItem;
  /**
   * Nothing is left by this device's count — the cue to ask whether to remove
   * the entry. Also true for an item already at or below zero (two devices took
   * the last pack at once), which takes nothing more.
   */
  readonly last: boolean;
}

/**
 * Take packs out of an item. Returns the delta rather than a new count: the
 * count another device has taken meanwhile is unknown here, and only a delta
 * composes with it (issue #1684).
 */
export function takeFreezerPacks(
  items: readonly FreezerItem[],
  input: TakeFreezerPacksInput,
): ReadResult<TakenPacks, DomainError> {
  if (!Number.isInteger(input.count) || input.count < 1) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT });
  }
  let delta = 0;
  const taken = updateItem(items, input.number, input.now, (item) => {
    delta = 0 - Math.min(input.count, Math.max(item.amount, 0));
    return success({ ...item, amount: item.amount + delta });
  });
  if (taken.kind !== 'ok') return taken;
  return success({ delta, item: taken.value, last: taken.value.amount <= 0 });
}
