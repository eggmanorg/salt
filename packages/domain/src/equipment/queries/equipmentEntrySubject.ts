import type { Accessory, EquipmentItem } from '../entities/EquipmentItem.js';

// The name ONE ENTRY's picture is described and drawn from (issue #1465, Phase 2).
//
// An entry may now carry a pictogram of its own, keyed by its accessory id, and
// the describe step needs a name to work from exactly as an item's does. The
// entry's stored `name` is not always that name, and which of the two it is
// depends on what the record IS:
//
//   • A FAMILY's entry names a whole object — "De Buyer Mineral B Carbon Steel
//     28cm", "Lodge cast iron skillet". It stands on its own, and attaching the
//     family's name to it ("… (Frying Pans)") would tell the text model it is
//     looking at a category when it is looking at one pan.
//   • AN APPLIANCE's accessory names a PART — "Steam Basket", "Grill plate",
//     "Soup Ladle". On its own that is half a subject: a steam basket for what?
//     The appliance is what makes the part specific, and it is the difference
//     between the Cosori's ladle and any ladle.
//
// That is a branch on `kind`, and it is inside the licence `equipmentManifest.ts`
// states for it — the choice is which WORDS describe the subject, not whether the
// entry resolves, has a picture or exists.
//
// PURE (CLAUDE.md rule 1). It composes words and reads nothing.
//
// WHAT THIS STRING IS AND IS NOT. It is what the brief is authored from, and what
// lands in `briefSourceName` — which is also the comparison
// `equipmentIconAwaitingApproval` reads, so renaming either the entry or its
// appliance correctly reads as "waiting for you" again. It is NOT an identity:
// the document is keyed by the accessory's uuid and nothing looks an entry up by
// these words. It is not what the row shows either — the entry row and its dialog
// both display `accessory.name`, the words the household actually uses.

/**
 * The subject name an entry's pictogram is described and drawn from.
 *
 * @param item The record the entry sits under.
 * @param accessory The entry itself.
 * @returns The entry's own name for a family member; the name qualified by the
 *   appliance for an accessory. Falls back to whichever name is non-empty, so a
 *   caller never has to author a brief from an empty string.
 */
export function equipmentEntrySubjectName(
  item: Pick<EquipmentItem, 'name' | 'kind'>,
  accessory: Pick<Accessory, 'name'>,
): string {
  const entryName = accessory.name.trim();
  const itemName = item.name.trim();
  if (!entryName) return itemName;
  if (item.kind === 'family') return entryName;
  if (!itemName) return entryName;
  return `${entryName} (${itemName})`;
}
