import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentKind } from '../../schemas/equipmentManifest.js';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import type { IdGenerator } from '../ports/IdGenerator.js';

export interface AddEquipmentInput {
  readonly name: string;
  readonly now: string;
  // Equipment unless the caller says otherwise (issue #1373) — a family is the
  // rarer case, and every call site that predates families means `'equipment'`.
  readonly kind?: EquipmentKind;
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
    kind: input.kind ?? ('equipment' as const),
    accessories: [],
    rules: [],
    note: '',
    // Nothing is a place until it is described as one (issue #1281).
    environment: null,
    // Nothing is borrowed until somebody points this at a drawing (#1465 Phase 3).
    borrowedPicture: null,
    updatedAt: input.now,
  };
  return success({ ...manifest, items: [...manifest.items, newItem] });
}
