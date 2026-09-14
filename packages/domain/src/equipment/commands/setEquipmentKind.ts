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
 * IT MOVES NOTHING EXCEPT THE TICKS A FAMILY RENDERS MEANINGLESS. The entries
 * underneath are the same list either way — same field, same commands, same
 * editor — so flipping the flag drops no entry, renames nothing and touches no
 * note. The one exception is `owned`, and it is not a licence, it is the other
 * half of decision 2: "a family's entries are written with `owned: true` … it
 * is simply always true where it has no meaning."
 *
 * WHY THE EXCEPTION IS LOAD-BEARING. The two paths that ADD an entry to a
 * family already honour that (`addAccessory`'s callers pass `owned: true` when
 * the record is one), and this is the only path that can break it: entries
 * typed while the record was still `'equipment'` are stored `owned: false`, and
 * the moment the flag flips, the owned checkbox is no longer rendered — so
 * nothing on screen can ever set them again. `renderEquipmentManifest` renders
 * only owned entries, and `renderEquipmentDetail` marks unowned ones "they do
 * not have this one". Left alone, a family of twelve pans he owns would render
 * as a bare name in all five AI prompts and be reported to the chef as twelve
 * pans he does not have, with nothing visible to explain it.
 *
 * Flipping to `'equipment'` is the direction that touches nothing: a tick means
 * something again there, and the household sets it.
 */
export function setEquipmentKind(
  manifest: EquipmentManifest,
  input: SetEquipmentKindInput,
): ReadResult<EquipmentManifest, DomainError> {
  return updateEquipmentItem(manifest, input.equipmentId, input.now, (item) =>
    success({
      ...item,
      kind: input.kind,
      accessories:
        input.kind === 'family'
          ? item.accessories.map((a) => (a.owned ? a : { ...a, owned: true }))
          : item.accessories,
    }),
  );
}
