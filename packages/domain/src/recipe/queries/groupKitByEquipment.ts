import { normaliseName } from '../../canon/index.js';
import {
  namesItemItself,
  resolveEquipmentItem,
  resolveKitEntryEquipment,
} from '../../equipment/index.js';
import type { EquipmentItem } from '../../equipment/index.js';
import type { RecipeKitEntryDoc } from '../../schemas/index.js';

// Which pieces of a recipe's kit belong UNDER another one (issue #1140).
//
// The Equipment tab lists what to get out of the cupboards. Flat, it treats
// "Cosori 5L Rice Cooker" and "Rice Spoon" as two unrelated things, when the rice
// spoon is the rice cooker's — it came in the box. This is the derivation that
// puts the spoon under the cooker.
//
// ── THE LINK COMES FIRST (issue #1465) ───────────────────────────────────────
//
// A kit entry may now carry `equipment: { itemId, accessoryId }` — recorded by
// the flow that wrote the label, which had the manifest in front of it. Where it
// resolves, it is the answer, and none of the word passes below is consulted for
// that entry. Three things follow, and they are the whole of the new behaviour:
//
//   - an entry linked to an item ITSELF heads that item's row, exactly as a label
//     naming the item directly does;
//   - an entry linked to an ACCESSORY of an `equipment`-kind item nests under that
//     item's row when this kit also names the item, and otherwise stands as its
//     own row — the same shape pass one already gives a prefixed accessory label;
//   - an entry linked to a member of a `family` ALWAYS stands as its own row, and
//     never anchors another entry beneath it. A family is not an appliance with
//     parts: "frying pan" beside the All-Clad read "frying pan — with the All-Clad
//     D3 10 inch frying pan", as if one pan were an attachment of the other, and
//     that is the false statement this rule exists to refuse. `kind` is picking
//     PRESENTATION here and nothing else (`equipmentManifest.ts` — it may never
//     gate whether an entry resolves, has a picture, or exists).
//
// An entry with no link, or whose link no longer answers to anything, takes the
// two word passes below unchanged. Phase 4 of #1465 deletes those passes once
// every recipe in production has been re-run; until then both paths are live and
// a recipe not yet redone looks exactly as it did.
//
// DERIVED FROM THE MANIFEST, STILL. The link says WHICH THING an entry means; the
// manifest still says what belongs to what, and renaming an item regroups every
// recipe at once with nothing migrated.
//
// PURE (CLAUDE.md rule 1), and in `domain` rather than the page for the reason
// `kitByStep` is: it is derivation, not display.
//
// ── THE WORD PASSES, FOR UNLINKED ENTRIES ────────────────────────────────────
//
// TWO PASSES, AND THE SECOND IS DELIBERATELY NARROWER THAN THE FIRST.
//
// Pass one is `resolveEquipmentItem`, unchanged and un-loosened. Its two-part rule
// (the item's leading word, plus every other word explained by the item's own name
// or by ONE of its accessories) is what stops the bare word "pot" claiming the
// Magimix's Cocotte, and that refusal is load-bearing — see that file's header.
//
// That second half of the rule is why pass one cannot simply make every entry a
// head (issue #1182). `Magimix Cook Expert` and `Magimix Cocotte Slow Cook Pot`
// BOTH resolve — correctly, to the same item — so making both heads drew the same
// machine twice, side by side, wearing one picture: the exact "two unrelated
// things" reading this whole derivation exists to remove. So pass one nests as
// well, under one rule:
//
//   an entry whose label is spelled out of one of the item's ACCESSORIES nests
//   under the entry that names the item ITSELF.
//
// WHICH ENTRY HEADS IS NOT DECIDED BY STORED ORDER. `namesItemItself` is the
// whole test; position only breaks a tie between two entries that both name the
// item directly. That test is the RESOLVER'S OWN, exported from
// `resolveEquipmentItem.ts` and asked here of a pair it has already matched — not
// a second reading of the words. It was a copy of the resolver's membership rule
// until #1196, coupled only by both sides folding through `normaliseName`; the
// membership half itself could have been loosened on one side alone, so a label
// the resolver counted as an accessory spelling could have started heading its own
// row. One function now answers for both, and there is nothing left to drift.
//
// The alternative — first mention heads — was written and reverted during #1179's
// review, because with the pot listed first ("roughly the order it is needed in"
// produces that) the POT became the head and the machine rendered indented and
// muted beneath it, asserting that the appliance is a part of its own accessory. A missing relationship is bad; a false one is worse. This
// is pass two's stated principle — stored order decides where the heads go, never
// what belongs to what — finally applied to pass one as well.
//
// THE BOUNDARY, because the absolute would be false (CLAUDE.md rule 12): one item
// can still head two rows, in the two cases where nesting would have to state
// something untrue. A kit naming the same appliance twice IN ITS OWN WORDS
// ("Cosori 5L Rice Cooker" and "Cosori Rice Cooker") keeps both rows — a machine
// is not an accessory of itself. And two accessory-form labels with no entry
// naming the appliance ("Magimix Cocotte Slow Cook Pot" beside "Magimix Blender
// Jug", no Magimix) keep both rows too, because nesting either under the other
// would claim one accessory owns the other, and no appliance is ever invented as
// a heading. Both are pinned in `groupKitByEquipment.test.ts`.
//
// Pass two exists because the real library names accessories with no maker at all:
// staging carries `Rice Spoon`, `Hand Blender Attachment`, `Oven Sheet Pan` and
// `Wire Oven Rack` as kit labels in their own right, which pass one refuses by
// design. It runs only on entries pass one left unresolved, and nests one only when
// all three hold together:
//
//   1. the entry resolved to no owned item in pass one;
//   2. its normalised label EXACTLY equals an accessory's normalised name — never
//      containment, never a prefix. "Sheet Pan" does not find "Oven Sheet Pan";
//   3. the accessory's owning item ALREADY HEADS A ROW in this same recipe's kit.
//
// Condition 3 is the guard that makes conditions 1-2 safe to have at all. The
// manifest genuinely lists "Spatula", "Measuring Cup", "Kitchen Scales" and "Meat
// thermometer" as accessories of specific appliances; without it, a recipe saying
// "spatula" would file itself under a blender nobody mentioned. It is also why no
// appliance is ever INVENTED as a heading: every head is an entry the flow wrote,
// and the heads appear in the order it wrote them.
//
// AMBIGUITY IS A MISS HERE TOO, mirroring `resolveEquipmentItem`. If two DIFFERENT
// items that both head rows in this kit own an accessory of that name, the entry
// stays top-level rather than picking one. (Two accessories of the SAME item tying
// is not ambiguity — the answer is that item either way.)
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
   * Entries whose label names an accessory of the item `entry` resolved to, in
   * stored order — whether spelled bare ("Rice Spoon", pass two) or with the
   * owner's leading word ("Magimix Cocotte Slow Cook Pot", pass one). Empty for a
   * row that owns nothing named here — which is most rows, and every row whose
   * entry resolved to no owned item at all.
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
  // Identify every entry once, up front, link first and words only as the
  // fallback. Nothing below resolves anything again.
  //
  // Three parallel readings per entry, and every rule beneath is written against
  // these rather than against a link or a label, so the two paths cannot disagree
  // about what an entry IS:
  //   `resolved`    — the owned item this entry means, or null;
  //   `namesItem`   — does it name that item ITSELF (so it may head, and anchor,
  //                   that item's row) rather than one of its parts;
  //   `standsAlone` — must it keep its own row whatever else is in the kit. True
  //                   only for a family member, for the reason in the header.
  const resolved: (EquipmentItem | null)[] = [];
  const namesItem: boolean[] = [];
  const standsAlone: boolean[] = [];
  for (const entry of kit) {
    const link = resolveKitEntryEquipment(entry, items);
    if (link) {
      resolved.push(link.item);
      namesItem.push(link.accessory === null);
      standsAlone.push(link.accessory !== null && link.item.kind === 'family');
      continue;
    }
    const item = resolveEquipmentItem(entry.label, items);
    resolved.push(item);
    namesItem.push(item ? namesItemItself(entry.label, item) : false);
    standsAlone.push(false);
  }

  // itemId → the index of the entry that HEADS that item's row, decided before any
  // row exists so that stored order cannot decide it. Only an entry naming the item
  // itself is eligible; among two that do, the earlier wins, which is the only place
  // position gets a say.
  const headIndexOfItem = new Map<string, number>();
  kit.forEach((_, index) => {
    const item = resolved[index];
    if (!item || headIndexOfItem.has(item.id)) return;
    if (namesItem[index]) headIndexOfItem.set(item.id, index);
  });

  // Pass one's whole new rule, stated once: an entry nests when it resolves to an
  // item ANOTHER entry names directly, and is not itself such a naming. A second
  // naming of the machine itself is a duplicate mention, not a part of the machine,
  // and keeps its own row — as does a family member, which is not a part of
  // anything.
  const nestsUnderItem: (string | null)[] = kit.map((_, index) => {
    const item = resolved[index];
    if (!item || standsAlone[index]) return null;
    const headIndex = headIndexOfItem.get(item.id);
    if (headIndex === undefined || headIndex === index) return null;
    return namesItem[index] ? null : item.id;
  });

  // The rows themselves, in stored order. `headOfItem` then lets pass two ask "is
  // this accessory's appliance already here, HEADED BY AN ENTRY NAMING IT?" without
  // resolving anything twice — an accessory-form top-level row is deliberately never
  // registered here, so it can never anchor another accessory beneath it.
  type Head = {
    index: number;
    entry: RecipeKitEntryDoc;
    accessories: { index: number; entry: RecipeKitEntryDoc }[];
  };
  const heads: Head[] = [];
  const headOfItem = new Map<string, Head>();
  const unresolved: { index: number; entry: RecipeKitEntryDoc }[] = [];

  kit.forEach((entry, index) => {
    if (nestsUnderItem[index]) return; // placed below, once every head exists
    const head: Head = { index, entry, accessories: [] };
    heads.push(head);
    const item = resolved[index];
    if (item) {
      // Only a row that names the item ITSELF is a legitimate nesting target for
      // pass two. An accessory-form top-level row (this kit never names the
      // appliance directly, so pass one left it heading its own row rather than
      // nesting it) must never anchor another accessory beneath it — that would
      // claim one accessory owns another, the exact false relationship pass one's
      // own boundary above refuses to state.
      if (!headOfItem.has(item.id) && namesItem[index]) {
        headOfItem.set(item.id, head);
      }
    } else {
      unresolved.push({ index, entry });
    }
  });

  // Place pass one's nested entries. The head is always there: it is the entry
  // `headIndexOfItem` picked, which by construction never nests and resolves to
  // this item ahead of any other head that could have claimed the slot. The
  // "exactly once" property test is what would go red if that stopped holding.
  nestsUnderItem.forEach((itemId, index) => {
    if (!itemId) return;
    headOfItem.get(itemId)!.accessories.push({ index, entry: kit[index]! });
  });

  // Pass two, over the unresolved entries only, in stored order.
  const nested = new Set<number>();
  for (const { index, entry } of unresolved) {
    const target = normaliseName(entry.label);
    if (!target) continue;

    // Only items that already head a row are candidates — condition 3.
    let owner: Head | null = null;
    let ambiguous = false;
    for (const item of items) {
      const head = headOfItem.get(item.id);
      if (!head) continue;
      const owns = (item.accessories ?? []).some(
        (accessory) => normaliseName(accessory.name) === target,
      );
      if (!owns) continue;
      // A second DISTINCT owning item is a tie; the same head twice is not.
      if (owner && owner !== head) {
        ambiguous = true;
        break;
      }
      owner = head;
    }
    if (ambiguous || !owner) continue;

    owner.accessories.push({ index, entry });
    nested.add(index);
  }

  return heads
    .filter((head) => !nested.has(head.index))
    .map((head) => ({
      entry: head.entry,
      // Stored order, not the order the two passes happened to nest them in.
      accessories: [...head.accessories].sort((a, b) => a.index - b.index).map((a) => a.entry),
    }));
}
