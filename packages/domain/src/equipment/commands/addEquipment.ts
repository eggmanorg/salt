import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import type { IdGenerator } from '../ports/IdGenerator.js';

export interface AddEquipmentInput {
  readonly name: string;
  readonly now: string;
}

export function addEquipment(
  manifest: EquipmentManifest,
  input: AddEquipmentInput,
  ids: IdGenerator,
): ReadResult<EquipmentManifest, DomainError> {
  const name = input.name.trim();
  if (!name) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_EQUIPMENT_NAME });
  }
  const newItem = {
    id: ids.newEquipmentId(),
    schemaVersion: 1 as const,
    name,
    accessories: [],
    rules: [],
    // Nothing is a place until it is described as one (issue #1281).
    environment: null,
    updatedAt: input.now,
  };
  return success({ ...manifest, items: [...manifest.items, newItem] });
}
