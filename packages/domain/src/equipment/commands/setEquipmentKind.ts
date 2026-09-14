import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentKind } from '../../schemas/equipmentManifest.js';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface SetEquipmentKindInput {
  readonly equipmentId: string;
  readonly kind: EquipmentKind;
  readonly now: string;
}

/**
 * Say whether this record is a piece of equipment or a family of kit (#1373).
 *
 * IT MOVES NOTHING. The entries underneath are the same list either way, so
 * flipping the flag rewrites no entry, drops no accessory, and clears no owned
 * tick — a record flipped to `family` and straight back is the record it was.
 * All that changes is the words: the list's heading here, and its row label in
 * the chef's prompt.
 */
export function setEquipmentKind(
  manifest: EquipmentManifest,
  input: SetEquipmentKindInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) =>
    success({ ...item, kind: input.kind }),
  );
}
