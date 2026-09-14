import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface EditEquipmentNoteInput {
  readonly equipmentId: string;
  readonly note: string;
  readonly now: string;
}

/**
 * Set (or clear) the record's OWN note — what the chef should read while it is
 * weighing whether to use this thing at all (issue #1373).
 *
 * Distinct from `addRule`/`editRule`, which is the standing fact the chef is told
 * whether or not it asks. An empty note is valid for the same reason as on an
 * accessory: clearing one is deliberate, and nothing else clears it.
 *
 * Named for equipment rather than for "item" because the domain root barrel
 * already publishes the shopping list's `editItemNotes`, and two exports a
 * single character apart is a mis-import waiting to happen.
 */
export function editEquipmentNote(
  manifest: EquipmentManifest,
  input: EditEquipmentNoteInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) =>
    success({ ...item, note: input.note.trim() }),
  );
}
