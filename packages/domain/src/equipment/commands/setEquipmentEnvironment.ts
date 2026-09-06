import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentEnvironmentDoc } from '../../schemas/equipmentManifest.js';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface SetEquipmentEnvironmentInput {
  readonly equipmentId: string;
  // `null` turns the item back into ordinary equipment — a knife block, not a
  // place. Nothing else in this feature reads it after that.
  readonly environment: EquipmentEnvironmentDoc | null;
  readonly now: string;
}

/**
 * The single write path for a place's environment (issue #1281).
 *
 * THIS IS WHERE THE SHARED/DEDICATED CLAIM IS ENFORCED. The schema deliberately
 * carries no `.refine` coupling `control` to `standing` — a refine on a
 * single-document manifest fails the whole equipment list on one bad item — so
 * the invariant lives here instead, and `setEquipmentEnvironment.test.ts` pins
 * it. Its boundary is exactly as narrow as that sentence: a document written
 * into Firestore by hand, or by any future path that is not this function, can
 * still hold a `standing` on a dedicated place. Readers must therefore treat
 * `standing` as meaningful only when `control === 'shared'`.
 *
 * Normalising rather than rejecting is the deliberate half: a place switched
 * from shared to dedicated has a stale setpoint that nobody is going to be
 * asked about, and Salt records rather than polices.
 */
export function setEquipmentEnvironment(
  manifest: EquipmentManifest,
  input: SetEquipmentEnvironmentInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) => {
    const env = input.environment;
    if (env === null) {
      return success({ ...item, environment: null });
    }
    if (env.maxCelsius < env.minCelsius) {
      return failure({
        kind: 'ValidationError',
        code: ErrorCode.INVALID_EQUIPMENT_ENVIRONMENT,
      });
    }
    if (env.humidity && env.humidity.maxPercent < env.humidity.minPercent) {
      return failure({
        kind: 'ValidationError',
        code: ErrorCode.INVALID_EQUIPMENT_ENVIRONMENT,
      });
    }
    return success({
      ...item,
      environment: {
        ...env,
        // A dedicated place is dialled in by whatever batch is using it, so a
        // standing setpoint on one is not a lesser setting — it is a lie.
        standing: env.control === 'shared' ? env.standing : null,
      },
    });
  });
}
