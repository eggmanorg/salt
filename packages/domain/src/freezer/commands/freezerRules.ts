import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { Freezer, FreezerConfig } from '../entities/FreezerConfig.js';

// The rules the four freezer commands share (issue #1682). Internal to the
// module — not re-exported from `index.ts`, because they are how the commands are
// written, not something a caller should reach for.

/** The comparison key for "the same name": trimmed, case-insensitive. */
function sameKey(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * A freezer name, trimmed, or the refusal. A name is blank after trimming, or it
 * matches another freezer's case-insensitively ("Garage" against "garage") —
 * `exceptId` is the freezer being renamed, which may keep its own name.
 */
export function checkFreezerName(
  config: FreezerConfig,
  rawName: string,
  exceptId: string | null,
): ReadResult<string, DomainError> {
  const name = rawName.trim();
  if (!name) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_NAME });
  }
  const key = sameKey(name);
  if (config.freezers.some((f) => f.id !== exceptId && sameKey(f.name) === key)) {
    return failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_FREEZER_NAME });
  }
  return success(name);
}

/**
 * Shelf labels, trimmed and in the order given, or the refusal: a label blank
 * after trimming, or one repeated within the freezer. Repeats are compared the
 * same way freezer names are — "B" and "b" are one shelf — for the same reason.
 */
export function checkShelves(shelves: readonly string[]): ReadResult<string[], DomainError> {
  const labels = shelves.map((s) => s.trim());
  if (labels.some((label) => !label)) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_SHELF_LABEL });
  }
  const keys = labels.map(sameKey);
  if (new Set(keys).size !== keys.length) {
    return failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_SHELF_LABEL });
  }
  return success(labels);
}

/**
 * Find the freezer or fail NotFound, let the caller decide the change, stamp the
 * config's `updatedAt` and put the freezer back in place. Existence is checked
 * first, as `updateEquipmentItem` does, so a change to a freezer another device
 * has removed reports the missing freezer rather than its argument.
 */
export function updateFreezer(
  config: FreezerConfig,
  freezerId: string,
  now: string,
  change: (freezer: Freezer) => ReadResult<Freezer, DomainError>,
): ReadResult<FreezerConfig, DomainError> {
  const freezer = config.freezers.find((f) => f.id === freezerId);
  if (!freezer) {
    return failure({ kind: 'NotFound', resource: 'freezer', id: freezerId });
  }
  const changed = change(freezer);
  if (changed.kind !== 'ok') return changed;
  return success({
    ...config,
    updatedAt: now,
    freezers: config.freezers.map((f) => (f.id === freezerId ? changed.value : f)),
  });
}
