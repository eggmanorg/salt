import { derived } from 'svelte/store';
import type { Readable } from 'svelte/store';
import {
  CANON_ICON_HIDDEN,
  isCanonIconRenderable,
  kitchenToolForKitLabel,
  resolveKitEntryItem,
} from '@salt/domain';
import type { EquipmentItem, EquipmentManifest } from '@salt/domain';
import type {
  BorrowedPictureDoc,
  EquipmentIconDoc,
  KitchenToolDoc,
  RecipeKitEquipmentLinkDoc,
} from '@salt/domain/schemas';
import { kitchenTools, toolPicture } from './kitchenToolService.js';
import { equipment, equipmentIcons } from './equipmentService.js';

// The picture beside a piece of kit — on every surface that draws one (issue
// #954).
//
// THE POINT OF PUTTING THIS HERE. A kit label can now name a specific appliance
// this household owns, because #954 hands the inference flow the equipment
// manifest: "Magimix Cook Expert", not "food processor". Those items already have
// pictograms of their own, in `equipmentIcons` (#877/#879), and they are better
// pictures than any generic tool drawing could be — they are the thing in the
// cupboard. So every kit surface asks the vocabularies in ONE FIXED ORDER, and it
// is defined once because the order is the load-bearing part.
//
// THE ORDER, since issue #1465:
//
//   1. WHICH OF YOUR THINGS THIS ROW MEANS, through `resolveKitEntryItem` — the
//      entry's RECORDED LINK where it has one (`equipment: { itemId,
//      accessoryId }`, recorded when the flow had the manifest in front of it,
//      authoritative and no word read), falling back to EQUIPMENT BY NAME
//      (`resolveEquipmentItem`) where it does not. ONE FUNCTION, shared with
//      `KitPicturePicker.svelte`: the picker writes onto whatever this resolves
//      to, so a row this file would render as "one of your things" and a row the
//      picker treats as "ordinary words" can no longer be different rows. A word
//      match never names a specific accessory, so it reads exactly like a
//      bare item-level link. This is what finally reaches a family member
//      ("Tefal non-stick 28cm" carries no word of "Frying Pans" and no rule over
//      the words could find it).
//      Within a resolved link, the ENTRY'S OWN PICTURE comes first and its
//      ITEM'S second (#1465 Phase 2). An accessory or family member can be given
//      a drawing of its own — on request only, never automatically — and where
//      one exists it is the more specific picture of the two: the Lodge skillet
//      rather than the Frying Pans tile. Where none exists the item's stands, as
//      it did before, which is why the ~140 entries that will never be drawn cost
//      nothing.
//
//      A BORROWED PICTURE SITS BEHIND EACH OWN ONE (#1465 Phase 3): entry's own
//      → entry's borrowed → item's own → item's borrowed. A thing you own can be
//      pointed at a drawing that already exists — "this Tefal 28cm looks like the
//      generic frying pan" — without anything being drawn for it, and a borrowed
//      picture is read THROUGH its reference, so redrawing the source updates
//      every thing borrowing it. It sits behind the own picture because a drawing
//      OF the thing beats a drawing of something that looks like it.
//
//      AND "HIDDEN" GATES ONLY THE FALL FROM AN ENTRY TO ITS ITEM, never the
//      fall from an own picture to that SAME thing's own borrowed one. Hiding an
//      accessory's own picture is the user saying "don't answer with the
//      item's" — answering with the parent's would be answering a different
//      question — but a borrow is not a different question, it is this same row
//      pointed at a different drawing, and it can be set AFTER a hide (the
//      picker does exactly that for a row with nothing else). Blocking it too
//      would make that write permanent and silent: the picker's "Picture set"
//      toast would fire and nothing would ever change, recoverable only by
//      deleting the borrow and redrawing. So the order per level is own, then
//      that level's borrowed, then — only if BOTH are absent — hidden decides
//      whether to fall to the next level at all. Read identically for the
//      accessory and the item, which is what makes hiding a record consistent
//      with hiding an entry rather than a second, weaker button with the same
//      label (`hideEquipmentIconFor` in `equipmentService.ts` is the write half:
//      it withdraws that same level's borrow when you hide, so the two acts
//      cannot leave a stale reference for this order to resurrect).
//   2. THE WORD PATH continues to tools for a row `resolveKitEntryItem` answered
//      null — no link, an entry whose link no longer answers to anything, and the
//      hand-typed container names on guided-cook cards which this work never
//      links at all.
//   3. THE CURATED TOOL, THROUGH `kitchenToolForKitLabel` (issue #1460, folded
//      into #1465) — not the bare `resolveKitchenTool`. A label that exactly
//      names one of the manifest's ACCESSORIES is a part of a machine, and an
//      ordinary object that merely shares a word with it is the wrong picture:
//      the Magimix's sealed Thermo Bowl was drawn as a plain mixing bowl and the
//      AMZCHEF's grill plate as a dinner plate. That query's header states the
//      rule and its boundary; this file only decides where it sits in the order.
//
// THE MISS IS STILL A MISS. A label nothing knows returns null and renders as
// words with no picture — never a placeholder, never a near match (#882). Every
// branch folds the tri-state (`null` / a URL / the `"hidden"` sentinel) through
// `isCanonIconRenderable`, so "not drawn yet" and "hidden by the user" read the
// same as "not in the vocabulary".
//
// A RESOLVED ITEM IS AUTHORITATIVE — ITS MISS IS NOT THE TOOL VOCABULARY'S CUE.
// Once a link resolves, or `resolveEquipmentItem` says a label names an owned
// item, that answer stands: a missing drawing on THAT item degrades to no tile,
// never to the tool vocabulary on the same label. Staging has 15 of 20
// `equipmentIcons` at `thumbnail: null` today, including both owned mandolines, so
// falling through would draw "OXO Good Grips Chef's Mandoline Slicer 2.0" as the
// GENERIC mandoline pictogram — the picture of neither mandoline this household
// owns, and precisely the defect #954 opened on. The tool vocabulary is consulted
// only when equipment resolves to NOTHING at all.
//
// A DERIVED STORE OF A LOOKUP rather than plain functions, for the reason
// `ingredientIcons` and `toolIcons` are: a plain function reading snapshots has no
// tracked dependency, so a manifest arriving after first paint — exactly what
// happens on a cold load — would leave every tile bare until something unrelated
// re-rendered the page.

/**
 * What a surface hands the lookup.
 *
 * A KIT ENTRY where the surface has one — the recipe page's Equipment tab, the
 * method rail and the cook deck all hold the stored entry and must pass it, or
 * the link is thrown away at the last step and every defect #1465 fixes comes
 * back. A bare STRING is for the surfaces that genuinely have only words: the
 * guided-cook cards' hand-typed container names, which no recipe kit ever wrote
 * and which this work does not link.
 */
export type KitIconSubject =
  | string
  | null
  | undefined
  | {
      readonly label: string;
      readonly equipment?: RecipeKitEquipmentLinkDoc | null;
    };

/** The kit lookup a surface calls, resolved against one snapshot of every vocabulary. */
export interface KitIconLookup {
  /** The renderable pictogram URL for a kit entry or a free-text label, or null. */
  kitIconFor(subject: KitIconSubject): string | null;
  /** The display-time cache-bust nonce for that same subject, or undefined. */
  kitIconVersionFor(subject: KitIconSubject): string | number | undefined;
}

/** A tri-state-folded, versioned picture: what every branch below returns. */
interface Picture {
  readonly thumbnail: string;
  readonly version: string | number | undefined;
}

function lookupFor(
  toolDocs: readonly KitchenToolDoc[],
  manifest: EquipmentManifest | null,
  icons: Map<string, EquipmentIconDoc>,
): KitIconLookup {
  const items = manifest?.items ?? [];

  // The resolved item's icon, or null — "no icon authored yet" and "hidden" both
  // fold to null here. Unlike a miss on the resolvers, this null does NOT fall
  // through to the tool vocabulary (see the header): a resolved item with nothing
  // drawn renders no tile, not a different object's picture.
  const ownedIcon = (id: string): Picture | null => {
    const icon = icons.get(id);
    const thumbnail = icon?.thumbnail ?? null;
    if (thumbnail === null || !isCanonIconRenderable(thumbnail)) return null;
    // The nonce is load-bearing on a redraw: the Storage path is reused and its
    // bytes are written `immutable`, so without it the browser serves the old
    // picture (ui-spec-v04 §14.4).
    return { thumbnail, version: icon?.iconRequestedAt };
  };

  /**
   * A picture one of your things has been POINTED AT rather than given (#1465
   * Phase 3) — read through the reference, never from a copied URL, so a redraw
   * of the source reaches everything borrowing it on the same subscription.
   *
   * A reference whose target has gone answers null and the search carries on,
   * which is why the schema needs no refine and no cleanup job.
   */
  const borrowedIcon = (borrowed: BorrowedPictureDoc | null | undefined): Picture | null => {
    if (!borrowed) return null;
    if (borrowed.family === 'equipment') return ownedIcon(borrowed.id);
    const tool = toolDocs.find((t) => t.id === borrowed.id);
    return tool ? toolPicture(tool) : null;
  };

  /**
   * The picture for a resolved link: entry's own → entry's borrowed → item's own
   * → item's borrowed.
   *
   * The one place the tri-state is read for more than "is it renderable", and
   * read IDENTICALLY at both scales: own, then that same scale's borrowed, and
   * only once BOTH of those answer null does a HIDDEN own picture stop the
   * search there rather than falling to the item's. A hidden own picture never
   * blocks its OWN borrowed — a borrow is a different picture for the same row,
   * not a different row, and it can be set after a hide (`KitPicturePicker`
   * does exactly that for a row with nothing else showing). Blocking it too
   * would make that write permanent and silent, reachable only by deleting the
   * borrow and redrawing. A `thumbnail: null` own picture — described but never
   * drawn — is not hidden, and always falls through the same way.
   */
  const linkedIcon = (
    item: EquipmentItem,
    accessory: { id: string; borrowedPicture?: BorrowedPictureDoc | null } | null,
  ): Picture | null => {
    if (accessory) {
      const own = ownedIcon(accessory.id);
      if (own) return own;
      const borrowed = borrowedIcon(accessory.borrowedPicture);
      if (borrowed) return borrowed;
      if (icons.get(accessory.id)?.thumbnail === CANON_ICON_HIDDEN) return null;
    }
    const itemOwn = ownedIcon(item.id);
    if (itemOwn) return itemOwn;
    return borrowedIcon(item.borrowedPicture);
  };

  // The whole order, once, returning the picture or null. Both public lookups are
  // this function read twice — never two orderings that could drift apart.
  const pictureFor = (subject: KitIconSubject): Picture | null => {
    const entry = typeof subject === 'string' || !subject ? null : subject;
    const label = (typeof subject === 'string' ? subject : (entry?.label ?? ''))?.trim();
    if (!label) return null;

    // 1. Which of your things this row means — the link, falling back to the
    // words. One function, shared with `KitPicturePicker.svelte`.
    const linked = resolveKitEntryItem(
      entry ? { label, equipment: entry.equipment ?? null } : { label },
      items,
    );
    if (linked) return linkedIcon(linked.item, linked.accessory);

    // 2/3. The curated tool, with the accessory-name rule in front of it.
    const tool = kitchenToolForKitLabel(label, toolDocs, items);
    return tool ? toolPicture(tool) : null;
  };

  return {
    kitIconFor(subject) {
      return pictureFor(subject)?.thumbnail ?? null;
    },
    kitIconVersionFor(subject) {
      return pictureFor(subject)?.version;
    },
  };
}

/**
 * The shared lookup, recomputed whenever any vocabulary changes. Subscribe to it
 * (`$kitIcons.kitIconFor(entry)`) so a tile fills in the moment the manifest or
 * the tool list lands.
 */
export const kitIcons: Readable<KitIconLookup> = derived(
  [kitchenTools, equipment, equipmentIcons],
  ([$kitchenTools, $equipment, $equipmentIcons]) =>
    lookupFor($kitchenTools, $equipment, $equipmentIcons),
);
