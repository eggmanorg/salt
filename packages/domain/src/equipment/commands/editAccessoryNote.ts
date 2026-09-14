import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface EditAccessoryNoteInput {
  readonly equipmentId: string;
  readonly accessoryId: string;
  readonly note: string;
  readonly now: string;
}

/**
 * Set (or clear) what the household knows about ONE entry under a record —
 * one accessory of an appliance, or one pan in a family of pans (issue #1373).
 *
 * AN EMPTY NOTE IS A VALID NOTE, unlike an empty rule or an empty name: clearing
 * a note is a thing a person means to do, and there is no other command that
 * would do it. So the only failure here is an entry that does not exist.
 */
export function editAccessoryNote(
  manifest: EquipmentManifest,
  input: EditAccessoryNoteInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) => {
    if (!item.accessories.some((a) => a.id === input.accessoryId)) {
      return failure({ kind: 'ValidationError', code: ErrorCode.EQUIPMENT_ACCESSORY_NOT_FOUND });
    }
    const note = input.note.trim();
    return success({
      ...item,
      accessories: item.accessories.map((a) => (a.id === input.accessoryId ? { ...a, note } : a)),
    });
  });
}
