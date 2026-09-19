import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import type { IdGenerator } from '../ports/IdGenerator.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface AddAccessoryInput {
  readonly equipmentId: string;
  readonly name: string;
  readonly owned: boolean;
  readonly included: boolean;
  readonly now: string;
}

export function addAccessory(
  manifest: EquipmentManifest,
  input: AddAccessoryInput,
  ids: IdGenerator,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) => {
    const name = input.name.trim();
    if (!name) {
      return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_ACCESSORY_NAME });
    }
    return success({
      ...item,
      accessories: [
        ...item.accessories,
        // Nothing is said about an entry until someone says it (#1373) —
        // `editAccessoryNote` is the only thing that writes here.
        {
          id: ids.newAccessoryId(),
          name,
          owned: input.owned,
          included: input.included,
          note: '',
          // Nothing is borrowed until somebody points this at a drawing
          // (#1465 Phase 3).
          borrowedPicture: null,
        },
      ],
    });
  });
}
