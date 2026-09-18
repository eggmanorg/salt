import { derived } from 'svelte/store';
import type { Readable } from 'svelte/store';
import {
  isCanonIconRenderable,
  kitchenToolForKitLabel,
  resolveEquipmentItem,
  resolveKitEntryEquipment,
} from '@salt/domain';
import type { EquipmentItem, EquipmentManifest } from '@salt/domain';
import type {
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
//   1. THE ENTRY'S RECORDED LINK. A kit entry may carry `equipment: { itemId,
//      accessoryId }` — which of your things the flow meant, recorded when it had
//      the manifest in front of it. Where that resolves it is authoritative and
//      no word is read: the linked item's picture, and nothing else. This is what
//      finally reaches a family member ("Tefal non-stick 28cm" carries no word of
//      "Frying Pans" and no rule over the words could find it).
//      An entry's OWN picture goes in front of its item's here in Phase 2 of
//      #1465; today a linked entry shows its item's, which is the behaviour the
//      Intended Experience calls for until then.
//   2. THE WORD PATH, for an entry with no link, one whose link no longer answers
//      to anything, and for the hand-typed container names on guided-cook cards
//      which this work never links at all. Equipment first, then tools — steps 3
//      and 4 below.
//   3. EQUIPMENT BY NAME (`resolveEquipmentItem`), before tools, ALWAYS.
//      `resolveKitchenTool` matches on token-aligned containment, so "Magimix
//      Cocotte Slow Cook Pot" contains "pot" and would resolve to a generic
//      saucepan drawing — a specific label losing its own picture to a vague one,
//      which is the whole defect #954 fixed. Asking equipment first is what
//      prevents it; making the tool resolver stricter is explicitly not (its
//      `'Magmix bowl' → mixing-bowl` behaviour is correct and tested).
//   4. THE CURATED TOOL, THROUGH `kitchenToolForKitLabel` (issue #1460, folded
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
  const ownedIcon = (item: EquipmentItem): Picture | null => {
    const icon = icons.get(item.id);
    const thumbnail = icon?.thumbnail ?? null;
    if (thumbnail === null || !isCanonIconRenderable(thumbnail)) return null;
    // The nonce is load-bearing on a redraw: the Storage path is reused and its
    // bytes are written `immutable`, so without it the browser serves the old
    // picture (ui-spec-v04 §14.4).
    return { thumbnail, version: icon?.iconRequestedAt };
  };

  // The whole order, once, returning the picture or null. Both public lookups are
  // this function read twice — never two orderings that could drift apart.
  const pictureFor = (subject: KitIconSubject): Picture | null => {
    const entry = typeof subject === 'string' || !subject ? null : subject;
    const label = (typeof subject === 'string' ? subject : (entry?.label ?? ''))?.trim();

    // 1. The recorded link. Authoritative where it resolves.
    if (entry) {
      const linked = resolveKitEntryEquipment(entry, items);
      if (linked) return ownedIcon(linked.item);
    }

    if (!label) return null;

    // 2/3. Equipment by name.
    const item = resolveEquipmentItem(label, items);
    if (item) return ownedIcon(item);

    // 4. The curated tool, with the accessory-name rule in front of it.
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
