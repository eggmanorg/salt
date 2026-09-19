import { normaliseName } from '../../canon/index.js';
import type { EquipmentItem } from '../../equipment/index.js';
import type { KitchenToolDoc } from '../../schemas/kitchenTool.js';
import { resolveKitchenToolMatch } from './resolveKitchenTool.js';

// Which curated tool may a KIT LABEL borrow a picture from? (Issue #1460, folded
// into #1465.)
//
// `resolveKitchenTool` answers "which tool do these words name?" and is right
// about it. This adds the one thing that question cannot see: whether the words
// are the name of a PART OF A MACHINE this household owns, in which case an
// ordinary object that happens to share a word with it is the wrong picture.
//
// THE DEFECT. The kit flow is licensed to name an accessory on its own ("Thermo
// Bowl", "Grill plate", "Cocotte Slow Cook Pot"), and `resolveEquipmentItem`
// refuses a bare accessory name by design — its leading-word rule is what stops
// the word "spatula" claiming a Sage blender, and it stays exactly as it is. So
// those labels fell through to the tool vocabulary, which matches on token-aligned
// containment: the Magimix's sealed Thermo Bowl was drawn as a plain mixing bowl
// and the AMZCHEF's grill plate as a DINNER PLATE. The words beside the picture
// were always right; the picture was of something else.
//
// THE RULE, stated once. A label that exactly names one of the manifest's
// accessories keeps a curated tool's picture only when the vocabulary explains
// the NAME rather than a word inside it:
//
//   1. the winning phrase covers the label's LAST token — the head noun. A tool
//      won on "whisk" out of "Whisk Disc", or "knife" out of "Knife Blade", has
//      matched a modifier and named nothing; and
//   2. the winning phrase is the whole label, or is more than one word. A bare
//      single word ("bowl", "pot", "pan", "plate", "sieve") is exactly the match
//      that turns a machine part into an unrelated object.
//
// Otherwise: NO PICTURE. That is the sanctioned graceful miss (#882,
// docs/canon-icons.md), not a failure — and since #1465 the parts that matter
// mostly do not reach here at all, because a kit entry that names one of your
// things now carries a LINK and resolves through it.
//
// WHY IT IS GATED ON THE MANIFEST AND NOT ON THE WORDS ALONE. "Grill plate" and
// "Egg Whisk" are the same shape — two words, the vocabulary winning on the
// second — and want opposite answers. Nothing in the words separates them, so the
// gate is the manifest: only a label that IS one of your accessory names is asked
// this question at all. Every other label — "large mixing bowl", "small saucepan",
// "sharp knife" — resolves exactly as it did, through `resolveKitchenTool`
// untouched.
//
// AND WHY A VOCABULARY ENTRY IS THE LEVER FOR THE REST. Rule 2 above is what
// "Egg Whisk" fails, and the fix is one curated phrase — `egg whisk` on the Whisk
// row — because "an egg whisk is an ordinary whisk" is a curation decision, not a
// derivation. That is the same act #1465 Phase 3 puts one tap away on the recipe
// page; see `apps/cloud-functions/scripts/kitchen-tool-vocabulary.mjs`.
//
// THE CLAIM AND ITS BOUNDARY (CLAUDE.md rule 12). This makes no promise that a
// machine part is never drawn as something else in general — it cannot, because a
// hand-typed name that is not spelled exactly like an accessory ("the thermo
// bowl", "grill plates") is not recognised as one and takes the ordinary path. The
// property it does guarantee, and that `kitchenToolForKitLabel.test.ts` pins, is
// narrower and checkable: for a label that exactly matches an accessory's name,
// a tool is returned only when both conditions above hold.

/**
 * Is this label, exactly, the name of an accessory on the manifest?
 *
 * Exact on the NORMALISED name — never containment and never a prefix, so "Sheet
 * Pan" does not find "Oven Sheet Pan". `groupKitByEquipment` read the words the
 * same way until #1465's Phase 4 deleted its word passes; this is now the only
 * place a kit label is measured against an accessory's stored name, and the
 * exactness is its own guard rather than a mirror of anything. Both sides fold
 * through canon's `normaliseName`, the same
 * fold every resolver here uses, so case, punctuation, hyphens, plurals and model
 * numbers cannot split a match.
 */
export function namesManifestAccessory(label: string, items: readonly EquipmentItem[]): boolean {
  const target = normaliseName(label);
  // A name that normalises away entirely — "500g", "2" — names no accessory and
  // never could, the same guard `unresolvedKitLabels` states for the same reason.
  if (!target) return false;
  // `?? []` stays, exactly as `resolveEquipmentItem` carries it: this query is
  // pure and takes whatever a caller hands it, and a partial item must degrade to
  // "names nothing" rather than throw inside a render. Pinned by a test.
  return items.some((item) =>
    (item.accessories ?? []).some((accessory) => normaliseName(accessory.name) === target),
  );
}

/**
 * The curated tool a kit label may draw, with the accessory-name rule applied.
 *
 * @param label The words on the kit line, or on a guided-cook card.
 * @param tools The curated vocabulary.
 * @param items The household's manifest items. Empty (not loaded, nothing owned)
 *   means no label can be an accessory name, so every answer is
 *   `resolveKitchenTool`'s — which is the correct cold-load reading.
 * @returns The tool to draw, or null for the graceful miss.
 */
export function kitchenToolForKitLabel(
  label: string,
  tools: readonly KitchenToolDoc[],
  items: readonly EquipmentItem[],
): KitchenToolDoc | null {
  const match = resolveKitchenToolMatch(label, tools);
  if (!match) return null;
  if (!namesManifestAccessory(label, items)) return match.tool;

  const labelTokens = match.target.split(' ').filter(Boolean);
  const phraseTokens = match.phrase.split(' ').filter(Boolean);
  const last = labelTokens[labelTokens.length - 1];
  // Condition 1: the head noun is inside what the vocabulary matched.
  if (!last || !phraseTokens.includes(last)) return null;
  // Condition 2: the whole name, or more than one word of it.
  if (match.phrase === match.target || phraseTokens.length > 1) return match.tool;
  return null;
}
