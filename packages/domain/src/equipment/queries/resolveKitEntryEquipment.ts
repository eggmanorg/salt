import type { Accessory, EquipmentItem } from '../entities/EquipmentItem.js';
import type { RecipeKitEquipmentLinkDoc } from '../../schemas/recipe.js';
import { resolveEquipmentItem } from './resolveEquipmentItem.js';

// Which of the household's things does this kit entry's LINK name? (Issue #1465.)
//
// The twin of `resolveEquipmentItem`, and the reason that one is no longer the
// only answer. `resolveEquipmentItem` reads WORDS and guesses; this reads an id
// the kit flow recorded when it had the manifest in front of it. Where a link
// exists this is authoritative and the words are not consulted at all — which is
// what lets "Tefal non-stick 28cm" be recognised as one of the Frying Pans, a
// thing no rule over the words could ever manage.
//
// PURE (CLAUDE.md rule 1), and a table lookup with no matching in it.
//
// A DANGLING LINK RESOLVES TO NOTHING, AND THAT IS THE WHOLE DEGRADATION STORY.
// Delete an item from the manifest, or delete one of its entries, and every
// recipe pointing at it falls back to exactly today's behaviour for an unlinked
// label — the word resolvers, then the tool vocabulary, then bare words. Nothing
// is written back to any recipe when the manifest changes; there is no refine and
// no cleanup job.
//
// AN ACCESSORY ID THAT NO LONGER EXISTS IS A MISS, NOT A DEMOTION TO ITS ITEM.
// The alternative — return the item with `accessory: null` — would have the row
// claim to BE the appliance, which is a false statement rather than a missing
// one, and false is worse (`groupKitByEquipment`'s header makes the same call
// about nesting). So a link naming an entry that has been deleted answers null
// and the label is read as words again.

/** What a resolved link points at: an item, and one of its entries when named. */
export interface ResolvedKitEquipment {
  readonly item: EquipmentItem;
  /** The named accessory or family member, or null when the link names the item itself. */
  readonly accessory: Accessory | null;
}

/** The shape this query reads off a kit entry — a full `RecipeKitEntryDoc` satisfies it. */
export interface KitEquipmentLinkSource {
  readonly equipment?: RecipeKitEquipmentLinkDoc | null;
}

/**
 * Resolve a kit entry's stored link against the household's manifest.
 *
 * @param entry The kit entry, or anything carrying its `equipment` link.
 * @param items The manifest's items. Empty (nothing owned, or the manifest not
 *   loaded yet) resolves nothing, which is the correct reading and the one a cold
 *   load paints.
 * @returns The item and, when the link named one, its accessory — or null when
 *   there is no link, or the link no longer answers to anything.
 */
export function resolveKitEntryEquipment(
  entry: KitEquipmentLinkSource,
  items: readonly EquipmentItem[],
): ResolvedKitEquipment | null {
  const link = entry.equipment;
  if (!link) return null;
  const item = items.find((candidate) => candidate.id === link.itemId);
  if (!item) return null;
  if (link.accessoryId === null) return { item, accessory: null };
  // `?? []` stays, exactly as `resolveEquipmentItem` carries it. The schema
  // defaults `accessories`, so a PARSED item always has the array — but this
  // query is pure and takes whatever a caller hands it, and a partial item
  // (a page fixture, a projection) must degrade to "names nothing" rather than
  // throw inside a render. Pinned by a test.
  const accessory = (item.accessories ?? []).find((a) => a.id === link.accessoryId);
  if (!accessory) return null;
  return { item, accessory };
}

/** The shape this query reads off a kit entry — a full `RecipeKitEntryDoc` satisfies it. */
export interface KitEntryEquipmentSource extends KitEquipmentLinkSource {
  readonly label: string;
}

/**
 * Which of the household's things does this kit entry mean — the recorded link
 * where it has one, the words where it does not? (Issue #1465, reviewed.)
 *
 * THE ONE PLACE "WHICH OF YOUR THINGS IS THIS ROW" IS ANSWERED. `kitIcons.ts`
 * asks this to decide what to render; `KitPicturePicker.svelte` must ask the
 * SAME question to decide what to write, or the two disagree about a row that
 * resolves by words alone. A picker that branched on the link alone answered
 * "is there a link?" where the row was offered on "is there a picture?", so a
 * row naming one of your things by words took the ordinary-words act: a matcher
 * the renderer never reaches, and "draw new" minting an appliance-named
 * `kitchenTools` document — the exact instance-named row #956 exists to
 * prevent.
 *
 * `resolveKitEntryEquipment` (the link) first, `resolveEquipmentItem` (the
 * words) as the fallback — never the other way, and never a second caller
 * re-deciding the order. A word match never names a specific accessory, so
 * `accessory` is null on that branch, the same reading a bare item-level link
 * gets.
 *
 * THE WORD FALLBACK IS NOT VESTIGIAL, AND ITS SIZE IS MEASURED. #1465's Phase 4
 * re-ran every production recipe, so almost every line now carries a link — but
 * of 451 stored kit lines on 2026-09-19, two still reach an owned record by
 * words alone: `"frying pan"` in `Paneer Makhanwala…` and in `Potatoes
 * Boulangère`, both landing on the Frying Pans family and drawing its picture
 * through this function. Remove this branch and those two rows go blank. It
 * also still answers for anything written before a future manifest rename, and
 * for a recipe whose kit has never been inferred. Pinned by
 * `apps/web-pwa/tests/kitIcons.test.ts` and by this file's own suite.
 */
export function resolveKitEntryItem(
  entry: KitEntryEquipmentSource,
  items: readonly EquipmentItem[],
): ResolvedKitEquipment | null {
  const linked = resolveKitEntryEquipment(entry, items);
  if (linked) return linked;
  const item = resolveEquipmentItem(entry.label, items);
  return item ? { item, accessory: null } : null;
}
