import { resolveKitEntryEquipment } from '../../equipment/index.js';
import type { EquipmentItem } from '../../equipment/index.js';
import type { RecipeKitEntryDoc } from '../../schemas/index.js';

// Which pieces of a recipe's kit belong UNDER another one (issue #1140).
//
// The Equipment tab lists what to get out of the cupboards. Flat, it treats
// "Cosori 5L Rice Cooker" and "Rice Spoon" as two unrelated things, when the rice
// spoon is the rice cooker's — it came in the box. This is the derivation that
// puts the spoon under the cooker.
//
// ── THE LINK IS THE WHOLE ANSWER (issue #1465) ───────────────────────────────
//
// A kit entry carries `equipment: { itemId, accessoryId }` — recorded by the flow
// that wrote the label, which had the manifest in front of it. Where it resolves
// it is the answer; where it does not, the entry is a flat row. Three rules, and
// they are all of them:
//
//   - an entry linked to an item ITSELF heads that item's row;
//   - an entry linked to an ACCESSORY of an `equipment`-kind item nests under that
//     item's row when this kit also names the item, and otherwise stands as its
//     own row;
//   - an entry linked to a member of a `family` ALWAYS stands as its own row, and
//     never anchors another entry beneath it. A family is not an appliance with
//     parts: "frying pan" beside the All-Clad read "frying pan — with the All-Clad
//     D3 10 inch frying pan", as if one pan were an attachment of the other, and
//     that is the false statement this rule exists to refuse. `kind` is picking
//     PRESENTATION here and nothing else (`equipmentManifest.ts` — it may never
//     gate whether an entry resolves, has a picture, or exists).
//
// A second naming of the same item in its own words is a duplicate mention, not a
// part of the machine, and keeps its own row. WHICH ENTRY HEADS IS NOT DECIDED BY
// STORED ORDER: the head is chosen before any row exists, and position only breaks
// a tie between two entries that both link the item directly.
//
// NO APPLIANCE IS EVER INVENTED AS A HEADING. Every head is an entry the flow
// wrote, and the heads appear in the order it wrote them — so a recipe wanting the
// Magimix's pot and not the Magimix lists the pot, flat, rather than growing a
// machine nobody asked for.
//
// ── THE WORD PASSES, AND WHY THEY ARE GONE ───────────────────────────────────
//
// AN UNLINKED ENTRY IS A FLAT ROW, ALWAYS. It is never nested and it never anchors
// anything. Until #1465's Phase 4 this file carried two further passes that read
// the WORDS — `resolveEquipmentItem` for a label spelled with the owning item's
// leading word, then an exact match of a bare label against an accessory's stored
// name — and they are gone. What removed them was a measurement rather than an
// argument: the production re-run of 2026-09-19 relinked all 66 recipes, and
// replaying this query over the live manifest gave 385 groups and 62 nested
// accessory rows, every one of them anchored by a head that is itself linked, with
// not one recipe grouping differently once the word passes were simulated away.
// They were load-bearing nowhere.
//
// THE BOUNDARY, because "the words decide nothing now" would be false (CLAUDE.md
// rule 12). The words are gone from GROUPING, which is this file. They are still
// asked elsewhere, for a different question: `resolveKitEntryItem` (the link,
// then `resolveEquipmentItem`) is what `kitIcons.ts` and `KitPicturePicker.svelte`
// read to decide WHICH OF YOUR THINGS a row means and therefore which picture it
// draws. The same 2026-09-19 measurement found two stored lines in production —
// `"frying pan"` in `Paneer Makhanwala…` and in `Potatoes Boulangère`, both
// reaching the Frying Pans family — that resolve by words alone and draw that
// family's picture through it. Neither nests anything, which is why neither moved
// when these passes went; both lose their picture if that fallback is ever
// stripped. `apps/web-pwa/tests/kitIcons.test.ts` pins it.
//
// DERIVED FROM THE MANIFEST, STILL. The link says WHICH THING an entry means; the
// manifest still says what belongs to what, and renaming an item regroups every
// recipe at once with nothing migrated.
//
// PURE (CLAUDE.md rule 1), and in `domain` rather than the page for the reason
// `kitByStep` is: it is derivation, not display.
//
// EVERY ENTRY APPEARS EXACTLY ONCE. An entry is a head or is nested under exactly
// one head, never both and never neither, so head count plus accessory count always
// equals `kit.length`. `groupKitByEquipment.test.ts` pins that as a property over
// every case in the file.
//
// It is no longer a count of LINES. An accessory is said on its appliance's row now
// rather than under it (`RecipeViewPage.svelte`), so the Equipment tab counts groups
// — what this returns the length of — and only a kit with no accessories in it makes
// the two numbers agree.

/** One top-level Equipment row, with the accessory rows that belong under it. */
export interface KitEquipmentGroup {
  /** The top-level entry, exactly as the flow stored it. */
  readonly entry: RecipeKitEntryDoc;
  /**
   * Entries whose link names an accessory of the item `entry` links to, in stored
   * order. Empty for a row that owns nothing named here — which is most rows, and
   * every row whose entry carries no link that still resolves.
   */
  readonly accessories: readonly RecipeKitEntryDoc[];
}

/**
 * Fold a recipe's kit into display order, with accessories under their appliance.
 *
 * @param kit The recipe's `kit` entries, in stored order.
 * @param items The household's equipment manifest items. An empty list (nothing
 *   owned, or the manifest not loaded yet) yields every entry as its own flat
 *   row — the correct reading, and the one a cold load paints.
 * @returns One group per top-level row, in the order the flow listed them.
 */
export function groupKitByEquipment(
  kit: readonly RecipeKitEntryDoc[],
  items: readonly EquipmentItem[],
): KitEquipmentGroup[] {
  // Identify every entry once, up front, from its link alone. Nothing below
  // resolves anything again.
  //
  // Three parallel readings per entry, and every rule beneath is written against
  // these rather than against the link itself:
  //   `resolved`    — the owned item this entry links to, or null;
  //   `namesItem`   — does it link the item ITSELF (so it may head, and anchor,
  //                   that item's row) rather than one of its parts;
  //   `standsAlone` — must it keep its own row whatever else is in the kit. True
  //                   only for a family member, for the reason in the header.
  const resolved: (EquipmentItem | null)[] = [];
  const namesItem: boolean[] = [];
  const standsAlone: boolean[] = [];
  for (const entry of kit) {
    const link = resolveKitEntryEquipment(entry, items);
    resolved.push(link?.item ?? null);
    namesItem.push(link !== null && link.accessory === null);
    standsAlone.push(link !== null && link.accessory !== null && link.item.kind === 'family');
  }

  // itemId → the index of the entry that HEADS that item's row, decided before any
  // row exists so that stored order cannot decide it. Only an entry linking the item
  // itself is eligible; among two that do, the earlier wins, which is the only place
  // position gets a say.
  const headIndexOfItem = new Map<string, number>();
  kit.forEach((_, index) => {
    const item = resolved[index];
    if (!item || headIndexOfItem.has(item.id)) return;
    if (namesItem[index]) headIndexOfItem.set(item.id, index);
  });

  // The nesting rule, stated once: an entry nests when it links a PART of an item
  // another entry names directly. A second naming of the machine itself is a
  // duplicate mention, not a part of the machine, and keeps its own row — as does a
  // family member, which is not a part of anything.
  const nestsUnder: (number | null)[] = kit.map((_, index) => {
    const item = resolved[index];
    if (!item || standsAlone[index] || namesItem[index]) return null;
    return headIndexOfItem.get(item.id) ?? null;
  });

  // The rows themselves, in stored order.
  type Head = {
    index: number;
    entry: RecipeKitEntryDoc;
    accessories: { index: number; entry: RecipeKitEntryDoc }[];
  };
  const heads: Head[] = [];
  const headByIndex = new Map<number, Head>();
  kit.forEach((entry, index) => {
    if (nestsUnder[index] !== null) return; // placed below, once every head exists
    const head: Head = { index, entry, accessories: [] };
    heads.push(head);
    headByIndex.set(index, head);
  });

  // Place the nested entries. The head is always there: it is the entry
  // `headIndexOfItem` picked, which by construction links the item itself and so
  // never nests. The "exactly once" property test is what goes red if that stops
  // holding.
  nestsUnder.forEach((headIndex, index) => {
    if (headIndex === null) return;
    headByIndex.get(headIndex)!.accessories.push({ index, entry: kit[index]! });
  });

  return heads.map((head) => ({
    entry: head.entry,
    // Stored order, not the order they happened to be nested in.
    accessories: [...head.accessories].sort((a, b) => a.index - b.index).map((a) => a.entry),
  }));
}
