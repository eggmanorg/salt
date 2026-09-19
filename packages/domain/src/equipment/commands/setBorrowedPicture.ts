import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { EquipmentManifest } from '../entities/EquipmentManifest.js';
import type { BorrowedPictureDoc } from '../../schemas/equipmentManifest.js';
import { updateEquipmentItem } from './updateEquipmentItem.js';

export interface SetBorrowedPictureInput {
  readonly equipmentId: string;
  /** The entry to point, or `null` for the record itself. */
  readonly accessoryId: string | null;
  /** The picture to borrow, or `null` to stop borrowing one. */
  readonly picture: BorrowedPictureDoc | null;
  readonly now: string;
}

/**
 * Point one of the household's things at a picture that already exists (issue
 * #1465, Phase 3) — or stop it borrowing one.
 *
 * "This Tefal 28cm looks like the generic frying pan." Nothing is drawn, nothing
 * is copied, and every recipe naming that pan gains the picture at once, because
 * what is stored is a REFERENCE that `kitIcons.ts` reads through at display time.
 *
 * ONE COMMAND FOR BOTH SCALES, keyed on `accessoryId` being null, because the
 * field is the same field on both schemas and the act is the same act — "this
 * thing looks like that drawing". Two commands would be two places to keep the
 * borrow/clear semantics in step.
 *
 * THE TARGET IS NOT VALIDATED HERE, and that is deliberate rather than an
 * omission. This is pure and holds only the manifest, so it cannot see the
 * `kitchenTools` or `equipmentIcons` collections the reference points into — and
 * even if it could, the target can be deleted a second after this write. A
 * reference that no longer answers resolves to nothing at display time and the
 * row falls back exactly as it did before, which is the same degradation a
 * dangling kit link gets and the reason the schema carries no refine.
 *
 * Reads no clock (`now` is passed) and no store — pure, per the layer contract.
 */
export function setBorrowedPicture(
  manifest: EquipmentManifest,
  input: SetBorrowedPictureInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) => {
    if (input.accessoryId === null) {
      return success({ ...item, borrowedPicture: input.picture });
    }
    if (!item.accessories.some((a) => a.id === input.accessoryId)) {
      return failure({ kind: 'ValidationError', code: ErrorCode.EQUIPMENT_ACCESSORY_NOT_FOUND });
    }
    return success({
      ...item,
      accessories: item.accessories.map((a) =>
        a.id === input.accessoryId ? { ...a, borrowedPicture: input.picture } : a,
      ),
    });
  });
}
