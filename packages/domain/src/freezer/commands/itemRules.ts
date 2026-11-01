import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerItem, PackWeight } from '../entities/FreezerItem.js';

// The rules the item commands share (issue #1684). Internal to the module, like
// `freezerRules.ts` beside it.

/** An item name, trimmed, or the refusal for a blank one. */
export function checkItemName(rawName: string): ReadResult<string, DomainError> {
  const name = rawName.trim();
  if (!name) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_ITEM_NAME });
  }
  return success(name);
}

/** Optional free text — where it was bought, the notes — trimmed; blank is `null`. */
export function cleanOptionalText(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed ? trimmed : null;
}

/**
 * A pack size, or the refusal: the amount a finite number above zero — a whole
 * one for a count — and the unit g, ml or count. Missing is refused too — every
 * add and edit carries one (#1712).
 */
export function checkPackWeight(
  raw: PackWeight | null | undefined,
): ReadResult<PackWeight, DomainError> {
  if (
    !raw ||
    !Number.isFinite(raw.amount) ||
    raw.amount <= 0 ||
    (raw.unit !== 'g' && raw.unit !== 'ml' && raw.unit !== 'count') ||
    (raw.unit === 'count' && !Number.isInteger(raw.amount))
  ) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_PACK_WEIGHT });
  }
  return success({ amount: raw.amount, unit: raw.unit });
}

/**
 * A place the setup has, or the refusal. The freezer must be in the config.
 * The shelf is one of its shelves, matched exactly as stored, or `null`: in a
 * freezer set up with none that is the only place; in one with shelves it is
 * "no shelf yet" — a bag labelled in the kitchen before anyone has seen where
 * it fits, filed by `itemsByShelf` until it is moved onto one.
 */
export function checkPlace(
  config: FreezerConfig,
  freezerId: string,
  shelf: string | null,
): ReadResult<{ freezerId: string; shelf: string | null }, DomainError> {
  const freezer = config.freezers.find((f) => f.id === freezerId);
  const fits = freezer !== undefined && (shelf === null || freezer.shelves.includes(shelf));
  if (!fits) {
    return failure({ kind: 'ValidationError', code: ErrorCode.UNKNOWN_FREEZER_PLACE });
  }
  return success({ freezerId, shelf });
}

/**
 * Find the item at `number` or fail NotFound, let the caller decide the change
 * and stamp `updatedAt`. Existence is checked first, as `updateFreezer` does, so
 * an edit to an item another device removed reports the missing item.
 */
export function updateItem(
  items: readonly FreezerItem[],
  number: number,
  now: string,
  change: (item: FreezerItem) => ReadResult<FreezerItem, DomainError>,
): ReadResult<FreezerItem, DomainError> {
  const item = items.find((i) => i.number === number);
  if (!item) {
    return failure({ kind: 'NotFound', resource: 'freezerItem', id: String(number) });
  }
  const changed = change(item);
  if (changed.kind !== 'ok') return changed;
  return success({ ...changed.value, updatedAt: now });
}
