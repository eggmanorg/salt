import type { EquipmentIconDoc } from '../../schemas/equipmentIcon.js';

// Equipment pictogram queries (issue #877).
//
// The review gate's state is DERIVED from two names, never stored. See
// `schemas/equipmentIcon.ts` for why: a stored status would need bookkeeping on
// every path that could abandon a draw, and there is no such path when the state
// is a comparison.

/**
 * True when a description is waiting to be read and drawn.
 *
 * One comparison covers both cases the UI cares about:
 *   • NEVER DRAWN — `sourceName` is absent, so it can never equal
 *     `briefSourceName`;
 *   • RENAMED SINCE THE LAST DRAW — the trigger re-authored the brief under the
 *     new name, so `briefSourceName` moved and `sourceName` did not.
 *
 * It goes false the instant a draw succeeds, because the draw stamps
 * `sourceName = briefSourceName`.
 *
 * Note what this deliberately does NOT consider: `thumbnail`. A renamed item
 * keeps showing the picture it already had — you never lose a picture you liked
 * just because the words moved on — so "awaiting approval" and "has an icon" are
 * independent, and an item can truthfully be both.
 */
export function equipmentIconAwaitingApproval(icon: EquipmentIconDoc | null | undefined): boolean {
  if (!icon) return false;
  return icon.sourceName !== icon.briefSourceName;
}

/** The shape `equipmentIconOwnerIds` reads — a full `EquipmentItemDoc` satisfies it. */
export interface IconOwner {
  readonly id: string;
  readonly accessories?: readonly { readonly id: string }[];
}

/**
 * Every document id an `equipmentIcons` collection may legitimately hold, for one
 * manifest (issue #1465, Phase 2).
 *
 * THIS IS A DELETE LIST'S COMPLEMENT, which is why it is a named query rather
 * than an inline `.map()`. `onEquipmentManifestWritten` deletes every icon
 * document whose id is not in this set, on every manifest write, so an id missing
 * here is a picture destroyed — and before this existed the set was the items
 * alone, which would have taken every entry's picture with it the first time
 * anybody ticked a checkbox.
 *
 * `?? []` for the same reason `resolveKitEntryEquipment` carries it: this is pure
 * and takes whatever a caller hands it, and a partial item must read as "no
 * entries" rather than throw on the path that does the deleting.
 */
export function equipmentIconOwnerIds(items: readonly IconOwner[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(item.id);
    for (const accessory of item.accessories ?? []) ids.add(accessory.id);
  }
  return ids;
}
